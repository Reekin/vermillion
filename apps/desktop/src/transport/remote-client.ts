import {
  safeParseSessionEventPush, safeParseSessionEventPushBatch, safeParseSessionRpcResponse,
  type SessionClientApi, type SessionEventHandler, type SessionRpcRequest
} from "@vermillion/shared";
import type { WorkbenchRpcResponse } from "@vermillion/workbench/client";

export type RemoteConnectionState = "connecting" | "connected" | "disconnected" | "unauthorized";
export type RemoteClientOptions = {
  url?: string;
  requestTimeoutMs?: number;
  historyTimeoutMs?: number;
  /** Clear cached windows, hydrate the store snapshot, and return its cursor. */
  onReplayGap?: () => Promise<string | undefined>;
};

export function createRemoteClient(token: string, options: RemoteClientOptions = {}) {
  const url = options.url ?? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/socket`;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  let socket: WebSocket | undefined;
  let authenticated = false;
  let disposed = false;
  let state: RemoteConnectionState = "disconnected";
  let serial = 0;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connection: Promise<void> | undefined;
  let rejectConnection: ((error: Error) => void) | undefined;
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(state: RemoteConnectionState) => void>();
  const workbenchListeners = new Set<(event: unknown) => void>();
  const pending = new Map<string, { channel: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  type Subscription = { id: string; params: Parameters<SessionClientApi["subscribe"]>[0]; handler: SessionEventHandler; cursor?: string; active: boolean };
  const subscriptions = new Map<string, Subscription>();
  const nextId = () => `remote-${++serial}`;
  const setState = (next: RemoteConnectionState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const failPending = (error: Error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const rpc = (channel: "session" | "workbench", request: unknown, deadlineMs = timeoutMs): Promise<unknown> => {
    if (!authenticated || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Desktop is disconnected"));
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Remote request timed out; its outcome may be unknown. Refresh before retrying."));
      }, deadlineMs);
      pending.set(id, { channel, resolve, reject, timer });
      try { socket!.send(JSON.stringify({ channel, id, request })); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  };
  const request: SessionClientApi["request"] = async (payload) => {
    const readsHistory = payload.method === "chatTree.get" || payload.method === "sessionBrowser.open"
      || payload.method === "sessionBrowser.loadOlder"
      || (payload.method === "sessionBrowser.runAction" && payload.params.action === "resume")
      || (payload.method === "runtime.command" && payload.params.envelope.command.type === "resumeSession");
    const raw = await rpc("session", payload, readsHistory ? options.historyTimeoutMs ?? 120_000 : timeoutMs);
    const parsed = safeParseSessionRpcResponse(raw);
    if (!parsed.success) throw new Error("Invalid remote session response");
    if (parsed.data.id !== payload.id || parsed.data.method !== payload.method) throw new Error("Remote session response mismatch");
    return parsed.data;
  };
  const workbenchRequest = async (payload: { method: string; params: unknown }): Promise<WorkbenchRpcResponse> => {
    const response = await rpc("workbench", payload);
    if (typeof response !== "object" || response === null || !("ok" in response)) {
      throw new Error("Invalid remote workbench response");
    }
    if (response.ok === true && "result" in response) return { ok: true, result: response.result };
    if (response.ok === false && "error" in response && typeof response.error === "string") return { ok: false, error: response.error };
    throw new Error("Invalid remote workbench response");
  };
  const checkedRequest = async (payload: SessionRpcRequest) => {
    const response = await request(payload);
    if (!response.ok) throw new Error(response.error.message);
    return response;
  };
  const deliver: SessionEventHandler = (push) => {
    const subscription = subscriptions.get(push.subscriptionId);
    if (!subscription?.active) return;
    subscription.handler(push);
    subscription.cursor = push.envelope.cursor ?? subscription.cursor;
  };
  const subscribeRemote = async (subscription: Subscription) => {
    await checkedRequest({ id: nextId(), method: "events.subscribe", params: { ...subscription.params, subscriptionId: subscription.id, fromCursor: subscription.cursor } });
  };
  const restore = async (current: WebSocket) => {
    let snapshot: Promise<string | undefined> | undefined;
    for (const subscription of subscriptions.values()) {
      if (!subscription.active || socket !== current) continue;
      if (subscription.cursor) {
        const replay = await checkedRequest({ id: nextId(), method: "events.replay", params: { fromCursor: subscription.cursor, filter: subscription.params.filter } });
        if (replay.method !== "events.replay") throw new Error("Invalid replay response");
        if (replay.result.status === "gap") {
          if (!options.onReplayGap) throw new Error("Event history expired; snapshot recovery is required");
          snapshot ??= options.onReplayGap();
          subscription.cursor = await snapshot;
        } else {
          for (const envelope of replay.result.envelopes) deliver({ channel: "session.events", subscriptionId: subscription.id, envelope });
        }
      }
      if (subscription.active && socket === current) await subscribeRemote(subscription);
    }
  };
  const scheduleReconnect = () => {
    if (disposed || state === "unauthorized" || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect().catch(() => undefined);
    }, Math.min(1000 * 2 ** attempt++, 15_000));
  };
  const disconnect = (error: Error, unauthorized = false) => {
    const previous = socket;
    socket = undefined;
    authenticated = false;
    clearTimeout(authTimer);
    rejectConnection?.(error);
    rejectConnection = undefined;
    connection = undefined;
    failPending(error);
    previous?.close();
    setState(unauthorized ? "unauthorized" : "disconnected");
    scheduleReconnect();
  };
  function connect(): Promise<void> {
    if (disposed) return Promise.reject(new Error("Remote client disposed"));
    if (state === "unauthorized") return Promise.reject(new Error("Pairing is no longer authorized"));
    if (state === "connected") return Promise.resolve();
    if (connection) return connection;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    setState("connecting");
    connection = new Promise<void>((resolve, reject) => {
      rejectConnection = reject;
      let current: WebSocket;
      try { current = new WebSocket(url); } catch (error) { reject(error); return; }
      socket = current;
      authTimer = setTimeout(() => { if (socket === current) disconnect(new Error("Remote authentication timed out")); }, timeoutMs);
      current.onopen = () => { if (socket === current) current.send(JSON.stringify({ channel: "auth", token })); };
      current.onclose = (event) => { if (socket === current) disconnect(new Error(event.code === 1008 ? "Pairing is no longer authorized" : "Desktop disconnected; pending operation outcome may be unknown"), event.code === 1008); };
      current.onerror = () => { if (socket === current) disconnect(new Error("Remote connection failed")); };
      current.onmessage = (event) => {
        if (socket !== current) return;
        let frame: { channel?: string; ok?: boolean; id?: string; response?: unknown; event?: unknown };
        try { frame = JSON.parse(String(event.data)); } catch { disconnect(new Error("Invalid remote frame")); return; }
        if (frame.channel === "auth" && !authenticated) {
          if (!frame.ok) { disconnect(new Error("Pairing is no longer authorized"), true); return; }
          authenticated = true;
          clearTimeout(authTimer);
          void restore(current).then(() => {
            if (socket !== current) return;
            attempt = 0;
            connection = undefined;
            rejectConnection = undefined;
            setState("connected");
            resolve();
          }, (error: unknown) => { if (socket === current) disconnect(error instanceof Error ? error : new Error(String(error))); });
          return;
        }
        if (!authenticated) return;
        if (frame.channel === "session.event") {
          const batch = safeParseSessionEventPushBatch(frame.event);
          if (batch.success) { for (const push of batch.data.pushes) deliver(push); return; }
          const push = safeParseSessionEventPush(frame.event);
          if (push.success) deliver(push.data);
        } else if (frame.channel === "workbench.event") {
          for (const listener of workbenchListeners) listener(frame.event);
        } else if (frame.id) {
          const request = pending.get(frame.id);
          if (!request || request.channel !== frame.channel) return;
          pending.delete(frame.id);
          clearTimeout(request.timer);
          request.resolve(frame.response);
        }
      };
    });
    // Constructor failures follow the same retry lifecycle as failed handshakes.
    void connection.catch(() => { if (!socket && state === "connecting") disconnect(new Error("Unable to open remote connection")); });
    return connection;
  }
  const session: SessionClientApi = {
    request,
    subscribe: async (params, handler) => {
      const id = params.subscriptionId ?? nextId();
      if (subscriptions.has(id)) throw new Error(`Duplicate subscription: ${id}`);
      const subscription: Subscription = { id, params, handler, cursor: params.fromCursor, active: true };
      subscriptions.set(id, subscription);
      try { await subscribeRemote(subscription); }
      catch (error) { subscriptions.delete(id); throw error; }
      return { subscriptionId: id, unsubscribe: async () => {
        if (!subscription.active) return;
        subscription.active = false;
        subscriptions.delete(id);
        if (authenticated) await checkedRequest({ id: nextId(), method: "events.unsubscribe", params: { subscriptionId: id } });
      } };
    }
  };
  // Mobile browsers suspend sockets and timers in the background. A fresh socket
  // on foreground/pageshow replays each cursor even when the old socket looks open.
  const recover = () => {
    if (disposed || state === "unauthorized" || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    disconnect(new Error("Refreshing remote connection"));
    void connect().catch(() => undefined);
  };
  const page = typeof window === "undefined" ? undefined : window;
  const doc = typeof document === "undefined" ? undefined : document;
  page?.addEventListener("online", recover);
  page?.addEventListener("pageshow", recover);
  doc?.addEventListener("visibilitychange", recover);
  return {
    session,
    workbench: {
      request: workbenchRequest,
      onEvent: (listener: (event: unknown) => void) => { workbenchListeners.add(listener); return () => { workbenchListeners.delete(listener); }; }
    },
    connect,
    getConnectionState: () => state,
    subscribeConnection: (listener: (state: RemoteConnectionState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(reconnectTimer);
      page?.removeEventListener("online", recover);
      page?.removeEventListener("pageshow", recover);
      doc?.removeEventListener("visibilitychange", recover);
      subscriptions.clear();
      disconnect(new Error("Remote client disposed"));
      listeners.clear();
      workbenchListeners.clear();
    }
  };
}
