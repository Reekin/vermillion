import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http2";
import { afterEach, expect, it, vi } from "vitest";
import { zRemoteConfig } from "@vermillion/workbench";
import { ApnsSender, sendApnsRequest, shouldPush, type ApnsRequest } from "../src/electron/remote/push.js";
import { RemoteDevices } from "../src/electron/remote/devices.js";
import { startRemoteGateway } from "../src/electron/remote/gateway.js";
import { RemoteAccessService } from "../src/electron/remote/service.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary() { const directory = await mkdtemp(join(tmpdir(), "vermillion-push-")); directories.push(directory); return directory; }
const base = { enabled: true, serverAddr: "localhost", frpToken: "test", publicUrl: "https://localhost:9443", desktopName: "测试桌面", frpcPath: "" };

it("signs verifiable ES256 JWTs, caches concurrent requests and routes APNs environments", async () => {
  const directory = await temporary();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const apnsKeyPath = join(directory, "key.p8");
  await writeFile(apnsKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const config = zRemoteConfig.parse({ ...base, apnsKeyPath, apnsKeyId: "KEY", apnsTeamId: "TEAM", apnsBundleId: "app.vermillion.remote" });
  const requests: ApnsRequest[] = [];
  let now = 1_800_000_000_000;
  const sender = new ApnsSender(async (request) => { requests.push(request); return { status: 200, apnsId: "receipt" }; }, () => now);
  const registration = { token: "ab".repeat(32), environment: "sandbox" as const };
  const message = { body: "需要你决定", target: "#/inbox/ws/card" };
  await Promise.all([sender.send(config, registration, config.publicUrl, message), sender.send(config, registration, config.publicUrl, message)]);
  const request = requests[0]!;
  expect(request.origin).toBe("https://api.sandbox.push.apple.com");
  expect(request.headers).toMatchObject({ ":method": "POST", ":path": "/3/device/" + registration.token, "apns-topic": config.apnsBundleId, "apns-push-type": "alert" });
  expect(requests[1]!.headers.authorization).toBe(request.headers.authorization);
  const token = String(request.headers.authorization).slice(7);
  const [header, claims, signature] = token.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY" });
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAM", iat: now / 1000 });
  expect(verify("sha256", Buffer.from(header + "." + claims), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  expect(JSON.parse(request.body)).toEqual({ aps: { alert: { title: "测试桌面", body: message.body }, sound: "default" }, desktopUrl: config.publicUrl, target: message.target });
  now += 3_000_000;
  await sender.send(config, { ...registration, environment: "production" }, config.publicUrl, message);
  expect(requests[2]!.origin).toBe("https://api.push.apple.com");
  expect(requests[2]!.headers.authorization).not.toBe(request.headers.authorization);
  await expect(sender.send(zRemoteConfig.parse(base), registration, config.publicUrl, message)).rejects.toThrow("Configure the APNs");
});

it("uses HTTP/2 and returns APNs acceptance and rejection details", async () => {
  const server = createServer();
  const received: string[] = [];
  server.on("stream", (stream, headers) => {
    expect(headers[":method"]).toBe("POST");
    let body = "";
    stream.on("data", (chunk) => { body += String(chunk); });
    stream.on("end", () => {
      received.push(body);
      stream.respond({ ":status": received.length === 1 ? 200 : 410, "apns-id": "accepted-id" });
      stream.end(received.length === 1 ? "" : JSON.stringify({ reason: "Unregistered" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const request = { origin: `http://127.0.0.1:${address.port}`, headers: { ":method": "POST", ":path": "/3/device/test", "apns-id": "request-id" }, body: "{\"aps\":{}}" };
  try {
    expect(await sendApnsRequest(request)).toMatchObject({ status: 200, apnsId: "accepted-id" });
    expect(await sendApnsRequest(request)).toMatchObject({ status: 410, reason: "Unregistered" });
    expect(received).toEqual([request.body, request.body]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("only pushes in background or after five minutes idle", () => {
  expect(shouldPush(false, 0)).toBe(false);
  expect(shouldPush(false, 299)).toBe(false);
  expect(shouldPush(false, 300)).toBe(true);
  expect(shouldPush(true, 0)).toBe(true);
});

it("reports missing credentials and invalidates rejected tokens through the CLI service", async () => {
  const directory = await temporary();
  const service = new RemoteAccessService(directory, { assetsDir: directory,
    createRouter: () => ({ handleRequest: async () => ({}), dispose: async () => {} }),
    workbenchRequest: async () => ({}), subscribeWorkbench: () => () => {}, summary: async () => ({}) });
  try {
    await service.initialize();
    await service.handleRequest({ method: "remote.configure", params: { patch: { ...base, frpcPath: join(directory, "missing") } } });
    const pairing = service.devices.pair(base.publicUrl, base.desktopName);
    const device = await service.devices.exchange(pairing.code, "test phone");
    await service.devices.registerPush(device.device.deviceId, { token: "aa".repeat(32), environment: "sandbox" });
    const request = { method: "remote.push.test", params: { deviceId: device.device.deviceId } };
    expect(await service.handleRequest(request)).toMatchObject({ ok: false, error: expect.stringContaining("Configure the APNs") });
    const sender = vi.spyOn(ApnsSender.prototype, "send").mockResolvedValue({ status: 200, apnsId: "test-acceptance" });
    expect(await service.handleRequest(request)).toEqual({ ok: true, result: { accepted: true, apnsId: "test-acceptance" } });
    sender.mockResolvedValue({ status: 410, apnsId: "test-invalid", reason: "Unregistered" });
    expect(await service.handleRequest(request)).toMatchObject({ ok: false, error: "APNs 410: Unregistered" });
    expect(service.devices.list()[0]?.pushAvailable).toBe(false);
    expect(service.status().pushError).toEqual({ code: "remote.apnsRejected", params: { status: 410, reason: "Unregistered" } });
  } finally { await service.dispose(); }
});

it("authenticates APNs registration and persists it without exposing the token in device lists", async () => {
  const directory = await temporary();
  const devices = new RemoteDevices(directory);
  const pair = devices.pair(base.publicUrl, base.desktopName);
  const exchange = await devices.exchange(pair.code, "phone");
  const gateway = await startRemoteGateway({ devices, publicUrl: base.publicUrl, assetsDir: directory, desktopName: base.desktopName,
    createRouter: () => ({ handleRequest: async () => ({}), dispose: async () => {} }), workbenchRequest: async () => ({}), subscribeWorkbench: () => () => {}, summary: async () => ({}) });
  const url = `http://127.0.0.1:${gateway.port}/api/push`;
  const registration = { token: "cd".repeat(32), environment: "production" as const };
  try {
    expect((await fetch(url, { method: "POST", body: JSON.stringify(registration) })).status).toBe(401);
    const headers = { authorization: "Bearer " + exchange.token };
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...registration, environment: "wrong" }) })).status).toBe(400);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(registration) })).status).toBe(200);
    expect(devices.list()[0]?.pushAvailable).toBe(true);
    expect(JSON.stringify(devices.list())).not.toContain(registration.token);
    expect(JSON.stringify(devices.authenticate(exchange.token))).not.toContain(registration.token);
    const reloaded = new RemoteDevices(directory); await reloaded.load();
    expect(reloaded.pushTargets()).toEqual([{ deviceId: exchange.device.deviceId, push: registration }]);
    await devices.invalidatePush(exchange.device.deviceId, { ...registration, token: "old" });
    expect(devices.list()[0]?.pushAvailable).toBe(true);
    await devices.invalidatePush(exchange.device.deviceId, registration);
    expect(devices.list()[0]?.pushAvailable).toBe(false);
    await devices.registerPush(exchange.device.deviceId, registration);
    const nextPair = devices.pair(base.publicUrl, base.desktopName);
    const nextDevice = await devices.exchange(nextPair.code, "phone re-paired");
    await devices.registerPush(nextDevice.device.deviceId, registration);
    expect(devices.pushTargets()).toEqual([{ deviceId: nextDevice.device.deviceId, push: registration }]);
    expect(devices.list()[0]?.pushAvailable).toBe(false);
    expect((await fetch(url, { method: "DELETE", headers })).status).toBe(200);
    await devices.revoke(exchange.device.deviceId);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(registration) })).status).toBe(401);
  } finally { await gateway.close(); }
});
