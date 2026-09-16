import type {
  SessionBrowserChangesRpc,
  SessionBrowserItemRpc,
  SessionBrowserSnapshotRpc
} from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";

export type SidebarSession = Omit<SessionBrowserItemRpc, "subagents"> & {
  workspaceId: string;
  sortAt: string;
  subagents: SidebarSession[];
};

export type SidebarQuery = { workspaceIds: string[]; kind?: "user" | "agent" };

export type SidebarState = {
  workspaces: Record<string, WorkspaceSessions>;
  loading: boolean;
  error?: string;
};

type WorkspaceSessions = { revision: string; items: SidebarSession[] };

type ChangedResponse = Extract<SessionBrowserChangesRpc, { status: "changed" }>;

const sortAtOf = (item: SessionBrowserItemRpc): string => item.activityAt ?? item.lastCompletedTurnAt ?? "";

/** Rows carry their workspace and sort key at every nesting level so unchanged rows keep their identity. */
const toSidebar = (item: SessionBrowserItemRpc, workspaceId: string, sortAt: string): SidebarSession => ({
  ...item,
  workspaceId,
  sortAt,
  subagents: item.subagents.map((child) => toSidebar(child, workspaceId, sortAt))
});

const toWorkspaceSessions = (snapshot: SessionBrowserSnapshotRpc): WorkspaceSessions => ({
  revision: snapshot.revision,
  items: snapshot.items.map((item) => toSidebar(item, snapshot.workspaceId, sortAtOf(item)))
});

/** Applies the changed rows in place; returns undefined when the response carries nothing new. */
const mergeChanges = (current: WorkspaceSessions, changes: ChangedResponse): WorkspaceSessions | undefined => {
  if (changes.revision === current.revision) return undefined;
  const removedIds = new Set(changes.removedSessionIds);
  const changedById = new Map(changes.items.map((item) => {
    const session = toSidebar(item, changes.workspaceId, sortAtOf(item));
    return [session.sessionId, session] as const;
  }));
  const items = current.items.flatMap((session) =>
    removedIds.has(session.sessionId) ? [] : [changedById.get(session.sessionId) ?? session]
  );
  const known = new Set(current.items.map((session) => session.sessionId));
  for (const session of changedById.values()) {
    if (!known.has(session.sessionId)) items.push(session);
  }
  return { revision: changes.revision, items };
};

export const compareSidebarSessions = (a: SidebarSession, b: SidebarSession): number =>
  Number(b.isPinned) - Number(a.isPinned) || b.sortAt.localeCompare(a.sortAt) || a.sessionId.localeCompare(b.sessionId);

/**
 * Row lists of every workspace in one query, each with the revision it came from.
 * Every load and refresh runs through one serial queue: a refresh always starts from a settled list,
 * and events arriving while one runs collapse into a single extra pass.
 */
export class SessionSidebarStore {
  private state: SidebarState = { workspaces: {}, loading: true };
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private refreshQueued = false;
  public readonly queryKey: string;

  public constructor(
    private readonly transport: DesktopTransport,
    private readonly query: SidebarQuery
  ) {
    this.queryKey = JSON.stringify([query.workspaceIds, query.kind]);
  }

  public getState = (): SidebarState => this.state;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Reads a full snapshot of every workspace in the query. */
  public reload = (): Promise<void> => this.enqueue(() => this.loadAll());

  /** Applies the rows changed since the held revisions; an expired revision falls back to a full read. */
  public refresh = (): Promise<void> => {
    if (this.refreshQueued) return this.queue;
    this.refreshQueued = true;
    return this.enqueue(async () => {
      this.refreshQueued = false;
      await this.applyChanges();
    });
  };

  /** Finds a tree or nested subagent tree by any member session id. */
  public findSession = (sessionId: string): SidebarSession | undefined => {
    const walk = (items: SidebarSession[]): SidebarSession | undefined => {
      for (const item of items) {
        if (item.sessionId === sessionId || item.memberSessionIds?.includes(sessionId)) return item;
        const nested = walk(item.subagents);
        if (nested) return nested;
      }
      return undefined;
    };
    for (const entry of Object.values(this.state.workspaces)) {
      const found = walk(entry.items);
      if (found) return found;
    }
    return undefined;
  };

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  private set(patch: Partial<SidebarState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private async loadAll(): Promise<void> {
    this.set({ loading: true, error: undefined });
    try {
      const snapshots = await Promise.all(
        this.query.workspaceIds.map((workspaceId) => this.transport.sessionBrowser.list({ workspaceId, kind: this.query.kind }))
      );
      this.set({
        loading: false,
        workspaces: Object.fromEntries(snapshots.map((snapshot) => [snapshot.workspaceId, toWorkspaceSessions(snapshot)]))
      });
    } catch (cause) {
      this.set({ loading: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private async applyChanges(): Promise<void> {
    const entries = Object.entries(this.state.workspaces);
    if (entries.length === 0) return;
    try {
      const responses = await Promise.all(entries.map(async ([workspaceId, current]) => ({
        current,
        response: await this.transport.sessionBrowser.changes({ workspaceId, revision: current.revision, kind: this.query.kind })
      })));
      if (responses.some(({ response }) => response.status === "full-required")) {
        await this.loadAll();
        return;
      }
      const next = { ...this.state.workspaces };
      let changed = false;
      for (const { current, response } of responses) {
        if (response.status !== "changed") continue;
        const merged = mergeChanges(current, response);
        if (!merged) continue;
        next[response.workspaceId] = merged;
        changed = true;
      }
      if (changed) this.set({ workspaces: next });
    } catch {
      await this.loadAll();
    }
  }
}
