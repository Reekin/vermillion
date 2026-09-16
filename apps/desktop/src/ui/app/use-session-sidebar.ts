import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { RendererStore } from "../../store/store.js";
import { useRendererStoreState } from "../chat-shell/use-renderer-store-state.js";
import { compareSidebarSessions, SessionSidebarStore } from "./session-sidebar-store.js";

export type { SidebarSession } from "./session-sidebar-store.js";

/**
 * Sidebar query owned by the app. Each query gets its own store that reads a full snapshot per workspace;
 * later session events ask it for changed rows only.
 */
export const useSessionSidebar = (input: { transport: DesktopTransport; store: RendererStore; workspaceIds: string[]; kind?: "user" | "agent" }) => {
  const { transport, store, workspaceIds, kind } = input;
  const refreshSignal = useRendererStoreState(store).refreshSignals.sessionBrowser;
  const queryKey = JSON.stringify([workspaceIds, kind]);
  const [sidebar, setSidebar] = useState(() => new SessionSidebarStore(transport, { workspaceIds, kind }));
  useEffect(() => {
    const current = sidebar.queryKey === queryKey ? sidebar : new SessionSidebarStore(transport, { workspaceIds, kind });
    if (current !== sidebar) setSidebar(current);
    void current.reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, queryKey]);
  useEffect(() => { void sidebar.refresh(); }, [sidebar, refreshSignal]);

  const { workspaces, loading, error } = useSyncExternalStore(sidebar.subscribe, sidebar.getState, sidebar.getState);
  const sessions = useMemo(
    () => Object.values(workspaces).flatMap((entry) => entry.items).sort(compareSidebarSessions),
    [workspaces]
  );

  return { sessions, loading, error, reload: sidebar.reload, refresh: sidebar.refresh, findSession: sidebar.findSession };
};
