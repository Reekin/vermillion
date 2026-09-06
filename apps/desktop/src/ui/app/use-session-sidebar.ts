import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionBrowserItemRpc, SessionBrowserPageRpc } from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { RendererStore } from "../../store/store.js";
import { useRendererStoreState } from "../chat-shell/use-renderer-store-state.js";

export type SidebarSession = SessionBrowserItemRpc & { workspaceId: string; sortAt: string };

type WorkspacePage = { items: SidebarSession[]; nextCursor?: string; hasMore: boolean; revision: string };

const PAGE = 20;

const sortAtOf = (item: SessionBrowserItemRpc): string => item.lastCompletedTurnAt ?? item.activityAt ?? "";

const toSidebar = (page: SessionBrowserPageRpc): SidebarSession[] =>
  page.items.map((item) => ({ ...item, workspaceId: page.workspaceId, sortAt: sortAtOf(item) }));

/**
 * Sidebar query owned by the app: one page per workspace, merged and ordered pinned-first then by last completed turn.
 * "Load more" advances the workspace whose next page is most recent.
 */
export const useSessionSidebar = (input: { transport: DesktopTransport; store: RendererStore; workspaceIds: string[] }) => {
  const { transport, store, workspaceIds } = input;
  const refreshSignal = useRendererStoreState(store).refreshSignals.sessionBrowser;
  const [pages, setPages] = useState<Record<string, WorkspacePage>>({});
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const idsKey = workspaceIds.join("|");

  const loadFirstPages = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true);
    const results = await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        const page = await transport.sessionBrowser.list({ workspaceId, limit: PAGE });
        return [workspaceId, { items: toSidebar(page), nextCursor: page.nextCursor, hasMore: page.hasMore, revision: page.revision }] as const;
      })
    );
    if (run !== generation.current) return;
    setPages(Object.fromEntries(results));
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, idsKey]);

  useEffect(() => {
    void loadFirstPages();
  }, [loadFirstPages, refreshSignal]);

  const sessions = Object.values(pages)
    .flatMap((page) => page.items)
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.sortAt.localeCompare(a.sortAt) || a.sessionId.localeCompare(b.sessionId));

  const hasMore = Object.values(pages).some((page) => page.hasMore);

  /** Finds a root or nested subagent session by id. */
  const findSession = (sessionId: string): SidebarSession | undefined => {
    const walk = (items: SidebarSession[]): SidebarSession | undefined => {
      for (const item of items) {
        if (item.sessionId === sessionId) return item;
        const nested = walk(item.subagents.map((child) => ({ ...child, workspaceId: item.workspaceId, sortAt: item.sortAt })));
        if (nested) return nested;
      }
      return undefined;
    };
    return walk(sessions);
  };

  const loadMore = useCallback(async () => {
    const candidates = Object.entries(pages).filter(([, page]) => page.hasMore && page.nextCursor);
    if (candidates.length === 0) return;
    // The workspace whose oldest loaded session is the newest has the most recent unseen page.
    const [workspaceId, page] = candidates.sort(([, a], [, b]) => (b.items.at(-1)?.sortAt ?? "").localeCompare(a.items.at(-1)?.sortAt ?? ""))[0]!;
    const run = generation.current;
    setLoading(true);
    try {
      const next = await transport.sessionBrowser.list({ workspaceId, cursor: page.nextCursor, expectedRevision: page.revision, limit: PAGE });
      if (run !== generation.current) return;
      setPages((current) => ({
        ...current,
        [workspaceId]: { items: [...page.items, ...toSidebar(next)], nextCursor: next.nextCursor, hasMore: next.hasMore, revision: next.revision }
      }));
    } catch {
      // Cursor went stale (sessions changed under us); reload from the top.
      await loadFirstPages();
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [pages, transport, loadFirstPages]);

  return { sessions, hasMore, loading, loadMore, reload: loadFirstPages, findSession };
};
