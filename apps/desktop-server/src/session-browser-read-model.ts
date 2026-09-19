import type { SessionBrowserItemRpc, SessionBrowserSnapshotRpc } from "@vermillion/shared";

export type SessionBrowserReadModelSeed = Omit<SessionBrowserItemRpc, "subagents"> & {
  workspaceId: string;
  sortAt: string;
  forkParentSessionId?: string;
  archivedAt?: string;
  isVisible?: boolean;
};

/** Rows that entered or left one workspace between two revisions. */
export type SessionBrowserRowDelta = {
  workspaceId: string;
  from: string;
  to: string;
  changedIds: string[];
  removedIds: string[];
};

/** Walks the recorded deltas from the caller's revision up to the current one. */
export const resolveRowDelta = (
  chain: readonly SessionBrowserRowDelta[],
  revision: string,
  currentRevision: string
): { changedIds: string[]; removedIds: string[] } | undefined => {
  const start = chain.findIndex((entry) => entry.from === revision);
  if (start < 0 || chain.at(-1)?.to !== currentRevision) {
    return undefined;
  }
  const changedIds = new Set<string>();
  const removedIds = new Set<string>();
  for (const entry of chain.slice(start)) {
    for (const id of entry.changedIds) {
      changedIds.add(id);
      removedIds.delete(id);
    }
    for (const id of entry.removedIds) {
      removedIds.add(id);
      changedIds.delete(id);
    }
  }
  return { changedIds: [...changedIds], removedIds: [...removedIds] };
};

/** Row level difference between two models; rows are addressed by their tree root session id. */
export const diffRowDeltas = (
  previous: SessionBrowserReadModel,
  next: SessionBrowserReadModel
): SessionBrowserRowDelta[] => {
  const deltas: SessionBrowserRowDelta[] = [];
  for (const workspaceId of new Set([...previous.workspaces(), ...next.workspaces()])) {
    const from = previous.revision(workspaceId);
    const to = next.revision(workspaceId);
    if (from === to) {
      continue;
    }
    const before = previous.rowFingerprints(workspaceId);
    const after = next.rowFingerprints(workspaceId);
    deltas.push({
      workspaceId,
      from,
      to,
      changedIds: [...after].filter(([id, fingerprint]) => before.get(id) !== fingerprint).map(([id]) => id),
      removedIds: [...before.keys()].filter((id) => !after.has(id))
    });
  }
  return deltas;
};

/** Pinned first, then most recent activity first. */
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
    const activityAt = latest([
      lastCompletedTurnAt,
      ...visibleMembers.map((member) => member.activityAt ?? member.sortAt)
    ]);
    const parent = root.parentSessionId ? bySessionId.get(root.parentSessionId) : undefined;
    return {
      ...root,
      memberSessionIds: [root.sessionId, ...members.filter((member) => member !== root).map((member) => member.sessionId).sort()],
      parentSessionId: parent ? rootOf(parent).sessionId : root.parentSessionId,
      isVisible: visibleMembers.length > 0,
      isActive,
      statusDot: visibleMembers.some((member) => member.statusDot === "running")
        ? "running"
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
 * Per-workspace view with one row per fork tree. Subagents nest under the tree that spawned them.
 * Each member id resolves to its tree entry; archiving a root hides the tree and its nested subagents.
 * A workspace revision covers the rows the browser shows; row fingerprints let callers diff two revisions.
 */
export class SessionBrowserReadModel {
  private readonly rootsByWorkspaceId = new Map<string, SessionBrowserItemRpc[]>();
  private readonly fingerprintsByWorkspaceId = new Map<string, Map<string, string>>();
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
      const fingerprints = workspaceRoots.map((root) => [root.sessionId, JSON.stringify(root)] as const);
      this.rootsByWorkspaceId.set(workspaceId, workspaceRoots);
      this.fingerprintsByWorkspaceId.set(workspaceId, new Map(fingerprints));
      this.revisions.set(workspaceId, createRevision(JSON.stringify(fingerprints)));
    }
  }

  public snapshot(input: { workspaceId: string; kind?: "user" | "agent" }): SessionBrowserSnapshotRpc {
    return {
      workspaceId: input.workspaceId,
      revision: this.revision(input.workspaceId),
      items: this.rows(input)
    };
  }

  public rows(input: { workspaceId: string; kind?: "user" | "agent" }): SessionBrowserItemRpc[] {
    const all = this.rootsByWorkspaceId.get(input.workspaceId) ?? [];
    return input.kind ? all.filter((item) => (item.role === undefined) === (input.kind === "user")) : all;
  }

  public workspaces(): string[] {
    return [...this.revisions.keys()];
  }

  public revision(workspaceId: string): string {
    return this.revisions.get(workspaceId) ?? createRevision(workspaceId);
  }

  public rowFingerprints(workspaceId: string): ReadonlyMap<string, string> {
    return this.fingerprintsByWorkspaceId.get(workspaceId) ?? new Map<string, string>();
  }

  public get(sessionId: string): SessionBrowserItemRpc | undefined {
    return this.itemsBySessionId.get(sessionId);
  }
}
