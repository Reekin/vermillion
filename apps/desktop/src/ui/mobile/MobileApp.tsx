import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, Inbox as InboxIcon, MessageSquare } from "lucide-react";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { createWorkbenchClient, type InboxItem, type Workspace, type WorkItem, type WorkRequest } from "@vermillion/workbench/client";
import { createRendererStore } from "../../store/store.js";
import { createDesktopTransport } from "../../transport/desktop-transport.js";
import { createRemoteClient } from "../../transport/remote-client.js";
import { connectDesktopTransportToStore } from "../../transport/store-bridge.js";
import { MobileSessionPane } from "../chat-shell/MobileSessionPane.js";
import { createCoalescedRefresh } from "../chat-shell/coalesced-refresh.js";
import { formatRelativeActivityAge } from "../chat-shell/SessionPane.js";
import { useRendererStoreState } from "../chat-shell/use-renderer-store-state.js";
import { useSessionSidebar, type SidebarSession } from "../app/use-session-sidebar.js";
import { roleLabel } from "../app/components/workflow-display.js";
import { statusLabel } from "../app/components/task-labels.js";
import { Badge, BottomSheet, Button, ChoiceChips, EmptyState, Field, InlineNotice, ListRow, StatusDot, TabBar } from "../app/components/ui.js";
import { describeServiceError, t } from "../../i18n/index.js";
import { useT } from "../../i18n/react.js";
import { MobileInbox } from "./MobileInbox.js";
import { branchesStatus, treeBranches, type TreeBranch } from "./branches.js";
import { listHash, parseMobileRoute, sessionHash } from "./navigation.js";

const credentialKey = "vermillion.remote.token";
const cacheKey = "vermillion.mobile.cache";
function savedToken(): string | undefined {
  if (window.__VERMILLION_REMOTE__?.token) return window.__VERMILLION_REMOTE__.token;
  try { return localStorage.getItem(credentialKey) || undefined; } catch { return undefined; }
}

/** Last rendered lists, shown at once on the next open while the live data loads. Holds no credential. */
type MobileCache = { desktopName?: string; workspaces: Workspace[]; sessions: SidebarSession[]; inbox: InboxItem[] };
const readCache = (): MobileCache | undefined => {
  try { return JSON.parse(localStorage.getItem(cacheKey) ?? "null") ?? undefined; } catch { return undefined; }
};
const writeCache = (cache: MobileCache) => {
  try { localStorage.setItem(cacheKey, JSON.stringify({ ...cache, sessions: cache.sessions.slice(0, 80) })); } catch { /* Storage is optional. */ }
};

const inApp = () => Boolean(window.webkit?.messageHandlers?.vermillion);
type NativeMessage = { type: "exit" } | { type: "level"; level: "list" | "session" };
const postNative = (message: NativeMessage) => window.webkit?.messageHandlers?.vermillion?.postMessage(message);

/** Keeps the page as tall as the visible area, so the composer rides on top of the keyboard. */
const useVisualViewportHeight = () => {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      document.documentElement.style.setProperty("--vm-viewport-height", `${viewport.height}px`);
      if (window.scrollY) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => { viewport.removeEventListener("resize", update); viewport.removeEventListener("scroll", update); };
  }, []);
};

function Pairing({ paired }: { paired: (token: string) => void }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => t("mobile.defaultDeviceName"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pair = async () => {
    setBusy(true); setError(undefined);
    try {
      const response = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim(), name: name.trim() }) });
      const result = await response.json() as { token?: string; error?: string; text?: { code: string; params?: Record<string, string | number> } };
      if (!response.ok || !result.token) throw new Error(result.text ? describeServiceError(result.text) : result.error ?? t("mobile.pairFailed"));
      localStorage.setItem(credentialKey, result.token);
      paired(result.token);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("mobile.cannotConnect")); }
    finally { setBusy(false); }
  };
  return <main className="vm-mobile-pair">
    <h1 className="text-title font-semibold text-strong">{t("mobile.connectTitle")}</h1>
    <p className="mt-2 text-body text-muted-foreground">{t("mobile.connectHint")}</p>
    <form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <Field label={t("mobile.deviceName")} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
      <Field label={t("mobile.pairCode")} value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" pattern="[0-9]{8}" maxLength={8} autoComplete="one-time-code" required />
      {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
      <Button variant="primary" type="submit" className="w-full" disabled={busy || !name.trim() || code.trim().length !== 8}>{busy ? t("mobile.pairing") : t("mobile.pair")}</Button>
    </form>
  </main>;
}

/** Right swipe from the left edge closes the session layer; the layer follows the finger. */
const useEdgeSwipe = (onBack: () => void) => {
  const [offset, setOffset] = useState<number>();
  const gesture = useRef<{ x: number; y: number; at: number; tracking: boolean; last: number }>(undefined);
  const handlers = {
    onTouchStart: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      gesture.current = touch && touch.clientX <= 24 && event.touches.length === 1
        ? { x: touch.clientX, y: touch.clientY, at: performance.now(), tracking: false, last: 0 } : undefined;
    },
    onTouchMove: (event: React.TouchEvent) => {
      const current = gesture.current;
      const touch = event.touches[0];
      if (!current || !touch) return;
      const dx = touch.clientX - current.x;
      if (!current.tracking) {
        if (Math.abs(touch.clientY - current.y) > Math.abs(dx)) { gesture.current = undefined; return; }
        if (dx < 8) return;
        current.tracking = true;
      }
      current.last = Math.max(0, dx);
      setOffset(current.last);
    },
    onTouchEnd: () => {
      const current = gesture.current;
      gesture.current = undefined;
      if (!current?.tracking) return;
      const velocity = current.last / Math.max(1, performance.now() - current.at);
      if (current.last > window.innerWidth * 0.35 || velocity > 0.5) onBack();
      setOffset(undefined);
    }
  };
  return { offset, handlers: { ...handlers, onTouchCancel: handlers.onTouchEnd } };
};

type BranchDetail = { title: string; marker?: string; detail?: string; time?: string };

function BranchSheet({ branches, current, describe, loading, error, onSelect, onClose }: {
  branches: TreeBranch[]; current?: string; describe: (branch: TreeBranch) => BranchDetail; loading: boolean; error?: string;
  onSelect: (sessionId: string) => void; onClose: () => void;
}) {
  const t = useT();
  const running = branches.filter((branch) => branch.running).length;
  return <BottomSheet title={t("mobile.branches.title")} onClose={onClose}
    meta={branches.length ? t("mobile.branches.summary", { count: branches.length, running }) : undefined}>
    {error ? <EmptyState title={t("mobile.branches.failed")} hint={error} />
      : !branches.length ? <EmptyState title={loading ? t("mobile.branches.loading") : t("mobile.branches.empty")} />
        : <ul className="vm-mobile-branches">{branches.map((branch) => {
          const detail = describe(branch);
          return <li key={branch.sessionId}>
            <button type="button" className="vm-mobile-branch" aria-current={branch.sessionId === current ? "true" : undefined}
              style={{ paddingLeft: 16 + branch.depth * 18 }} onClick={() => onSelect(branch.sessionId)}>
              <StatusDot status={branch.running ? "running" : branch.unread ? "unread_completed" : "none"} />
              <span className="vm-mobile-branch__title">{detail.marker && <Badge>{detail.marker}</Badge>}<span>{detail.title}</span></span>
              <span className="vm-mobile-branch__time">{detail.time}</span>
              {detail.detail && <span className="vm-mobile-branch__detail">{detail.detail}</span>}
            </button>
          </li>;
        })}</ul>}
  </BottomSheet>;
}

function ListHeader({ title, desktopName, connected, children }: { title: string; desktopName?: string; connected: boolean; children?: ReactNode }) {
  const t = useT();
  return <header className="vm-mobile-hero">
    {inApp() && <button type="button" className="vm-mobile-hero__back" onClick={() => postNative({ type: "exit" })}>
      <ChevronLeft size={20} strokeWidth={1.8} aria-hidden="true" />{t("mobile.desktops")}
    </button>}
    <div className="vm-mobile-hero__row">
      <h1>{title}</h1>
      <span className="vm-mobile-hero__status" data-connected={connected || undefined}>
        <i />{connected ? desktopName : t("mobile.connecting")}
      </span>
    </div>
    {children}
  </header>;
}

function ConnectedApp({ token, reset }: { token: string; reset: () => void }) {
  const t = useT();
  const [cache] = useState(readCache);
  const [runtime] = useState(() => {
    const store = createRendererStore();
    const remote = createRemoteClient(token, { onReplayGap: async () => {
      store.clearKnownSessionWindows();
      const result = await transport.domain.snapshot();
      store.hydrateSnapshot(result.snapshot, result.cursor);
      return result.cursor;
    } });
    const transport = createDesktopTransport(remote.session);
    return { remote, client: createWorkbenchClient(remote.workbench), transport, store, drafts: new Map<string, string>() };
  });
  const { remote, client, transport, store } = runtime;
  const connection = useSyncExternalStore(remote.subscribeConnection, remote.getConnectionState);
  const connected = connection === "connected";
  const [route, setRoute] = useState(() => parseMobileRoute(location.hash));
  const [listTab, setListTab] = useState<"sessions" | "inbox">(route.page === "inbox" ? "inbox" : "sessions");
  const [desktopName, setDesktopName] = useState(cache?.desktopName);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(cache?.workspaces ?? []);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [items, setItems] = useState<InboxItem[]>(cache?.inbox ?? []);
  const [inboxError, setInboxError] = useState<string>();
  const [inboxLoading, setInboxLoading] = useState(!cache);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [inboxRefresh] = useState(createCoalescedRefresh);
  const [workspaceRefresh] = useState(createCoalescedRefresh);
  const [treeRefresh] = useState(createCoalescedRefresh);
  const visibleScope = useRef({ turnIds: new Set<string>(), sessionId: "" });
  const [currentBranch, setCurrentBranch] = useState<string>();
  const onVisiblePathChange = useCallback((turnIds: string[], sessionId: string) => {
    visibleScope.current = { turnIds: new Set(turnIds), sessionId };
    if (turnIds.length) setCurrentBranch(sessionId);
  }, []);
  const sidebar = useSessionSidebar({ transport, store, workspaceIds: workspaces.filter((w) => !workspaceFilter || w.workspaceId === workspaceFilter).map((w) => w.workspaceId) });
  const sessions = sidebar.sessions.length || (connected && !sidebar.loading) ? sidebar.sessions
    : (cache?.sessions ?? []).filter((session) => !workspaceFilter || session.workspaceId === workspaceFilter);

  // Session layer lifecycle: pushed in on open, slid out before the route returns to the list.
  const [leaving, setLeaving] = useState(false);
  const [branchSessionId, setBranchSessionId] = useState<string>();
  const [branchSheet, setBranchSheet] = useState(false);
  const [tree, setTree] = useState<{ sessionId: string; snapshot: ChatTreeSnapshotRpc }>();
  const [treeError, setTreeError] = useState<string>();
  const [work, setWork] = useState<{ workspaceId: string; items: WorkItem[]; requests: WorkRequest[] }>();
  const navigate = useCallback((hash: string, mode: "push" | "replace" | "back") => {
    if (mode === "back" && history.state?.vmPushed) { history.back(); return; }
    if (mode === "push") history.pushState({ vmPushed: true }, "", hash);
    else history.replaceState(null, "", hash);
    setRoute(parseMobileRoute(hash));
  }, []);
  const openSession = (sessionId: string) => navigate(sessionHash(sessionId), "push");
  const closeSession = () => {
    if (leaving) return;
    setLeaving(true);
    setBranchSheet(false);
    setTimeout(() => { setLeaving(false); navigate(listHash(listTab), "back"); }, 280);
  };
  const swipe = useEdgeSwipe(closeSession);
  const selectTab = (tab: "sessions" | "inbox") => { setListTab(tab); navigate(listHash(tab), "replace"); };

  useEffect(() => {
    const changed = () => setRoute(parseMobileRoute(location.hash));
    window.addEventListener("hashchange", changed);
    window.addEventListener("popstate", changed);
    return () => { window.removeEventListener("hashchange", changed); window.removeEventListener("popstate", changed); };
  }, []);
  useEffect(() => { if (route.page !== "session") setListTab(route.page); }, [route.page]);
  const sessionId = route.page === "session" ? route.sessionId : undefined;
  useEffect(() => { setBranchSessionId(undefined); setCurrentBranch(undefined); setBranchSheet(false); setTree(undefined); setTreeError(undefined); }, [sessionId]);
  useEffect(() => { postNative({ type: "level", level: sessionId ? "session" : "list" }); }, [sessionId]);

  const refreshInbox = () => inboxRefresh.request(async (signal) => {
    try {
      const next = await client.request("inbox.list", {});
      if (!signal.aborted) { setItems(next); setInboxError(undefined); }
    }
    catch (cause) { if (!signal.aborted && remote.getConnectionState() === "connected") setInboxError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!signal.aborted) setInboxLoading(false); }
  });
  const refreshWorkspaces = () => workspaceRefresh.request(async (signal) => {
    try {
      const next = await client.request("workspace.list", {});
      if (!signal.aborted) { setWorkspaces(next); setWorkspaceError(undefined); }
    } catch (cause) {
      if (!signal.aborted && remote.getConnectionState() === "connected") setWorkspaceError(String(cause));
    }
  });
  useEffect(() => {
    void remote.connect().catch(() => undefined);
    // A page the system suspended in the background reconnects as soon as it is shown again.
    const resume = () => { if (document.visibilityState === "visible") void remote.connect().catch(() => undefined); };
    document.addEventListener("visibilitychange", resume);
    return () => { document.removeEventListener("visibilitychange", resume); inboxRefresh.cancel(); workspaceRefresh.cancel(); treeRefresh.cancel(); remote.dispose(); };
  }, [remote]);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let subscription: Awaited<ReturnType<typeof connectDesktopTransportToStore>> | undefined;
    void connectDesktopTransportToStore({ transport, store, isBackgroundStream: ({ event }) => {
      const scope = visibleScope.current;
      return scope.turnIds.size > 0
        ? !("turnId" in event && typeof event.turnId === "string" && scope.turnIds.has(event.turnId))
        : !("sessionId" in event && event.sessionId === scope.sessionId);
    } }).then((value) => {
      if (cancelled) void value.unsubscribe().catch(() => undefined);
      else subscription = value;
    }).catch((cause) => { if (!cancelled) setWorkspaceError(String(cause)); });
    void fetch("/api/summary", { headers: { authorization: `Bearer ${token}` } })
      .then(async (response) => { if (response.ok && !cancelled) setDesktopName(((await response.json()) as { desktopName?: string }).desktopName); })
      .catch(() => undefined);
    void refreshWorkspaces();
    void refreshInbox();
    void sidebar.reload();
    setReloadSignal((value) => value + 1);
    return () => { cancelled = true; void subscription?.unsubscribe().catch(() => undefined); };
  // Refresh reads after each authenticated connection; never retry mutations here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, client, transport, store]);
  useEffect(() => client.subscribe((event) => {
    if (event.type === "workspaces.changed") void refreshWorkspaces();
    if (["decisions.changed", "workItems.changed", "actions.changed", "runs.changed", "workRequests.changed"].includes(event.type)) void refreshInbox();
  }), [client]);
  useEffect(() => {
    // Only the unfiltered list describes the whole desktop.
    if (!connected || workspaceFilter || !sidebar.sessions.length) return;
    writeCache({ desktopName, workspaces, sessions: sidebar.sessions, inbox: items });
  }, [connected, desktopName, workspaces, sidebar.sessions, items, workspaceFilter]);

  // The whole tree backs the branch button and sheet; the transcript itself reads only the viewed path.
  const treeSignal = useRendererStoreState(store).refreshSignals.chatTree;
  useEffect(() => {
    if (!sessionId || !connected) return;
    void treeRefresh.request(async (signal) => {
      try {
        const snapshot = await transport.chatTree.get(sessionId, { scope: "tree", signal });
        if (!signal.aborted) { setTree({ sessionId, snapshot }); setTreeError(undefined); }
      } catch (cause) { if (!signal.aborted) setTreeError(cause instanceof Error ? cause.message : String(cause)); }
    });
  }, [sessionId, connected, treeSignal, reloadSignal, transport, treeRefresh]);
  const treeWorkspaceId = tree?.snapshot.workspaceId;
  useEffect(() => {
    if (!treeWorkspaceId || !connected) return;
    let active = true;
    const load = () => void Promise.all([
      client.request("workItem.list", { workspaceId: treeWorkspaceId }),
      client.request("work.list", { workspaceId: treeWorkspaceId })
    ]).then(([workItems, requests]) => { if (active) setWork({ workspaceId: treeWorkspaceId, items: workItems, requests }); }, () => undefined);
    load();
    const unsubscribe = client.subscribe((event) => { if (event.type === "workItems.changed" || event.type === "workRequests.changed") load(); });
    return () => { active = false; unsubscribe(); };
  }, [client, connected, treeWorkspaceId]);

  const snapshot = tree?.sessionId === sessionId ? tree?.snapshot : undefined;
  const relevantWork = work && work.workspaceId === snapshot?.workspaceId ? work : undefined;
  const supervisors = useMemo(() => new Set((relevantWork?.requests ?? []).flatMap((request) => request.supervisor?.sessionId ? [request.supervisor.sessionId] : [])), [relevantWork]);
  const branches = useMemo(() => snapshot ? treeBranches(snapshot, supervisors) : [], [snapshot, supervisors]);
  const treeSession = sessionId ? sidebar.findSession(snapshot?.treeId ?? sessionId) ?? cache?.sessions.find((entry) => entry.sessionId === sessionId) : undefined;
  const domain = store.getDomainReadModel();
  const describeBranch = (branch: TreeBranch): BranchDetail => {
    const item = relevantWork?.items.find((entry) => entry.run.sessionId === branch.sessionId);
    const request = relevantWork?.requests.find((entry) => entry.workerSessionId === branch.sessionId);
    const session = domain.getSession(branch.sessionId);
    const waiting = session?.status === "awaiting_approval" ? t("session.statusAwaitingApproval") : undefined;
    const time = formatRelativeActivityAge(session?.updatedAt ?? item?.updatedAt);
    if (item) return { marker: "W", title: item.title, time, detail: [statusLabel(item.status), waiting ?? branch.lastLabel].filter(Boolean).join(" · ") };
    if (request) return { marker: t("mobile.branches.preparation"), title: request.scope || t("work.preparation"), time, detail: waiting ?? branch.lastLabel };
    if (branch.sessionId === snapshot?.treeId) {
      return { title: [t("mobile.branches.mainline"), treeSession?.title].filter(Boolean).join(" · "), time, detail: waiting ?? branch.lastLabel };
    }
    return { title: branch.firstLabel ?? t("mobile.session"), time, detail: waiting ?? branch.lastLabel };
  };
  const workspaceLabel = (id?: string) => workspaces.find((w) => w.workspaceId === id)?.label;

  if (connection === "unauthorized") return <EmptyState title={t("mobile.unauthorized")} hint={t("mobile.unauthorizedHint")} action={<Button onClick={reset}>{t("mobile.repair")}</Button>} />;
  const covered = Boolean(sessionId) && !leaving;
  const dragging = swipe.offset !== undefined;
  return <>
    <section className="vm-mobile-layer" data-level="list" data-covered={covered && !dragging ? "" : undefined} aria-hidden={covered || undefined}
      style={dragging ? { transform: `translateX(calc(-28% + ${(swipe.offset ?? 0) * 0.28}px))`, transition: "none" } : undefined}>
      <ListHeader title={listTab === "inbox" ? "Inbox" : t("mobile.session")} desktopName={desktopName} connected={connected}>
        {listTab === "sessions" && workspaces.length > 1 && <ChoiceChips label={t("mobile.workspaceFilter")} value={workspaceFilter} onChange={setWorkspaceFilter}
          items={[{ value: "", label: t("mobile.allWorkspaces") }, ...workspaces.map((w) => ({ value: w.workspaceId, label: w.label }))]} />}
      </ListHeader>
      <div className="vm-mobile-scroll">
        {listTab === "inbox"
          ? <MobileInbox items={items} error={inboxError} loading={inboxLoading && !items.length} route={route.page === "inbox" ? route : { page: "inbox" }} client={client} refresh={refreshInbox} openSession={openSession} />
          : workspaceError || (connected && sidebar.error) ? <EmptyState title={t("mobile.sessionsFailed")} hint={workspaceError ?? sidebar.error} action={<Button onClick={() => { void refreshWorkspaces(); void sidebar.reload(); }}>{t("common.retry")}</Button>} />
            : !sessions.length ? <EmptyState title={sidebar.loading || !connected ? t("mobile.loadingSessions") : t("mobile.noSessions")} />
              : <ul>{sessions.map((s) => <li key={s.sessionId}>
                <ListRow onClick={() => openSession(s.sessionId)} title={s.title} leading={<><StatusDot status={s.statusDot} />{s.role && s.role !== "design-partner" && <Badge>{roleLabel(s.role) ?? s.role}</Badge>}</>}
                  meta={!workspaceFilter ? workspaceLabel(s.workspaceId) : undefined} trailing={formatRelativeActivityAge(s.activityAt ?? s.lastCompletedTurnAt)} />
              </li>)}</ul>}
      </div>
      <TabBar label={t("mobile.navigation")} selected={listTab} onSelect={selectTab} items={[
        { id: "sessions", label: t("mobile.session"), icon: MessageSquare },
        { id: "inbox", label: "Inbox", icon: InboxIcon, badge: items.length }
      ]} />
    </section>
    {sessionId && <section className="vm-mobile-layer" data-level="session" data-leaving={leaving ? "" : undefined} {...swipe.handlers}
      style={dragging ? { transform: `translateX(${swipe.offset}px)`, transition: "none" } : undefined}>
      <MobileSessionPane sessionId={sessionId} store={store} transport={transport} reloadSignal={reloadSignal} disabled={!connected}
        onVisiblePathChange={onVisiblePathChange} draftCache={runtime.drafts} branchSessionId={branchSessionId}
        title={treeSession?.title ?? domain.getSession(sessionId)?.title ?? t("mobile.session")}
        workspaceLabel={workspaceLabel(snapshot?.workspaceId ?? treeSession?.workspaceId)}
        backLabel={t("mobile.back")} onBack={closeSession}
        branches={snapshot ? { count: branches.length, status: branchesStatus(branches) } : undefined}
        onOpenBranches={() => setBranchSheet(true)} />
      {branchSheet && <BranchSheet branches={branches} current={currentBranch} describe={describeBranch} loading={!snapshot} error={treeError}
        onClose={() => setBranchSheet(false)}
        onSelect={(id) => { setBranchSessionId(id); setBranchSheet(false); }} />}
    </section>}
  </>;
}

export function MobileApp() {
  useVisualViewportHeight();
  const [token, setToken] = useState(savedToken);
  return <div className="vm-mobile">{token ? <ConnectedApp key={token} token={token} reset={() => {
    try { localStorage.removeItem(credentialKey); localStorage.removeItem(cacheKey); } catch { /* Storage can be disabled by the browser. */ }
    setToken(undefined);
  }} /> : <Pairing paired={setToken} />}</div>;
}
