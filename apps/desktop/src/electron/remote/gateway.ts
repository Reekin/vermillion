import { ServiceError } from "@vermillion/workbench";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import { extname, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { RemoteDevices } from "./devices.js";
import { allowRemoteRequest } from "./policy.js";

export type RemoteRouter = { handleRequest: (request: unknown) => Promise<unknown>; dispose: () => Promise<void> };
export type GatewayOptions = {
  devices: RemoteDevices;
  publicUrl: string;
  assetsDir: string;
  desktopName: string;
  createRouter: (push: (event: unknown) => void) => RemoteRouter;
  workbenchRequest: (request: { method: string; params: unknown }) => Promise<unknown>;
  subscribeWorkbench: (push: (event: unknown) => void) => () => void;
  summary: () => Promise<unknown>;
};
const bearer = (request: IncomingMessage): string | undefined => request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const compressible = new Set([".html", ".js", ".css", ".svg"]);
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
type StaticFile = { mtimeMs: number; etag: string; raw: Buffer; br?: Buffer; gzip?: Buffer };

/** Static files are read and compressed once per build; hashed assets never change once served. */
const createStaticCache = () => {
  const files = new Map<string, Promise<StaticFile>>();
  return async (file: string): Promise<StaticFile> => {
    const { mtimeMs } = await stat(file);
    const cached = files.get(file);
    if (cached && (await cached).mtimeMs === mtimeMs) return cached;
    const load = (async () => {
      const raw = await readFile(file);
      const entry: StaticFile = { mtimeMs, raw, etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 27)}"` };
      if (compressible.has(extname(file)) && raw.length > 1024) {
        [entry.br, entry.gzip] = await Promise.all([
          brotli(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
          gzipAsync(raw, { level: 9 })
        ]);
      }
      return entry;
    })();
    files.set(file, load);
    load.catch(() => files.delete(file));
    return load;
  };
};

export async function startRemoteGateway(options: GatewayOptions) {
  const connections = new Map<WebSocket, string>();
  const cleanups = new Set<Promise<void>>();
  const sockets = new Set<import("node:net").Socket>();
  const publicOrigin = new URL(options.publicUrl).origin;
  const originAllowed = (request: IncomingMessage) => !request.headers.origin || request.headers.origin === publicOrigin;
  const staticFile = createStaticCache();
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    try {
      if (!originAllowed(req)) { reply(403, { error: "Origin denied" }); return; }
      const path = new URL(req.url ?? "/", publicOrigin).pathname;
      if (path === "/api/pair" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 4096) { reply(413, { error: "Request too large" }); return; }
        }
        const input = JSON.parse(body) as { code?: unknown; name?: unknown };
        const result = await options.devices.exchange(input.code, input.name);
        reply(200, { ...result, desktopName: options.desktopName });
        return;
      }
      if (path === "/api/summary" && req.method === "GET") {
        const device = options.devices.authenticate(bearer(req));
        if (!device) { reply(401, { error: "Unauthorized" }); return; }
        await options.devices.connected(device.deviceId);
        reply(200, await options.summary());
        return;
      }
      if (path === "/api/push" && (req.method === "POST" || req.method === "DELETE")) {
        const device = options.devices.authenticate(bearer(req));
        if (!device) { reply(401, { error: "Unauthorized" }); return; }
        if (req.method === "DELETE") await options.devices.registerPush(device.deviceId);
        else {
          let body = "";
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 4096) { reply(413, { error: "Request too large" }); return; }
          }
          const input = JSON.parse(body) as { token?: unknown; environment?: unknown };
          if (typeof input.token !== "string" || !/^[a-fA-F0-9]{32,512}$/.test(input.token) ||
              (input.environment !== "sandbox" && input.environment !== "production")) {
            reply(400, { error: "Invalid APNs registration" }); return;
          }
          await options.devices.registerPush(device.deviceId, { token: input.token.toLowerCase(), environment: input.environment });
        }
        reply(200, {}); return;
      }
      if (path.startsWith("/api/") || req.method !== "GET") { reply(404, { error: "Not found" }); return; }
      // Only the dedicated mobile entry and public build assets are served, never the Electron entry.
      const asset = path === "/" ? "mobile.html" : decodeURIComponent(path).replace(/^\//, "");
      if (asset !== "mobile.html" && !asset.startsWith("assets/")) { reply(404, { error: "Not found" }); return; }
      const root = await realpath(options.assetsDir);
      let file: string;
      try { file = await realpath(resolve(root, asset)); } catch (error) {
        if (asset === "mobile.html" && (error as NodeJS.ErrnoException).code === "ENOENT") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><html lang=zh><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Vermillion</title><p>远程入口已连接，手机页面尚未安装。</p></html>"); return;
        }
        throw error;
      }
      if (!file.startsWith(root + sep)) { reply(403, { error: "Path denied" }); return; }
      const entry = await staticFile(file);
      // Hashed build assets are immutable; the entry page is revalidated so a desktop update reaches the phone.
      res.setHeader("cache-control", asset === "mobile.html" ? "no-cache" : "public, max-age=31536000, immutable");
      res.setHeader("etag", entry.etag);
      res.setHeader("vary", "accept-encoding");
      if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304).end(); return; }
      const accepted = String(req.headers["accept-encoding"] ?? "");
      const [encoding, body] = entry.br && /\bbr\b/.test(accepted) ? ["br", entry.br]
        : entry.gzip && /\bgzip\b/.test(accepted) ? ["gzip", entry.gzip] : [undefined, entry.raw];
      res.writeHead(200, {
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
        "content-length": body.length,
        ...(encoding ? { "content-encoding": encoding } : {})
      }).end(body);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      reply((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400, { error: error instanceof Error ? error.message : "Request failed", ...(error instanceof ServiceError ? { text: error.text } : {}) });
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024,
    // Session history is verbose JSON; compressing frames keeps reads fast over a thin VPS link.
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } } });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/socket" || !originAllowed(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    // Browsers cannot set Authorization on a WebSocket handshake. Authenticate the first frame
    // before creating any subscriptions; native/CLI clients can send Authorization at upgrade.
    const headerToken = bearer(req);
    const device = options.devices.authenticate(headerToken);
    if (headerToken && !device) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      let deviceId = device?.deviceId;
      let router: RemoteRouter | undefined;
      let unsubscribe: (() => void) | undefined;
      const push = (message: unknown) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.close(1013, "Reconnect to refresh"); return; }
        ws.send(JSON.stringify(message));
      };
      const timeout = setTimeout(() => ws.close(1008, "Authentication required"), 5000);
      const authenticate = (id: string) => {
        clearTimeout(timeout);
        deviceId = id;
        connections.set(ws, id);
        router = options.createRouter((event) => push({ channel: "session.event", event }));
        unsubscribe = options.subscribeWorkbench((event) => push({ channel: "workbench.event", event }));
        void options.devices.connected(id).catch(() => ws.close(1011, "Device state could not be saved"));
        push({ channel: "auth", ok: true });
      };
      if (deviceId) authenticate(deviceId);
      ws.on("error", () => ws.close());
      ws.on("message", async (bytes) => {
        try {
          const message = JSON.parse(bytes.toString()) as { channel: string; token?: string; id?: string; request?: { method: string; params: unknown } };
          if (!deviceId) {
            const paired = message.channel === "auth" ? options.devices.authenticate(message.token) : undefined;
            if (!paired) { ws.close(1008, "Unauthorized"); return; }
            authenticate(paired.deviceId); return;
          }
          if (typeof message.id !== "string" || !allowRemoteRequest(message.channel, message.request)) {
            push({ channel: message.channel, id: message.id, response: { ok: false, error: "Remote method denied" } }); return;
          }
          const response = message.channel === "session"
            ? await router!.handleRequest(message.request)
            : await options.workbenchRequest(message.request!);
          push({ channel: message.channel, id: message.id, response });
        } catch { push({ channel: "error", error: "Invalid remote request" }); }
      });
      ws.on("close", () => {
        clearTimeout(timeout); connections.delete(ws); unsubscribe?.();
        if (router) {
          const cleanup = router.dispose().catch(() => undefined);
          cleanups.add(cleanup); void cleanup.finally(() => cleanups.delete(cleanup));
        }
      });
    });
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.off("error", fail); done(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway address unavailable");
  return {
    port: address.port,
    connectedDevices: () => new Set(connections.values()).size,
    revoke: (deviceId: string) => { for (const [ws, id] of connections) if (id === deviceId) ws.terminate(); },
    close: async () => {
      options.devices.cancelPairing();
      for (const ws of wsServer.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      await new Promise<void>((done) => wsServer.close(() => done()));
      await Promise.all([...cleanups]);
    }
  };
}
