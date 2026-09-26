import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RemoteDevice = {
  deviceId: string; name: string; pairedAt: string; lastConnectedAt?: string; pushAvailable: boolean;
};
export type PushRegistration = { token: string; environment: "sandbox" | "production" };
type StoredDevice = RemoteDevice & { tokenHash: string; push?: PushRegistration };
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

export class RemoteDevices {
  private devices: StoredDevice[] = [];
  private pairing?: { code: string; expiresAt: number; attempts: number };
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly now = Date.now) {}
  async load(): Promise<void> {
    try {
      this.devices = JSON.parse(await readFile(join(this.directory, "devices.json"), "utf8")) as StoredDevice[];
      if (!Array.isArray(this.devices) || this.devices.some((d) => typeof d.tokenHash !== "string" || typeof d.deviceId !== "string")) {
        throw new Error("Invalid remote device records");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  list(): RemoteDevice[] { return this.devices.map(({ tokenHash: _hash, push: _push, ...device }) => ({ ...device })); }
  pushTargets(): Array<{ deviceId: string; push: PushRegistration }> {
    return this.devices.flatMap((d) => d.push ? [{ deviceId: d.deviceId, push: { ...d.push } }] : []);
  }
  async registerPush(deviceId: string, push?: PushRegistration): Promise<void> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (!device) throw new Error("设备已移除，请重新配对");
    device.push = push;
    device.pushAvailable = Boolean(push);
    await this.save();
  }
  async invalidatePush(deviceId: string, expected: PushRegistration): Promise<void> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (device?.push?.token === expected.token && device.push.environment === expected.environment) {
      await this.registerPush(deviceId);
    }
  }
  pair(publicUrl: string, desktopName: string): { code: string; expiresAt: string; qrContent: string } {
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const expiresAt = this.now() + 600_000;
    this.pairing = { code, expiresAt, attempts: 0 };
    const params = new URLSearchParams({ url: publicUrl, code, name: desktopName });
    return { code, expiresAt: new Date(expiresAt).toISOString(), qrContent: `vermillion://pair?${params}` };
  }
  cancelPairing(): void { this.pairing = undefined; }
  async exchange(code: unknown, name: unknown): Promise<{ token: string; device: RemoteDevice }> {
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= this.now()) {
      this.pairing = undefined;
      throw new Error("配对码无效或已过期");
    }
    if (code !== pairing.code) {
      if (++pairing.attempts >= 5) this.pairing = undefined;
      throw new Error("配对码无效或已过期");
    }
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("请输入设备名称（最多 100 字）");
    this.pairing = undefined;
    const token = randomBytes(32).toString("base64url");
    const device: RemoteDevice = { deviceId: randomUUID(), name: name.trim(), pairedAt: new Date(this.now()).toISOString(), pushAvailable: false };
    this.devices.push({ ...device, tokenHash: tokenHash(token) });
    try { await this.save(); } catch (error) { this.devices = this.devices.filter((d) => d.deviceId !== device.deviceId); throw error; }
    return { token, device };
  }
  authenticate(token: string | undefined): RemoteDevice | undefined {
    if (!token || token.length > 512) return undefined;
    const found = this.devices.find((d) => d.tokenHash === tokenHash(token));
    if (!found) return undefined;
    const { tokenHash: _hash, push: _push, ...device } = found;
    return device;
  }
  async connected(deviceId: string): Promise<void> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (device) { device.lastConnectedAt = new Date(this.now()).toISOString(); await this.save(); }
  }
  async revoke(deviceId: string): Promise<void> {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    await this.save();
  }
  private save(): Promise<void> {
    const content = JSON.stringify(this.devices, null, 2) + "\n";
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, "devices.json");
      await writeFile(file + ".tmp", content, { mode: 0o600 });
      await rename(file + ".tmp", file);
    });
    this.writes = write;
    return write;
  }
}
