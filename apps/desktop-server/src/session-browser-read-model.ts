import type { SessionBrowserItemRpc, SessionBrowserPageRpc } from "@vermillion/shared";

export type SessionBrowserReadModelSeed = Omit<SessionBrowserItemRpc, "subagents"> & {
  workspaceId: string;
  sortAt: string;
};

type CursorPayload = {
  revision: string;
  offset: number;
};

export class SessionBrowserCursorStaleError extends Error {
  public readonly code = "CURSOR_STALE";

  public constructor() {
    super("The session browser cursor belongs to an outdated workspace revision.");
    this.name = "SessionBrowserCursorStaleError";
  }
}

/** Pinned first, then most recently completed turn first. */
const compareSeeds = (
  left: SessionBrowserReadModelSeed,
  right: SessionBrowserReadModelSeed
): number => {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1;
  }
  const bySortAt = right.sortAt.localeCompare(left.sortAt);
  return bySortAt !== 0 ? bySortAt : left.sessionId.localeCompare(right.sessionId);
};

const encodeCursor = (payload: CursorPayload): string =>
  encodeURIComponent(JSON.stringify(payload));

const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor)) as Partial<CursorPayload>;
    if (
      typeof parsed.revision !== "string" ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as CursorPayload;
  } catch {
    throw new SessionBrowserCursorStaleError();
  }
};

const createRevision = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

/**
 * Per-workspace paged view of visible sessions. Forks are ordinary rows; a subagent session is nested
 * under the session that spawned it (`parentSessionId`) and never appears as a root.
 */
export class SessionBrowserReadModel {
  private readonly rootsByWorkspaceId = new Map<string, SessionBrowserItemRpc[]>();
  private readonly itemsBySessionId = new Map<string, SessionBrowserItemRpc>();
  private readonly revisions = new Map<string, string>();

  public constructor(seeds: readonly SessionBrowserReadModelSeed[]) {
    const seedsBySessionId = new Map(seeds.map((seed) => [seed.sessionId, seed] as const));
    const childrenByParentId = new Map<string, SessionBrowserReadModelSeed[]>();
    const roots: SessionBrowserReadModelSeed[] = [];
    for (const seed of seeds) {
      const parent = seed.parentSessionId ? seedsBySessionId.get(seed.parentSessionId) : undefined;
      if (parent && parent.workspaceId === seed.workspaceId) {
        const siblings = childrenByParentId.get(parent.sessionId) ?? [];
        siblings.push(seed);
        childrenByParentId.set(parent.sessionId, siblings);
      } else {
        roots.push(seed);
      }
    }

    const build = (seed: SessionBrowserReadModelSeed, parentSessionId?: string): SessionBrowserItemRpc => {
      const { workspaceId: _workspaceId, sortAt: _sortAt, ...rest } = seed;
      const item: SessionBrowserItemRpc = {
        ...rest,
        parentSessionId,
        subagents: (childrenByParentId.get(seed.sessionId) ?? [])
          .sort(compareSeeds)
          .map((child) => build(child, seed.sessionId))
      };
      this.itemsBySessionId.set(seed.sessionId, item);
      return item;
    };

    for (const workspaceId of new Set(seeds.map((seed) => seed.workspaceId))) {
      const workspaceRoots = roots
        .filter((seed) => seed.workspaceId === workspaceId)
        .sort(compareSeeds)
        .map((seed) => build(seed));
      this.rootsByWorkspaceId.set(workspaceId, workspaceRoots);
      const fingerprint = seeds
        .filter((seed) => seed.workspaceId === workspaceId)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map((seed) => [
          seed.sessionId,
          seed.parentSessionId,
          seed.title,
          seed.engineId,
          seed.statusDot,
          seed.isActive,
          seed.isPinned,
          seed.role,
          seed.activityAt,
          seed.lastCompletedTurnAt,
          seed.sortAt
        ]);
      this.revisions.set(workspaceId, createRevision(JSON.stringify(fingerprint)));
    }
  }

  public list(input: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
    kind?: "user" | "agent";
  }): SessionBrowserPageRpc {
    const revision = this.revisionFor(input.workspaceId);
    if (input.expectedRevision && input.expectedRevision !== revision) {
      throw new SessionBrowserCursorStaleError();
    }
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    if (cursor && cursor.revision !== revision) {
      throw new SessionBrowserCursorStaleError();
    }
    const offset = cursor?.offset ?? 0;
    const all = this.rootsByWorkspaceId.get(input.workspaceId) ?? [];
    const roots = input.kind ? all.filter((item) => (item.role === undefined) === (input.kind === "user")) : all;
    const items = roots.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < roots.length;
    return {
      workspaceId: input.workspaceId,
      revision,
      items,
      nextCursor: hasMore ? encodeCursor({ revision, offset: nextOffset }) : undefined,
      hasMore,
      totalCount: roots.length
    };
  }

  public get(sessionId: string): SessionBrowserItemRpc | undefined {
    return this.itemsBySessionId.get(sessionId);
  }

  private revisionFor(workspaceId: string): string {
    return this.revisions.get(workspaceId) ?? createRevision(workspaceId);
  }
}
