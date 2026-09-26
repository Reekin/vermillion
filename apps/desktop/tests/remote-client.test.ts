import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { SessionRpcRequest } from "@vermillion/shared";
import { createWorkbenchClient } from "@vermillion/workbench/client";
import { createRemoteClient } from "../src/transport/remote-client.js";
import { startRemoteGateway } from "../src/electron/remote/gateway.js";
import { RemoteDevices } from "../src/electron/remote/devices.js";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  reply(frame: any, result: unknown) {
    this.receive({ channel: frame.channel, id: frame.id, response: frame.channel === "session"
      ? { id: frame.request.id, method: frame.request.method, ok: true, result }
      : { ok: true, result } });
  }
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const envelope = (cursor: string) => ({ eventId: cursor, cursor, occurredAt: "2026-09-26T00:00:00.000Z", event: {
  type: "message.delta", sessionId: "s", turnId: "t", messageId: "m", delta: cursor
} });
const latest = () => FakeSocket.instances.at(-1)!;
const clients: ReturnType<typeof createRemoteClient>[] = [];
function client(options: Parameters<typeof createRemoteClient>[1] = {}) {
  const result = createRemoteClient("secret", { url: "wss://desktop.test/api/socket", ...options });
  clients.push(result);
  return result;
}
async function connected(options: Parameters<typeof createRemoteClient>[1] = {}) {
  const c = client(options);
  const connecting = c.connect();
  latest().open();
  expect(latest().sent).toEqual([{ channel: "auth", token: "secret" }]);
  latest().receive({ channel: "auth", ok: true });
  await connecting;
  return c;
}
async function subscribe(c: ReturnType<typeof client>, id: string, handler = vi.fn()) {
  const promise = c.session.subscribe({ subscriptionId: id, fromCursor: "start" }, handler);
  latest().reply(latest().sent.at(-1), { subscriptionId: id });
  return { subscription: await promise, handler };
}

describe("remote browser client", () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSocket.instances = []; vi.stubGlobal("WebSocket", FakeSocket); });
  afterEach(() => { for (const c of clients.splice(0)) c.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("authenticates before RPC, correlates out-of-order responses and multiplexes workbench events", async () => {
    const c = await connected();
    expect(createWorkbenchClient(c.workbench)).toBeDefined();
    const a = c.workbench.request({ method: "inbox.list", params: {} });
    const b = c.session.request({ id: "list", method: "session.list", params: {} });
    const frames = latest().sent.slice(1);
    latest().reply(frames[1], { sessions: [] });
    latest().reply(frames[0], { items: ["inbox"] });
    expect(await a).toEqual({ ok: true, result: { items: ["inbox"] } });
    expect(await b).toMatchObject({ id: "list", result: { sessions: [] } });
    const listener = vi.fn();
    const remove = c.workbench.onEvent(listener);
    latest().receive({ channel: "workbench.event", event: { type: "inbox.changed" } });
    remove();
    latest().receive({ channel: "workbench.event", event: {} });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "inbox.changed" });
  });

  it.each([null, {}, { ok: true }, { ok: false, error: {} }, { ok: "true", result: [] }])("rejects malformed workbench envelopes %#", async (response) => {
    const c = await connected();
    const pending = c.workbench.request({ method: "inbox.list", params: {} });
    const frame = latest().sent.at(-1);
    latest().receive({ channel: "workbench", id: frame.id, response });
    await expect(pending).rejects.toThrow("Invalid remote workbench response");
  });

  it("preserves a valid workbench failure envelope", async () => {
    const c = await connected();
    const pending = c.workbench.request({ method: "inbox.list", params: {} });
    const frame = latest().sent.at(-1);
    latest().receive({ channel: "workbench", id: frame.id, response: { ok: false, error: "Remote method denied" } });
    expect(await pending).toEqual({ ok: false, error: "Remote method denied" });
  });

  it("allows 120 seconds for history while ordinary requests retain their 30-second deadline", async () => {
    const c = await connected();
    const histories: SessionRpcRequest[] = [
      { id: "tree", method: "chatTree.get", params: { sessionId: "s" } },
      { id: "open", method: "sessionBrowser.open", params: { sessionId: "s" } },
      { id: "older", method: "sessionBrowser.loadOlder", params: { sessionId: "s" } },
      { id: "action", method: "sessionBrowser.runAction", params: { sessionId: "s", action: "resume" } },
      { id: "resume", method: "runtime.command", params: { envelope: { commandId: "resume", issuedAt: "2026-09-26T00:00:00.000Z", command: { type: "resumeSession", sessionId: "s" } } } }
    ];
    const settled = vi.fn();
    const historyPromises = histories.map((request) => c.session.request(request).catch((error) => { settled(); return error; }));
    const ordinary = expect(c.workbench.request({ method: "inbox.list", params: {} })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await ordinary;
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(histories.length);
    for (const error of await Promise.all(historyPromises)) expect(error.message).toContain("timed out");
  });

  it("registers before early pushes, routes independent subscriptions, and replays cursors on reconnect", async () => {
    const c = await connected();
    const handler = vi.fn();
    const subscribing = c.session.subscribe({ subscriptionId: "one", fromCursor: "start" }, handler);
    latest().receive({ channel: "session.event", event: { channel: "session.events", subscriptionId: "one", envelope: envelope("c1") } });
    latest().reply(latest().sent.at(-1), { subscriptionId: "one" });
    await subscribing;
    const second = await subscribe(c, "two");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.handler).not.toHaveBeenCalled();
    latest().close();
    await second.subscription.unsubscribe();
    const connecting = c.connect();
    latest().open(); latest().receive({ channel: "auth", ok: true });
    expect(latest().sent.at(-1).request).toMatchObject({ method: "events.replay", params: { fromCursor: "c1" } });
    latest().reply(latest().sent.at(-1), { status: "ok", replayed: 1, fromCursor: "c1", envelopes: [envelope("c2")] });
    await tick();
    expect(latest().sent.at(-1).request).toMatchObject({ method: "events.subscribe", params: { subscriptionId: "one", fromCursor: "c2" } });
    latest().reply(latest().sent.at(-1), { subscriptionId: "one" });
    await connecting;
    expect(handler).toHaveBeenCalledTimes(2);
    expect(latest().sent.some((frame) => frame.request?.params?.subscriptionId === "two")).toBe(false);
  });

  it("awaits snapshot recovery on replay gaps before resubscribing", async () => {
    let hydrate!: (cursor: string) => void;
    const onReplayGap = vi.fn(() => new Promise<string>((resolve) => { hydrate = resolve; }));
    const c = await connected({ onReplayGap });
    await subscribe(c, "one");
    latest().close();
    const connecting = c.connect();
    latest().open(); latest().receive({ channel: "auth", ok: true });
    latest().reply(latest().sent.at(-1), { status: "gap", reason: "cursor_not_found", replayed: 0, fromCursor: "start", envelopes: [] });
    await tick();
    expect(onReplayGap).toHaveBeenCalledTimes(1);
    expect(c.getConnectionState()).toBe("connecting");
    hydrate("snapshot-cursor");
    await tick();
    expect(latest().sent.at(-1).request.params.fromCursor).toBe("snapshot-cursor");
    latest().reply(latest().sent.at(-1), { subscriptionId: "one" });
    await connecting;
    expect(c.getConnectionState()).toBe("connected");
  });

  it("bounds pending requests and never resends a write after a connection loss", async () => {
    const c = await connected({ requestTimeoutMs: 100 });
    const timed = c.workbench.request({ method: "inbox.list", params: {} });
    const timedExpectation = expect(timed).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await timedExpectation;
    const write = c.workbench.request({ method: "inbox.resolve", params: { id: "item" } });
    const rejected = expect(write).rejects.toThrow("outcome may be unknown");
    latest().close();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    latest().open(); latest().receive({ channel: "auth", ok: true });
    await tick();
    expect(latest().sent).toEqual([{ channel: "auth", token: "secret" }]);
    expect(c.getConnectionState()).toBe("connected");
  });

  it("stops reconnecting on rejected authentication and cleans all pending work on disposal", async () => {
    const c = client();
    const connection = c.connect();
    const rejected = expect(connection).rejects.toThrow("authorized");
    latest().open(); latest().close(1008);
    await rejected;
    expect(c.getConnectionState()).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    const other = await connected();
    const pending = other.workbench.request({ method: "inbox.list", params: {} });
    const disposed = expect(pending).rejects.toThrow("disposed");
    other.dispose();
    await disposed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes a suspended socket on document foreground and removes lifecycle listeners", async () => {
    const doc = new EventTarget();
    Object.assign(doc, { visibilityState: "visible" });
    const page = new EventTarget();
    vi.stubGlobal("document", doc); vi.stubGlobal("window", page);
    const c = await connected();
    const first = latest();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(first.readyState).toBe(3);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().open(); latest().receive({ channel: "auth", ok: true });
    await tick();
    c.dispose();
    doc.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("pageshow"));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("speaks the real gateway browser-auth and RPC protocol and observes revocation", async () => {
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", WebSocket);
    const directory = await mkdtemp(join(tmpdir(), "vermillion-mobile-client-"));
    const devices = new RemoteDevices(directory);
    await devices.load();
    const pairing = devices.pair("https://desktop.test", "Desktop");
    const paired = await devices.exchange(pairing.code, "Phone");
    const gateway = await startRemoteGateway({
      devices, publicUrl: "https://desktop.test", desktopName: "Desktop", assetsDir: directory,
      summary: async () => ({}),
      createRouter: () => ({
        handleRequest: async (value) => {
          const request = value as { id: string; method: string };
          return { ...request, ok: true, result: { sessions: [] } };
        },
        dispose: async () => {}
      }),
      workbenchRequest: async () => ({ ok: true, result: { items: ["actual gateway"] } }),
      subscribeWorkbench: () => () => {}
    });
    const c = createRemoteClient(paired.token, { url: `ws://127.0.0.1:${gateway.port}/api/socket` });
    clients.push(c);
    try {
      await c.connect();
      expect(c.getConnectionState()).toBe("connected");
      expect(await c.session.request({ id: "real-list", method: "session.list", params: {} }))
        .toMatchObject({ result: { sessions: [] } });
      expect(await c.workbench.request({ method: "inbox.list", params: {} }))
        .toEqual({ ok: true, result: { items: ["actual gateway"] } });
      await devices.revoke(paired.device.deviceId);
      gateway.revoke(paired.device.deviceId);
      await vi.waitFor(() => expect(c.getConnectionState()).toBe("disconnected"));
      await expect(c.connect()).rejects.toThrow("authorized");
      expect(c.getConnectionState()).toBe("unauthorized");
    } finally {
      c.dispose();
      await gateway.close();
      await devices.revoke("drain");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
