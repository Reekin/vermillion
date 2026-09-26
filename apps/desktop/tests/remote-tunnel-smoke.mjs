#!/usr/bin/env node
// Uses an existing isolated app.start instance. Never launches or stops the desktop.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { request } from "node:https";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const usage = "node remote-tunnel-smoke.mjs --target <app.start descriptor.json> --frps <absolute executable> --caddy <absolute executable> --frpc <absolute executable> --ca <frps CA.pem> --cert <frps server.pem> --key <frps server.key> --workdir <external evidence directory> [--workspace-id <fixture workspaceId>]";
if (process.argv.includes("--help")) { console.log(usage); process.exit(0); }
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!/^--(target|frps|caddy|frpc|ca|cert|key|workdir|workspace-id)$/.test(key) || !process.argv[i + 1]) throw new Error(usage);
  args[key.slice(2)] = process.argv[i + 1];
}
for (const key of ["target", "frps", "caddy", "frpc", "ca", "cert", "key", "workdir"]) {
  if (!args[key]) throw new Error(`Missing --${key}. ${usage}`);
  if (["frps", "frpc", "caddy"].includes(key) && !isAbsolute(args[key])) throw new Error(`--${key} must be absolute`);
  args[key] = resolve(args[key]);
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repository, "packages/workbench/bin/vermillion.mjs");
const execute = promisify(execFile);
const checks = [];
const children = [];
const sockets = [];
const secrets = [];
let interrupted = false;
const onSignal = () => { interrupted = true; };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const sanitize = (text) => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), String(text));
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };

async function cli(method, params = {}) {
  try {
    const { stdout } = await execute(process.execPath, [cliPath, "--target", args.target, method, JSON.stringify(params)], {
      cwd: repository, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
    });
    return JSON.parse(stdout);
  } catch { throw new Error(`Bound desktop CLI failed: ${method}`); }
}

async function until(label, predicate, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Smoke interrupted");
    if (await predicate()) return;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(700, () => finish(false));
  });
}

function startChild(name, program, argv, env) {
  const child = spawn(program, argv, { cwd: runDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const record = { name, child, output: "", closed: false };
  const collect = (chunk) => { record.output = (record.output + chunk.toString()).slice(-128_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", () => { record.output += `\n${name} spawn failed\n`; });
  record.done = new Promise((resolve) => child.once("close", () => { record.closed = true; resolve(); }));
  children.push(record);
  return record;
}

async function stopChild(record) {
  if (!record.closed) {
    record.child.kill();
    const timer = setTimeout(() => record.child.kill("SIGKILL"), 2000);
    try { await record.done; } finally { clearTimeout(timer); }
  }
  await writeFile(join(runDir, `${record.name}.log`), sanitize(record.output), { mode: 0o600 });
}

function httpsCall(path, { method = "GET", body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(`${publicUrl}${path}`, {
      method, ca: caddyCa, family: 4,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
    }, (res) => {
      let content = "";
      res.on("data", (chunk) => { content += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(content) }); }
        catch { reject(new Error("Expected JSON from remote HTTPS endpoint")); }
      });
      res.on("error", () => reject(new Error("Remote HTTPS response failed")));
    });
    req.on("error", () => reject(new Error("Remote HTTPS request failed")));
    req.setTimeout(10_000, () => req.destroy(new Error("Remote HTTPS timeout")));
    req.end(payload);
  });
}

function websocket(token) {
  const ws = new WebSocket(`${publicUrl.replace("https:", "wss:")}/api/socket`, {
    ca: caddyCa, family: 4, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {})
  });
  sockets.push(ws);
  const messages = [];
  let closed = false;
  let failed = false;
  ws.on("message", (bytes) => { try { messages.push(JSON.parse(bytes.toString())); } catch { failed = true; } });
  ws.on("error", () => { failed = true; });
  ws.on("close", () => { closed = true; });
  return {
    ws,
    async open() { await until("WebSocket open", () => { if (failed || closed) throw new Error("WebSocket connection failed"); return ws.readyState === WebSocket.OPEN; }); },
    async next(match) {
      let index;
      await until("WebSocket response", () => {
        index = messages.findIndex(match);
        if (index >= 0) return true;
        if (failed || closed) throw new Error("WebSocket closed before response");
        return false;
      });
      return messages.splice(index, 1)[0];
    },
    async rpc(channel, method, params = {}) {
      const id = randomBytes(8).toString("hex");
      ws.send(JSON.stringify({ channel, id, request: { id, method, params } }));
      return (await this.next((message) => message.id === id)).response;
    },
    async closed() { await until("WebSocket disconnect", () => closed); }
  };
}

await mkdir(args.workdir, { recursive: true });
const runDir = await mkdtemp(join(args.workdir, "remote-tunnel-"));
let publicUrl;
let caddyCa;
let originalConfig;
let deviceId;
let failure;
let ports;
try {
  const descriptor = JSON.parse(await readFile(args.target, "utf8"));
  assert.ok(descriptor.dataDir && descriptor.instanceId && Number.isInteger(descriptor.pid), "Invalid app.start descriptor");
  for (const key of ["frps", "frpc", "caddy", "ca", "cert", "key"]) await access(args[key]);
  // Validate the installed CLIs, not assumptions about a particular release.
  for (const key of ["frps", "frpc"]) {
    const { stdout, stderr } = await execute(args[key], ["--help"], { timeout: 10_000 });
    assert.ok(/--config/.test(stdout + stderr), `${key} must support --config`);
  }
  const caddyHelp = await execute(args.caddy, ["run", "--help"], { timeout: 10_000 });
  assert.ok(/--config/.test(caddyHelp.stdout), "caddy run must support --config");
  const reserved = new Set();
  while (reserved.size < 4) reserved.add(await availablePort());
  const [control, backend, publicPort, unreachable] = [...reserved];
  ports = { control, backend, public: publicPort, unreachable };
  publicUrl = `https://localhost:${publicPort}`;
  const token = randomBytes(32).toString("hex");
  secrets.push(token);
  const frpsConfig = join(runDir, "frps.toml");
  await writeFile(frpsConfig, [
    'bindAddr = "127.0.0.1"', `bindPort = ${control}`, 'proxyBindAddr = "127.0.0.1"',
    'auth.method = "token"', `auth.token = ${JSON.stringify(token)}`,
    "transport.tls.force = true", `transport.tls.certFile = ${JSON.stringify(args.cert)}`,
    `transport.tls.keyFile = ${JSON.stringify(args.key)}`, `allowPorts = [{ single = ${backend} }]`,
    'log.to = "console"', 'log.level = "warn"', ""
  ].join("\n"), { mode: 0o600 });
  const caddyFile = join(runDir, "Caddyfile");
  await writeFile(caddyFile, `{
  admin off
  skip_install_trust
  auto_https disable_redirects
}
${publicUrl} {
  bind 127.0.0.1
  tls internal
  reverse_proxy 127.0.0.1:${backend}
}
`, { mode: 0o600 });
  startChild("frps", args.frps, ["--config", frpsConfig]);
  startChild("caddy", args.caddy, ["run", "--config", caddyFile, "--adapter", "caddyfile"], {
    XDG_DATA_HOME: join(runDir, "caddy-data"), XDG_CONFIG_HOME: join(runDir, "caddy-config")
  });
  await until("frps and Caddy listeners", async () => await listening(control) && await listening(publicPort));
  const root = join(runDir, "caddy-data/caddy/pki/authorities/local/root.crt");
  await until("Caddy internal CA", async () => { try { caddyCa = await readFile(root); return true; } catch { return false; } });
  originalConfig = await cli("remote.configure");
  if (originalConfig.frpToken) secrets.push(originalConfig.frpToken);
  assert.equal(originalConfig.enabled, false, "Smoke requires an isolated fixture with remote access initially disabled");
  await cli("remote.configure", { patch: {
    enabled: true, serverAddr: "127.0.0.1", serverPort: control, remotePort: backend,
    frpToken: token, publicUrl, frpcPath: args.frpc, trustedCaFile: args.ca, desktopName: "Remote smoke fixture"
  } });
  await until("remote connected", async () => (await cli("remote.status")).state === "connected");
  const state = await cli("remote.status");
  ports.gateway = state.gatewayPort;
  assert.ok(Number.isInteger(ports.gateway), "Gateway port missing");
  check("FRP TLS/token tunnel connected through bound desktop CLI");
  assert.equal((await httpsCall("/api/summary")).status, 401);
  assert.equal((await httpsCall("/api/summary", { token: "invalid" })).status, 401);
  check("HTTPS rejects absent and invalid credentials using trusted Caddy CA");
  const pairing = await cli("remote.pair");
  secrets.push(pairing.code);
  const exchanged = await httpsCall("/api/pair", { method: "POST", body: { code: pairing.code, name: "CLI smoke phone" } });
  assert.equal(exchanged.status, 200);
  const deviceToken = exchanged.body.token;
  assert.ok(typeof deviceToken === "string", "Pairing token missing");
  secrets.push(deviceToken);
  deviceId = exchanged.body.device.deviceId;
  assert.equal((await httpsCall("/api/pair", { method: "POST", body: { code: pairing.code, name: "Repeated" } })).status, 400);
  assert.equal((await httpsCall("/api/summary", { token: deviceToken })).status, 200);
  check("HTTPS pairing exchanges once and authorizes summary");
  const denied = websocket();
  await denied.open();
  denied.ws.send(JSON.stringify({ channel: "auth", token: "invalid" }));
  await denied.closed();
  const browser = websocket();
  await browser.open();
  browser.ws.send(JSON.stringify({ channel: "auth", token: deviceToken }));
  assert.equal((await browser.next((message) => message.channel === "auth")).ok, true);
  const native = websocket(deviceToken);
  assert.equal((await native.next((message) => message.channel === "auth")).ok, true);
  check("WSS first-frame and Bearer authentication; invalid token disconnected");
  const workspaces = await cli("workspace.list");
  const workspace = workspaces.find((entry) => args["workspace-id"] ? entry.id === args["workspace-id"] || entry.workspaceId === args["workspace-id"] : true);
  assert.ok(workspace, "Fixture workspace not found");
  const workspaceId = workspace.workspaceId ?? workspace.id;
  assert.equal((await browser.rpc("workbench", "inbox.list", { workspaceId })).ok, true);
  assert.equal((await browser.rpc("session", "sessionBrowser.list", { workspaceId })).ok, true);
  assert.equal((await browser.rpc("session", "domain.snapshot")).ok, true);
  assert.equal((await browser.rpc("session", "events.subscribe", { subscriptionId: "smoke" })).ok, true);
  assert.equal((await browser.rpc("workbench", "work.start", { workspaceId })).ok, false);
  assert.equal((await browser.rpc("session", "runtime.command", { envelope: { commandId: "denied", command: { type: "createSession", engineId: "codex" } } })).ok, false);
  check("Real inbox/session browser/snapshot reads and subscription; forbidden methods rejected");
  await cli("remote.device.revoke", { deviceId });
  deviceId = undefined;
  await Promise.all([browser.closed(), native.closed()]);
  assert.equal((await httpsCall("/api/summary", { token: deviceToken })).status, 401);
  check("Revocation disconnects both clients and invalidates HTTPS credential");
  await cli("remote.configure", { patch: { enabled: false } });
  assert.equal((await cli("remote.status")).state, "disabled");
  await until("gateway and FRP backend ports released", async () => !await listening(ports.gateway) && !await listening(backend));
  check("Disable releases local gateway and FRP backend ports");
  await cli("remote.configure", { patch: { enabled: true, frpcPath: join(runDir, "missing-frpc") } });
  assert.equal((await cli("remote.status")).state, "error");
  check("Missing frpc reports error");
  await cli("remote.configure", { patch: { frpcPath: args.frpc, serverPort: unreachable } });
  await until("unreachable FRP error", async () => (await cli("remote.status")).state === "error");
  check("Unreachable FRP reports error");
} catch (error) {
  failure = error instanceof Error ? sanitize(error.message) : "Smoke failed";
} finally {
  for (const ws of sockets) ws.terminate();
  if (originalConfig) {
    try {
      if (deviceId) await cli("remote.device.revoke", { deviceId });
    } catch { failure ??= "Cleanup failed to revoke smoke device"; }
    try { await cli("remote.configure", { patch: { ...originalConfig, enabled: false } }); }
    catch { failure ??= "Cleanup failed to disable remote access"; }
  }
  for (const child of children.reverse()) {
    try { await stopChild(child); } catch { failure ??= "Cleanup failed to stop owned process"; }
  }
  // Configuration evidence retains topology but never the generated shared secret.
  try {
    const config = join(runDir, "frps.toml");
    await writeFile(config, sanitize(await readFile(config, "utf8")), { mode: 0o600 });
  } catch { /* Setup may have failed before creating the config. */ }
  const report = { passed: !failure, checks, ports, remainingVerification: ["Generate a fixture read-state/workbench event and verify its WSS push; this smoke does not mutate workspace registrations."], ...(failure ? { failure } : {}) };
  await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
console.log(`Evidence: ${runDir}`);
if (failure) { console.error(failure); process.exitCode = 1; }
