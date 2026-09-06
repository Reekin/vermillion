import type { SessionBrowserItemRpc, SessionBrowserPageRpc } from "@vermillion/shared";

export type SessionBrowserReadModelSeed = Omit<SessionBrowserItemRpc, "subagents"> & {
  workspaceId: string;
  sortAt: string;
  forkParentSessionId?: string;
  archivedAt?: string;
  isVisible?: boolean;
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

const latest = (values: Array<string | undefined>): string | undefined =>
  values.reduce<string | undefined>((result, value) => value && (!result || value > result) ? value : result, undefined);

const collectForkTrees = (seeds: readonly SessionBrowserReadModelSeed[]): SessionBrowserReadModelSeed[] => {
  const bySessionId = new Map(seeds.map((seed) => [seed.sessionId, seed]));
  const rootById = new Map<string, SessionBrowserReadModelSeed>();
  const rootOf = (seed: SessionBrowserReadModelSeed): SessionBrowserReadModelSeed => {
    const cached = rootById.get(seed.sessionId);
    if (cached) return cached;
    const parent = seed.forkParentSessionId ? bySessionId.get(seed.forkParentSessionId) : undefined;
    const root = parent && parent.workspaceId === seed.workspaceId ? rootOf(parent) : seed;
    rootById.set(seed.sessionId, root);
    return root;
  };
  const membersByRoot = new Map<SessionBrowserReadModelSeed, SessionBrowserReadModelSeed[]>();
  for (const seed of seeds) {
    const root = rootOf(seed);
    const members = membersByRoot.get(root) ?? [];
    members.push(seed);
    membersByRoot.set(root, members);
  }
  return [...membersByRoot].map(([root, members]) => {
    const visibleMembers = members.filter((member) => member.isVisible !== false && !member.archivedAt);
    const isActive = visibleMembers.some((member) => member.isActive);
    const lastCompletedTurnAt = latest(visibleMembers.map((member) => member.lastCompletedTurnAt));
    const activityAt = lastCompletedTurnAt ?? latest(visibleMembers.map((member) => member.activityAt ?? member.sortAt));
    const parent = root.parentSessionId ? bySessionId.get(root.parentSessionId) : undefined;
    return {
      ...root,
      memberSessionIds: [root.sessionId, ...members.filter((member) => member !== root).map((member) => member.sessionId).sort()],
      parentSessionId: parent ? rootOf(parent).sessionId : root.parentSessionId,
      isVisible: visibleMembers.length > 0,
      isActive,
      statusDot: visibleMembers.some((member) => member.statusDot === "running")
        ? "running"
        : isActive
          ? "none"
          : visibleMembers.some((member) => member.statusDot === "unread_completed") ? "unread_completed" : "none",
      lastCompletedTurnAt,
      activityAt,
      sortAt: activityAt ?? root.sortAt
    };
  });
};

const isVisibleTree = (seed: SessionBrowserReadModelSeed): boolean =>
  seed.isVisible !== false && !seed.archivedAt;

/**
 * Per-workspace paged view with one row per fork tree. Subagents nest under the tree that spawned them.
 * Each member id resolves to its tree entry; archiving a root hides the tree and its nested subagents.
 */
export class SessionBrowserReadModel {
  private readonly rootsByWorkspaceId = new Map<string, SessionBrowserItemRpc[]>();
  private readonly itemsBySessionId = new Map<string, SessionBrowserItemRpc>();
  private readonly revisions = new Map<string, string>();

  public constructor(sessionSeeds: readonly SessionBrowserReadModelSeed[]) {
    const seeds = collectForkTrees(sessionSeeds);
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
      const { workspaceId: _workspaceId, sortAt: _sortAt, forkParentSessionId: _forkParentSessionId, archivedAt: _archivedAt, isVisible: _isVisible, ...rest } = seed;
      const item: SessionBrowserItemRpc = {
        ...rest,
        parentSessionId,
        subagents: (childrenByParentId.get(seed.sessionId) ?? [])
          .filter(isVisibleTree)
          .sort(compareSeeds)
          .map((child) => build(child, seed.sessionId))
      };
      for (const memberId of seed.memberSessionIds ?? [seed.sessionId]) {
        this.itemsBySessionId.set(memberId, item);
      }
      return item;
    };

    for (const workspaceId of new Set(seeds.map((seed) => seed.workspaceId))) {
      const workspaceRoots = roots
        .filter((seed) => seed.workspaceId === workspaceId && isVisibleTree(seed))
        .sort(compareSeeds)
        .map((seed) => build(seed));
      this.rootsByWorkspaceId.set(workspaceId, workspaceRoots);
      const fingerprint = seeds
        .filter((seed) => seed.workspaceId === workspaceId)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map((seed) => [
          seed.sessionId,
          seed.memberSessionIds,
          seed.parentSessionId,
          seed.archivedAt,
          seed.isVisible,
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
