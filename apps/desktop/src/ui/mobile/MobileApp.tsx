import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createWorkbenchClient, type InboxItem, type Workspace } from "@vermillion/workbench/client";
import { createRendererStore } from "../../store/store.js";
import { createDesktopTransport } from "../../transport/desktop-transport.js";
import { createRemoteClient } from "../../transport/remote-client.js";
import { connectDesktopTransportToStore } from "../../transport/store-bridge.js";
import { MobileSessionPane } from "../chat-shell/MobileSessionPane.js";
import { formatRelativeActivityAge } from "../chat-shell/index.js";
import { useSessionSidebar } from "../app/use-session-sidebar.js";
import { roleLabel } from "../app/components/workflow-display.js";
import { Badge, Button, EmptyState, Field, InlineNotice, ListRow, PanelHeader, StatusDot } from "../app/components/ui.js";
import { MobileInbox } from "./MobileInbox.js";
import { parseMobileRoute, sessionHash } from "./navigation.js";

const credentialKey = "vermillion.remote.token";
function savedToken(): string | undefined {
  if (window.__VERMILLION_REMOTE__?.token) return window.__VERMILLION_REMOTE__.token;
  try { return localStorage.getItem(credentialKey) || undefined; } catch { return undefined; }
}

function Pairing({ paired }: { paired: (token: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("手机浏览器");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pair = async () => {
    setBusy(true); setError(undefined);
    try {
      const response = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim(), name: name.trim() }) });
      const result = await response.json() as { token?: string; error?: string };
      if (!response.ok || !result.token) throw new Error(result.error ?? "配对失败");
      localStorage.setItem(credentialKey, result.token);
      paired(result.token);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法连接桌面"); }
    finally { setBusy(false); }
  };
  return <main className="vm-mobile-pair">
    <h1 className="text-title font-semibold text-strong">连接桌面</h1>
    <p className="mt-2 text-body text-muted-foreground">在桌面设置的远程访问中生成配对码。</p>
    <form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <Field label="设备名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
      <Field label="配对码" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" pattern="[0-9]{8}" maxLength={8} autoComplete="one-time-code" required />
      {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
      <Button variant="primary" type="submit" className="w-full" disabled={busy || !name.trim() || code.trim().length !== 8}>{busy ? "正在配对" : "配对"}</Button>
    </form>
  </main>;
}

function ConnectedApp({ token, reset }: { token: string; reset: () => void }) {
  const [runtime] = useState(() => {
    const store = createRendererStore();
    const remote = createRemoteClient(token, { onReplayGap: async () => {
      store.clearKnownSessionWindows();
      const result = await transport.domain.snapshot();
      store.hydrateSnapshot(result.snapshot, result.cursor);
      return result.cursor;
    } });
    const transport = createDesktopTransport(remote.session);
    return { remote, client: createWorkbenchClient(remote.workbench), transport, store };
  });
  const { remote, client, transport, store } = runtime;
  const connection = useSyncExternalStore(remote.subscribeConnection, remote.getConnectionState);
  const [route, setRoute] = useState(() => parseMobileRoute(location.hash));
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [inboxError, setInboxError] = useState<string>();
  const [inboxLoading, setInboxLoading] = useState(true);
  const [reloadSignal, setReloadSignal] = useState(0);
  const visibleScope = useRef({ turnIds: new Set<string>(), sessionId: "" });
  const onVisiblePathChange = useCallback((turnIds: string[], sessionId: string) => {
    visibleScope.current = { turnIds: new Set(turnIds), sessionId };
  }, []);
  const sidebar = useSessionSidebar({ transport, store, workspaceIds: workspaces.filter((w) => !workspaceFilter || w.workspaceId === workspaceFilter).map((w) => w.workspaceId) });
  const openSession = (id: string) => { location.hash = sessionHash(id); };
  const refreshInbox = async () => {
    try { setItems(await client.request("inbox.list", {})); setInboxError(undefined); }
    catch (cause) { if (remote.getConnectionState() === "connected") setInboxError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setInboxLoading(false); }
  };
  useEffect(() => {
    const changed = () => setRoute(parseMobileRoute(location.hash));
    window.addEventListener("hashchange", changed);
    void remote.connect().catch(() => undefined);
    return () => { window.removeEventListener("hashchange", changed); remote.dispose(); };
  }, [remote]);
  useEffect(() => {
    if (connection !== "connected") return;
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
    void client.request("workspace.list", {}).then((value) => {
      if (!cancelled) { setWorkspaces(value); setWorkspaceError(undefined); }
    }).catch((cause) => { if (!cancelled) setWorkspaceError(String(cause)); });
    void refreshInbox();
    void sidebar.reload();
    setReloadSignal((value) => value + 1);
    return () => { cancelled = true; void subscription?.unsubscribe().catch(() => undefined); };
  // Refresh reads after each authenticated connection; never retry mutations here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, client, transport, store]);
  useEffect(() => client.subscribe((event) => {
    if (["decisions.changed", "workItems.changed", "actions.changed", "runs.changed", "workRequests.changed"].includes(event.type)) void refreshInbox();
  }), [client]);

  if (connection === "unauthorized") return <EmptyState title="设备授权已失效" hint="请在桌面重新生成配对码。" action={<Button onClick={reset}>重新配对</Button>} />;
  const session = route.page === "session" ? sidebar.findSession(route.sessionId) : undefined;
  return <main className="vm-mobile-layout">
    <header className="vm-mobile-header">
      {window.webkit?.messageHandlers?.vermillion && <Button variant="ghost" onClick={() => window.webkit?.messageHandlers?.vermillion?.postMessage({ type: "exit" })}>桌面列表</Button>}
      {route.page === "session" && <Button variant="ghost" onClick={() => { location.hash = "#/sessions"; }}>返回</Button>}
      <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-strong">{route.page === "session" ? session?.title ?? "会话" : "Vermillion"}</h1>
      <span role="status" className="shrink-0 text-caption text-muted-foreground">{connection === "connected" ? "" : "正在连接"}</span>
    </header>
    <nav className="vm-mobile-nav" aria-label="手机导航">
      <Button variant={route.page !== "inbox" ? "primary" : "ghost"} onClick={() => { location.hash = "#/sessions"; }}>会话列表</Button>
      <Button variant={route.page === "inbox" ? "primary" : "ghost"} onClick={() => { location.hash = "#/inbox"; }}>Inbox{items.length ? " · " + items.length : ""}</Button>
    </nav>
    {route.page === "session" ? <MobileSessionPane sessionId={route.sessionId} store={store} transport={transport} reloadSignal={reloadSignal} disabled={connection !== "connected"} onVisiblePathChange={onVisiblePathChange} /> : route.page === "inbox" ?
      <MobileInbox items={items} error={inboxError} loading={inboxLoading} route={route} client={client} refresh={refreshInbox} openSession={openSession} /> : <>
        <PanelHeader title="会话"><Field kind="select" aria-label="筛选 workspace" value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
          <option value="">全部</option>{workspaces.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{w.label}</option>)}
        </Field></PanelHeader>
        {workspaceError || (connection === "connected" && sidebar.error) ? <EmptyState title="会话列表加载失败" hint={workspaceError ?? sidebar.error} action={<Button onClick={() => void sidebar.reload()}>重试</Button>} /> :
          !sidebar.sessions.length ? <EmptyState title={sidebar.loading || connection !== "connected" ? "正在读取会话" : "暂无会话"} /> :
            <ul className="min-h-0 flex-1 overflow-auto">{sidebar.sessions.map((s) => <li key={s.sessionId}>
              <ListRow onClick={() => openSession(s.sessionId)} title={s.title} leading={<><StatusDot status={s.statusDot} />{s.role && s.role !== "design-partner" && <Badge>{roleLabel[s.role] ?? s.role}</Badge>}</>}
                meta={!workspaceFilter ? workspaces.find((w) => w.workspaceId === s.workspaceId)?.label : undefined} trailing={formatRelativeActivityAge(s.activityAt ?? s.lastCompletedTurnAt)} />
            </li>)}</ul>}
      </>}
  </main>;
}

export function MobileApp() {
  const [token, setToken] = useState(savedToken);
  return <div className="vm-mobile">{token ? <ConnectedApp key={token} token={token} reset={() => {
    try { localStorage.removeItem(credentialKey); } catch { /* Storage can be disabled by the browser. */ }
    setToken(undefined);
  }} /> : <Pairing paired={setToken} />}</div>;
}
