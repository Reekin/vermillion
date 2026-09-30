import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { SessionShellService } from "@vermillion/desktop-server";
import type { EventEnvelope } from "@vermillion/shared";
import { RemoteDevices, tokenHash } from "../src/electron/remote/devices.js";
import { startRemoteGateway } from "../src/electron/remote/gateway.js";
import { allowRemoteRequest } from "../src/electron/remote/policy.js";
import { createSessionIpcRouter } from "../src/electron/session-ipc-router.js";

const publicUrl = "https://remote.example.test";
const runtime = (command: Record<string, unknown>) => ({
  id: "runtime-request", method: "runtime.command",
  params: { envelope: { commandId: "command-1", command } }
});
const send = { type: "sendUserMessage", sessionId: "session-1", messageId: "message-1", content: "Hello" };

async function withDevices(run: (devices: RemoteDevices, directory: string, advance: (ms: number) => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vermillion-remote-test-"));
  let now = Date.parse("2026-09-26T00:00:00Z");
  const devices = new RemoteDevices(directory, () => now);
  try {
    await devices.load();
    await run(devices, directory, (ms) => { now += ms; });
  } finally {
    // Drain queued connection timestamp writes before removing the fixture.
    await devices.revoke("fixture-drain");
    await rm(directory, { recursive: true, force: true });
  }
}

function client(url: string, token?: string) {
  const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const messages: unknown[] = [];
  ws.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
  return {
    ws,
    async next() {
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      return messages.shift();
    },
    async request(channel: string, request: unknown, id = "request-1") {
      ws.send(JSON.stringify({ channel, id, request }));
      return this.next();
    }
  };
}

async function withGateway(run: (fixture: Awaited<ReturnType<typeof gatewayFixture>>) => Promise<void>) {
  await withDevices(async (devices, directory) => {
    const fixture = await gatewayFixture(devices, directory);
    try { await run(fixture); } finally { await fixture.gateway.close(); }
  });
}

async function gatewayFixture(devices: RemoteDevices, directory: string) {
  const handlers = new Set<(event: EventEnvelope) => void>();
  const workbenchHandlers = new Set<(event: unknown) => void>();
  const service = {
    listSessions: vi.fn(() => []),
    subscribeFromCursor: vi.fn((handler: (event: EventEnvelope) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    }),
    dispose: vi.fn(async () => {})
  };
  const routers: ReturnType<typeof createSessionIpcRouter>[] = [];
  const workbenchRequest = vi.fn(async () => ({ ok: true, result: { items: [] } }));
  const summary = vi.fn(async () => ({ desktopName: "Test desktop", unread: 2 }));
  const gateway = await startRemoteGateway({
    devices, publicUrl, desktopName: "Test desktop", assetsDir: directory, summary,
    workbenchRequest,
    subscribeWorkbench: (push) => {
      workbenchHandlers.add(push);
      return () => { workbenchHandlers.delete(push); };
    },
    createRouter: (onPush) => {
      const router = createSessionIpcRouter({
        service: service as unknown as SessionShellService, onPush, disposeService: false
      });
      vi.spyOn(router, "handleRequest");
      vi.spyOn(router, "dispose");
      routers.push(router);
      return router;
    }
  });
  return {
    gateway, devices, handlers, workbenchHandlers, service, routers, workbenchRequest, summary,
    assetsDir: directory,
    http: `http://127.0.0.1:${gateway.port}`,
    socket: `ws://127.0.0.1:${gateway.port}/api/socket`,
    async pair() {
      const pairing = devices.pair(publicUrl, "Test desktop");
      return devices.exchange(pairing.code, "Test phone");
    }
  };
}

describe("remote device pairing", () => {
  it("exchanges once, persists only token hashes, and reloads authentication", async () => {
    await withDevices(async (devices, directory) => {
      const pairing = devices.pair(publicUrl, "Test desktop");
      const result = await devices.exchange(pairing.code, " Phone ");
      await expect(devices.exchange(pairing.code, "Other phone")).rejects.toThrow("The pairing code is invalid or expired.");
      const content = await readFile(join(directory, "devices.json"), "utf8");
      expect(content.includes(result.token)).toBe(false);
      const stored = JSON.parse(content);
      expect(stored[0].tokenHash === tokenHash(result.token)).toBe(true);
      expect(stored[0]).not.toHaveProperty("token");
      expect(result.device.name).toBe("Phone");
      expect(result.device).not.toHaveProperty("tokenHash");
      expect(devices.list()[0]).not.toHaveProperty("tokenHash");
      const reloaded = new RemoteDevices(directory);
      await reloaded.load();
      expect(reloaded.authenticate(result.token)).toEqual(result.device);
      await reloaded.revoke(result.device.deviceId);
      expect(reloaded.authenticate(result.token)).toBeUndefined();
    });
  });

  it("expires at ten minutes using the injected clock", async () => {
    await withDevices(async (devices, _directory, advance) => {
      const pairing = devices.pair(publicUrl, "Test desktop");
      expect(pairing.expiresAt).toBe("2026-09-26T00:10:00.000Z");
      advance(600_000);
      await expect(devices.exchange(pairing.code, "Phone")).rejects.toThrow("The pairing code is invalid or expired.");
      expect(devices.list()).toEqual([]);
    });
  });

  it("allows four wrong attempts but invalidates the code after the fifth", async () => {
    await withDevices(async (devices) => {
      let pairing = devices.pair(publicUrl, "Test desktop");
      for (let n = 0; n < 4; n++) await expect(devices.exchange("wrong", "Phone")).rejects.toThrow();
      await devices.exchange(pairing.code, "Phone");
      pairing = devices.pair(publicUrl, "Test desktop");
      for (let n = 0; n < 5; n++) await expect(devices.exchange("wrong", "Phone")).rejects.toThrow();
      await expect(devices.exchange(pairing.code, "Phone")).rejects.toThrow("The pairing code is invalid or expired.");
      expect(devices.list()).toHaveLength(1);
    });
  });
});

describe("remote request policy", () => {
  it.each([
    { type: "initialize" }, { type: "createSession", engineId: "unused" },
    { type: "disposeSession", sessionId: "session-1" },
    { type: "archiveSession", sessionId: "session-1" },
    { type: "forkSession", sessionId: "session-1" },
    { ...send, cwd: "/private" }, { ...send, developerInstructions: "override" },
    { ...send, deliveredDeveloperInstructions: "override" }, { ...send, execution: { modelId: "override" } },
    { ...send, attachments: [{ attachmentId: "file", mimeType: "text/plain", uri: "file:///private" }] }
  ])("denies restricted runtime command %#", (command) => {
    expect(allowRemoteRequest("session", runtime(command))).toBe(false);
  });

  it.each([
    send, { ...send, type: "steerTurn", turnId: "turn-1" },
    { type: "interruptTurn", sessionId: "session-1", turnId: "turn-1" },
    { type: "respondApproval", sessionId: "session-1", requestId: "approval-1", action: "approve" },
    { type: "respondInteraction", sessionId: "session-1", requestId: "interaction-1", action: "submit" }
  ])("permits supported runtime interaction %#", (command) => {
    expect(allowRemoteRequest("session", runtime(command))).toBe(true);
  });
});

describe("remote gateway over HTTP and WebSocket", () => {
  it("pairs over HTTP and requires a valid Bearer header for summary", async () => {
    await withGateway(async (f) => {
      const pairing = f.devices.pair(publicUrl, "Test desktop");
      const exchange = () => fetch(`${f.http}/api/pair`, {
        method: "POST", body: JSON.stringify({ code: pairing.code, name: "Phone" })
      });
      const response = await exchange();
      expect(response.status).toBe(200);
      const { token } = await response.json() as { token: string };
      expect((await exchange()).status).toBe(400);
      for (const headers of [{}, { authorization: "Bearer invalid" }, { authorization: `Basic ${token}` }] as Record<string, string>[]) {
        expect((await fetch(`${f.http}/api/summary`, { headers })).status).toBe(401);
      }
      expect(f.summary).not.toHaveBeenCalled();
      const authorized = await fetch(`${f.http}/api/summary`, { headers: { authorization: `Bearer ${token}` } });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({ desktopName: "Test desktop", unread: 2 });
    });
  });

  it("serves desktop image files to paired devices only, and no other file type", async () => {
    await withGateway(async (f) => {
      const pairing = f.devices.pair(publicUrl, "Test desktop");
      const { token } = await (await fetch(`${f.http}/api/pair`, { method: "POST", body: JSON.stringify({ code: pairing.code, name: "Phone" }) })).json() as { token: string };
      const image = join(f.assetsDir, "shot.png");
      const secret = join(f.assetsDir, "notes.txt");
      await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(secret, "private");
      const read = (file: string, auth?: string) => fetch(`${f.http}/api/image?url=${encodeURIComponent(pathToFileURL(file).href + "?awb_file_mtime=1")}`,
        auth ? { headers: { authorization: `Bearer ${auth}` } } : {});
      expect((await read(image)).status).toBe(401);
      const served = await read(image, token);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect((await read(secret, token)).status).toBe(403);
      expect((await read(join(f.assetsDir, "missing.png"), token)).status).toBe(404);
    });
  });

  it("caches hashed assets for good, revalidates the entry page and compresses both", async () => {
    await withGateway(async (f) => {
      const script = "export const phone = true;\n".repeat(200);
      await mkdir(join(f.assetsDir, "assets"), { recursive: true });
      await writeFile(join(f.assetsDir, "mobile.html"), "<!doctype html><title>phone</title>" + " ".repeat(2000));
      await writeFile(join(f.assetsDir, "assets", "mobile-abc123.js"), script);
      // Raw HTTP so the test sees the encoded body exactly as the phone receives it.
      const get = (path: string, headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((done, fail) => {
        httpRequest(`${f.http}${path}`, { headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        }).on("error", fail).end();
      });
      const asset = await get("/assets/mobile-abc123.js", { "accept-encoding": "gzip, deflate, br" });
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(asset.headers["content-encoding"]).toBe("br");
      expect(brotliDecompressSync(asset.body).toString()).toBe(script);
      const gzip = await get("/assets/mobile-abc123.js", { "accept-encoding": "gzip" });
      expect(gunzipSync(gzip.body).toString()).toBe(script);
      const entry = await get("/", { "accept-encoding": "br" });
      expect(entry.headers["cache-control"]).toBe("no-cache");
      const revalidated = await get("/", { "if-none-match": String(entry.headers.etag) });
      expect(revalidated.status).toBe(304);
      expect((await get("/api/summary", {})).headers["cache-control"]).toBe("no-store");
    });
  });

  it("rejects unauthenticated first requests and invalid tokens before creating subscriptions", async () => {
    await withGateway(async (f) => {
      for (const frame of [{ channel: "auth", token: "invalid" }, { channel: "workbench", id: "unauthorized", request: { method: "inbox.list", params: {} } }]) {
        const c = client(f.socket);
        await once(c.ws, "open");
        const closed = once(c.ws, "close");
        c.ws.send(JSON.stringify(frame));
        expect((await closed)[0]).toBe(1008);
      }
      const invalid = new WebSocket(f.socket, { headers: { authorization: "Bearer invalid" } });
      const status = await new Promise<number>((resolve, reject) => {
        invalid.on("error", () => {});
        invalid.once("open", () => { invalid.close(); reject(new Error("Invalid token was accepted")); });
        invalid.once("unexpected-response", (_request, response) => {
          response.resume(); invalid.terminate(); resolve(response.statusCode!);
        });
      });
      expect(status).toBe(401);
      expect(f.routers).toHaveLength(0);
      expect(f.workbenchHandlers.size).toBe(0);
      expect(f.workbenchRequest).not.toHaveBeenCalled();
    });
  });

  it("authenticates the first frame, forwards inbox/list and workbench events, and denies forbidden commands", async () => {
    await withGateway(async (f) => {
      const paired = await f.pair();
      const c = client(f.socket);
      await once(c.ws, "open");
      expect(f.routers).toHaveLength(0);
      c.ws.send(JSON.stringify({ channel: "auth", token: paired.token }));
      expect(await c.next()).toEqual({ channel: "auth", ok: true });
      for (const request of [runtime({ type: "createSession", engineId: "unused" }), runtime({ ...send, cwd: "/private" })]) {
        expect(await c.request("session", request)).toMatchObject({ response: { ok: false, error: "Remote method denied" } });
      }
      expect(f.routers[0]!.handleRequest).not.toHaveBeenCalled();
      expect(await c.request("workbench", { method: "work.start", params: {} })).toMatchObject({ response: { ok: false } });
      expect(f.workbenchRequest).not.toHaveBeenCalled();
      const inbox = { method: "inbox.list", params: { workspaceId: "workspace-1" } };
      expect(await c.request("workbench", inbox)).toMatchObject({ response: { ok: true, result: { items: [] } } });
      expect(f.workbenchRequest).toHaveBeenCalledWith(inbox);
      expect(await c.request("session", { id: "list", method: "session.list", params: {} }))
        .toMatchObject({ response: { ok: true, result: { sessions: [] } } });
      expect(f.service.listSessions).toHaveBeenCalledTimes(1);
      const event = { type: "issues.changed", workspaceId: "workspace-1" };
      for (const push of f.workbenchHandlers) push(event);
      expect(await c.next()).toEqual({ channel: "workbench.event", event });
    });
  });

  it("uses independent routers and cleans close/revoke/shutdown subscriptions without disposing the shared service", async () => {
    await withGateway(async (f) => {
      const first = await f.pair();
      const second = await f.pair();
      const a = client(f.socket, first.token);
      const b = client(f.socket, second.token);
      expect(await a.next()).toEqual({ channel: "auth", ok: true });
      expect(await b.next()).toEqual({ channel: "auth", ok: true });
      const subscribe = { id: "subscribe", method: "events.subscribe", params: { subscriptionId: "same-id" } };
      expect(await a.request("session", subscribe)).toMatchObject({ response: { ok: true } });
      expect(await b.request("session", subscribe)).toMatchObject({ response: { ok: true } });
      expect(f.routers).toHaveLength(2);
      expect(f.routers[0]).not.toBe(f.routers[1]);
      expect(f.handlers.size).toBe(2);
      expect(f.gateway.connectedDevices()).toBe(2);
      const closed = once(a.ws, "close");
      a.ws.close();
      await closed;
      await vi.waitFor(() => expect(f.handlers.size).toBe(1));
      expect(f.workbenchHandlers.size).toBe(1);
      expect(f.routers[0]!.dispose).toHaveBeenCalledTimes(1);
      expect(f.routers[1]!.dispose).not.toHaveBeenCalled();
      const envelope: EventEnvelope = {
        eventId: "event-1", cursor: "cursor-1", occurredAt: "2026-09-26T00:00:00.000Z",
        event: { type: "message.delta", sessionId: "session-1", turnId: "turn-1", messageId: "message-1", delta: "Hello" }
      };
      for (const push of f.handlers) push(envelope);
      expect(await b.next()).toMatchObject({ channel: "session.event", event: { subscriptionId: "same-id", envelope } });
      const revoked = once(b.ws, "close");
      await f.devices.revoke(second.device.deviceId);
      f.gateway.revoke(second.device.deviceId);
      await revoked;
      await vi.waitFor(() => expect(f.handlers.size).toBe(0));
      expect(f.workbenchHandlers.size).toBe(0);
      expect(f.gateway.connectedDevices()).toBe(0);
      expect(f.devices.authenticate(second.token)).toBeUndefined();
      const c = client(f.socket, first.token);
      await c.next();
      await c.request("session", subscribe);
      await f.gateway.close();
      expect(f.handlers.size).toBe(0);
      expect(f.workbenchHandlers.size).toBe(0);
      expect(f.routers.every((router) => vi.mocked(router.dispose).mock.calls.length === 1)).toBe(true);
      expect(f.service.dispose).not.toHaveBeenCalled();
    });
  });
});
