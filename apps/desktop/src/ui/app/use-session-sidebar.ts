import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionBrowserChangesRpc,
  SessionBrowserItemRpc,
  SessionBrowserSnapshotRpc
} from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { RendererStore } from "../../store/store.js";
import { useRendererStoreState } from "../chat-shell/use-renderer-store-state.js";

export type SidebarSession = Omit<SessionBrowserItemRpc, "subagents"> & {
  workspaceId: string;
  sortAt: string;
  subagents: SidebarSession[];
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
const applyChanges = (current: WorkspaceSessions, changes: ChangedResponse): WorkspaceSessions | undefined => {
  if (changes.revision === current.revision) {
    return undefined;
  }
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

/**
 * Sidebar query owned by the app: every loaded workspace keeps its whole row list and the revision it came from.
 * Entering the workbench reads a full snapshot per workspace; later session events ask only for changed rows.
 */
export const useSessionSidebar = (input: { transport: DesktopTransport; store: RendererStore; workspaceIds: string[]; kind?: "user" | "agent" }) => {
  const { transport, store, workspaceIds, kind } = input;
  const refreshSignal = useRendererStoreState(store).refreshSignals.sessionBrowser;
  const queryKey = JSON.stringify([workspaceIds, kind]);
  const [result, setResult] = useState<{ queryKey: string; workspaces: Record<string, WorkspaceSessions> }>({ queryKey, workspaces: {} });
  const [pending, setPending] = useState<{ queryKey: string; loading: boolean }>({ queryKey, loading: true });
  const [failure, setFailure] = useState<{ queryKey: string; message: string }>();
  const generation = useRef(0);
  const loadRef = useRef<Promise<void> | undefined>(undefined);
  const refreshRef = useRef({ running: false, queued: false });
  const appliedRef = useRef({ queryKey, workspaces: {} as Record<string, WorkspaceSessions> });
  const workspaces = result.queryKey === queryKey ? result.workspaces : {};
  const loading = pending.queryKey !== queryKey || pending.loading;
  const error = failure?.queryKey === queryKey ? failure.message : undefined;

  /** The applied list lives in the ref: it advances synchronously, while the state only mirrors it for rendering. */
  const apply = useCallback((next: { queryKey: string; workspaces: Record<string, WorkspaceSessions> }) => {
    appliedRef.current = next;
    setResult(next);
  }, []);

  const loadAll = useCallback(async () => {
    const task = (async () => {
      const run = ++generation.current;
      setPending({ queryKey, loading: true });
      setFailure(undefined);
      try {
        const snapshots = await Promise.all(
          workspaceIds.map((workspaceId) => transport.sessionBrowser.list({ workspaceId, kind }))
        );
        if (run !== generation.current) return;
        apply({
          queryKey,
          workspaces: Object.fromEntries(snapshots.map((snapshot) => [snapshot.workspaceId, toWorkspaceSessions(snapshot)]))
        });
      } catch (cause) {
        if (run === generation.current) setFailure({ queryKey, message: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        if (run === generation.current) setPending({ queryKey, loading: false });
      }
    })();
    loadRef.current = task;
    try {
      await task;
    } finally {
      if (loadRef.current === task) loadRef.current = undefined;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, queryKey, apply]);

  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  const reload = useCallback(() => loadAllRef.current(), []);

  useEffect(() => {
    void loadAll();
    return () => { generation.current += 1; };
  }, [loadAll]);

  const refreshChanges = useCallback(async () => {
    // Overlapping events collapse into one extra pass instead of dropping the delta the loser carried.
    if (refreshRef.current.running) {
      refreshRef.current.queued = true;
      return;
    }
    refreshRef.current.running = true;
    try {
      do {
        refreshRef.current.queued = false;
        // A refresh always starts from a settled snapshot, so an event that lands during the first read still applies.
        await loadRef.current;
        const requested = appliedRef.current;
        if (requested.queryKey !== queryKey) return;
        const entries = Object.entries(requested.workspaces);
        if (entries.length === 0) return;
        const run = generation.current;
        try {
          const responses = await Promise.all(entries.map(async ([workspaceId, current]) => ({
            workspaceId,
            current,
            response: await transport.sessionBrowser.changes({ workspaceId, revision: current.revision, kind })
          })));
          if (run !== generation.current) return;
          const fullRequired = responses.some(({ response }) => response.status === "full-required");
          const applied = appliedRef.current;
          let changed = false;
          const next = { ...applied.workspaces };
          for (const { workspaceId, current, response } of responses) {
            if (response.status === "full-required") continue;
            if (next[workspaceId] !== current) continue;
            const merged = applyChanges(current, response);
            if (!merged) continue;
            next[workspaceId] = merged;
            changed = true;
          }
          if (changed && applied.queryKey === queryKey) {
            apply({ queryKey, workspaces: next });
          }
          if (fullRequired) await loadAllRef.current();
        } catch {
          if (run === generation.current) await loadAllRef.current();
        }
      } while (refreshRef.current.queued);
    } finally {
      refreshRef.current.running = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, kind, queryKey, apply]);

  const handledRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (handledRefreshSignal.current === refreshSignal) return;
    handledRefreshSignal.current = refreshSignal;
    void refreshChanges();
  }, [refreshChanges, refreshSignal]);

  const sessions = useMemo(
    () => Object.values(workspaces)
      .flatMap((entry) => entry.items)
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.sortAt.localeCompare(a.sortAt) || a.sessionId.localeCompare(b.sessionId)),
    [workspaces]
  );

  /**
   * Finds a tree or nested subagent tree by any member session id.
   * It reads the applied list instead of the rendered one so its identity survives list updates
   * and the memoized rows keep rendering untouched.
   */
  const findSession = useCallback((sessionId: string): SidebarSession | undefined => {
    const walk = (items: SidebarSession[]): SidebarSession | undefined => {
      for (const item of items) {
        if (item.sessionId === sessionId || item.memberSessionIds?.includes(sessionId)) return item;
        const nested = walk(item.subagents);
        if (nested) return nested;
      }
      return undefined;
    };
    for (const entry of Object.values(appliedRef.current.workspaces)) {
      const found = walk(entry.items);
      if (found) return found;
    }
    return undefined;
  }, []);

  return { sessions, loading, error, reload, findSession };
};
