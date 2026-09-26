import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { workbenchRpc, zRemoteConfig, type RemoteConfig, type WorkbenchRpcResponse } from "@vermillion/workbench";
import { RemoteDevices } from "./devices.js";
import { startRemoteGateway, type GatewayOptions } from "./gateway.js";
import { RemoteTunnel } from "./tunnel.js";
import { ApnsSender, pushConfigured, type PushMessage } from "./push.js";

export class RemoteAccessService {
  readonly devices: RemoteDevices;
  private config: RemoteConfig = zRemoteConfig.parse({ enabled: false, serverAddr: "", frpToken: "", publicUrl: "", desktopName: hostname(), frpcPath: "" });
  private gateway?: Awaited<ReturnType<typeof startRemoteGateway>>;
  private tunnel: RemoteTunnel;
  private error?: string;
  private pushError?: string;
  private readonly sender = new ApnsSender();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly options: Omit<GatewayOptions, "devices" | "publicUrl" | "desktopName">) {
    this.devices = new RemoteDevices(directory);
    this.tunnel = new RemoteTunnel(directory);
  }
  async initialize(): Promise<void> {
    await this.devices.load();
    try { this.config = zRemoteConfig.parse(JSON.parse(await readFile(join(this.directory, "settings.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.restart();
  }
  status() {
    return { ...this.tunnel.status, ...(this.error ? { state: "error" as const, error: this.error } : {}),
      ...(this.gateway ? { gatewayPort: this.gateway.port } : {}), connectedDevices: this.gateway?.connectedDevices() ?? 0,
      pushConfigured: pushConfigured(this.config), ...(this.pushError ? { pushError: this.pushError } : {}) };
  }
  getConfig(): RemoteConfig { return { ...this.config }; }
  private publicUrl(): string {
    const host = this.config.serverAddr.includes(":") ? `[${this.config.serverAddr}]` : this.config.serverAddr;
    return this.config.publicUrl || `https://${host}:${this.config.publicPort}`;
  }
  private async restart(): Promise<void> {
    await this.stop();
    this.error = undefined;
    if (!this.config.enabled) return;
    try {
      if (!this.config.serverAddr.trim() || !this.config.frpToken) throw new Error("请填写 VPS 地址和 frp token");
      const url = new URL(this.publicUrl());
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("公网地址必须是 HTTPS 源地址");
      this.gateway = await startRemoteGateway({ ...this.options, devices: this.devices, publicUrl: url.origin, desktopName: this.config.desktopName });
      await this.tunnel.start(this.config, this.gateway.port);
    } catch (error) { this.error = error instanceof Error ? error.message : "远程访问启动失败"; }
  }
  private async configure(patch?: Partial<RemoteConfig>): Promise<RemoteConfig> {
    if (!patch) return this.getConfig();
    const config = zRemoteConfig.parse({ ...this.config, ...patch });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, "settings.json");
    await writeFile(file + ".tmp", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(file + ".tmp", file);
    const reconnect = Object.keys(patch).some((key) => !key.startsWith("apns"));
    this.config = config;
    this.pushError = undefined;
    if (reconnect) await this.restart();
    return this.getConfig();
  }
  async handleRequest(request: { method: string; params?: unknown }): Promise<WorkbenchRpcResponse> {
    const run = this.operations.catch(() => undefined).then(async (): Promise<WorkbenchRpcResponse> => {
      try {
        const definition = workbenchRpc[request.method as keyof typeof workbenchRpc];
        if (!definition || !request.method.startsWith("remote.")) throw new Error("Unknown remote method");
        const params = definition.params.parse(request.params ?? {}) as { patch?: Partial<RemoteConfig>; deviceId?: string };
        let result: unknown;
        switch (request.method) {
          case "remote.status": result = this.status(); break;
          case "remote.configure": result = await this.configure(params.patch); break;
          case "remote.pair":
            if (!this.gateway) throw new Error("请先开启并配置远程访问");
            result = this.devices.pair(this.publicUrl(), this.config.desktopName); break;
          case "remote.device.list": result = this.devices.list(); break;
          case "remote.push.test": result = await this.sendPush(params.deviceId!, { body: "测试推送", target: "#/inbox" }); break;
          case "remote.device.revoke":
            this.gateway?.revoke(params.deviceId!);
            await this.devices.revoke(params.deviceId!); result = {}; break;
          default: throw new Error("Unknown remote method");
        }
        return { ok: true, result: definition.result.parse(result) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Remote operation failed" }; }
    });
    this.operations = run;
    return run;
  }
  private async sendPush(deviceId: string, message: PushMessage): Promise<{ accepted: true; apnsId: string }> {
    try {
      if (!this.config.enabled) throw new Error("请先开启远程访问");
      const target = this.devices.pushTargets().find((entry) => entry.deviceId === deviceId);
      if (!target) throw new Error("设备尚未登记推送，或已被移除");
      const reply = await this.sender.send(this.getConfig(), target.push, new URL(this.publicUrl()).origin, message);
      if (reply.status === 410 || reply.reason === "Unregistered" || reply.reason === "BadDeviceToken") {
        await this.devices.invalidatePush(deviceId, target.push);
      }
      if (reply.status !== 200) throw new Error(`APNs ${reply.status}: ${reply.reason ?? "请求失败"}`);
      this.pushError = undefined;
      return { accepted: true, apnsId: reply.apnsId };
    } catch (error) {
      this.pushError = error instanceof Error ? error.message : "推送失败";
      throw error;
    }
  }
  async notify(message: PushMessage): Promise<void> {
    if (!this.config.enabled || !pushConfigured(this.config)) return;
    for (const target of this.devices.pushTargets()) {
      await this.sendPush(target.deviceId, message).catch(() => undefined);
    }
  }
  async stop(): Promise<void> {
    await this.tunnel.stop();
    if (this.gateway) { const gateway = this.gateway; this.gateway = undefined; await gateway.close(); }
  }
  async dispose(): Promise<void> { await this.operations.catch(() => undefined); await this.stop(); }
}
