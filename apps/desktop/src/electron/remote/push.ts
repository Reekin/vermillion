import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type ClientHttp2Stream, type OutgoingHttpHeaders } from "node:http2";
import type { RemoteConfig } from "@vermillion/workbench";
import type { PushRegistration } from "./devices.js";

export type PushMessage = { body: string; target: string };
export type ApnsReply = { status: number; apnsId: string; reason?: string };
export type ApnsRequest = { origin: string; headers: OutgoingHttpHeaders; body: string };
export const shouldPush = (background: boolean, idleSeconds: number): boolean => background || idleSeconds >= 300;
export const pushConfigured = (config: RemoteConfig): boolean =>
  [config.apnsKeyPath, config.apnsKeyId, config.apnsTeamId, config.apnsBundleId].every((value) => Boolean(value.trim()));

export async function sendApnsRequest(request: ApnsRequest): Promise<ApnsReply> {
  return new Promise((resolve, reject) => {
    const client = connect(request.origin);
    const timer = setTimeout(() => fail(new Error("APNs 请求超时")), 15_000);
    let settled = false;
    const finish = () => { settled = true; clearTimeout(timer); client.destroy(); };
    const fail = (error: Error) => { if (!settled) { finish(); reject(error); } };
    client.on("error", fail);
    client.on("close", () => { if (!settled) fail(new Error("APNs 连接已关闭")); });
    client.once("connect", () => {
      let stream: ClientHttp2Stream;
      try { stream = client.request(request.headers); }
      catch (error) { fail(error instanceof Error ? error : new Error("APNs 请求无效")); return; }
      let status = 0, body = "", apnsId = String(request.headers["apns-id"]);
      stream.setEncoding("utf8");
      stream.on("response", (headers) => { status = Number(headers[":status"]); apnsId = String(headers["apns-id"] ?? apnsId); });
      stream.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 8192) fail(new Error("APNs 响应过大"));
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (settled) return;
        let reason: string | undefined;
        try { reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined; }
        catch { fail(new Error("APNs 返回无效响应")); return; }
        finish(); resolve({ status, apnsId, reason });
      });
      stream.end(request.body);
    });
  });
}

export class ApnsSender {
  private cached?: { settings: string; issuedAt: number; token: string };
  private signing: Promise<unknown> = Promise.resolve();
  constructor(private readonly request = sendApnsRequest, private readonly now = Date.now) {}
  private authorization(config: RemoteConfig): Promise<string> {
    const pending = this.signing.catch(() => undefined).then(() => this.createAuthorization(config));
    this.signing = pending;
    return pending;
  }
  private async createAuthorization(config: RemoteConfig): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const settings = JSON.stringify([config.apnsKeyPath, config.apnsKeyId, config.apnsTeamId]);
    if (this.cached?.settings === settings && issuedAt - this.cached.issuedAt < 3000 && issuedAt >= this.cached.issuedAt) return this.cached.token;
    const key = createPrivateKey(await readFile(config.apnsKeyPath));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("APNs 密钥必须是 P-256 EC 私钥");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const value = encode({ alg: "ES256", kid: config.apnsKeyId }) + "." + encode({ iss: config.apnsTeamId, iat: issuedAt });
    const token = value + "." + sign("sha256", Buffer.from(value), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.cached = { settings, issuedAt, token };
    return token;
  }
  async send(config: RemoteConfig, registration: PushRegistration, desktopUrl: string, message: PushMessage): Promise<ApnsReply> {
    if (!pushConfigured(config)) throw new Error("请配置 APNs 密钥路径、Key ID、Team ID 和 App Bundle ID");
    const body = JSON.stringify({ aps: { alert: { title: config.desktopName.slice(0, 100), body: message.body.slice(0, 240) }, sound: "default" }, desktopUrl, target: message.target });
    if (Buffer.byteLength(body) > 4096) throw new Error("APNs 通知超过 4096 字节");
    return this.request({
      origin: registration.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com",
      headers: { ":method": "POST", ":path": "/3/device/" + registration.token, authorization: "bearer " + await this.authorization(config),
        "apns-topic": config.apnsBundleId, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": "0", "apns-id": randomUUID() },
      body
    });
  }
}
