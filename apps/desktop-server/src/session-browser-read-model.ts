import type { SessionBrowserItemRpc, SessionBrowserPageRpc } from "@vermillion/shared";

export type SessionBrowserReadModelSeed = SessionBrowserItemRpc & {
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
const compareItems = (
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

/** Flat, per-workspace, paged view of visible sessions. Forks and subagents are ordinary rows. */
export class SessionBrowserReadModel {
  private readonly byWorkspaceId = new Map<string, SessionBrowserReadModelSeed[]>();
  private readonly revisions = new Map<string, string>();

  public constructor(seeds: readonly SessionBrowserReadModelSeed[]) {
    for (const seed of seeds) {
      const collection = this.byWorkspaceId.get(seed.workspaceId) ?? [];
      collection.push(seed);
      this.byWorkspaceId.set(seed.workspaceId, collection);
    }
    for (const [workspaceId, collection] of this.byWorkspaceId) {
      collection.sort(compareItems);
      const fingerprint = [...collection]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map((seed) => [
          seed.sessionId,
          seed.title,
          seed.engineId,
          seed.statusDot,
          seed.isActive,
          seed.isPinned,
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
    const collection = this.byWorkspaceId.get(input.workspaceId) ?? [];
    const items = collection.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < collection.length;
    return {
      workspaceId: input.workspaceId,
      revision,
      items: items.map(toItem),
      nextCursor: hasMore ? encodeCursor({ revision, offset: nextOffset }) : undefined,
      hasMore,
      totalCount: collection.length
    };
  }

  public get(sessionId: string): SessionBrowserItemRpc | undefined {
    for (const collection of this.byWorkspaceId.values()) {
      const seed = collection.find((item) => item.sessionId === sessionId);
      if (seed) {
        return toItem(seed);
      }
    }
    return undefined;
  }

  private revisionFor(workspaceId: string): string {
    return this.revisions.get(workspaceId) ?? createRevision(workspaceId);
  }
}

const toItem = (seed: SessionBrowserReadModelSeed): SessionBrowserItemRpc => ({
  sessionId: seed.sessionId,
  engineId: seed.engineId,
  title: seed.title,
  statusDot: seed.statusDot,
  isActive: seed.isActive,
  isPinned: seed.isPinned,
  activityAt: seed.activityAt,
  lastCompletedTurnAt: seed.lastCompletedTurnAt
});
