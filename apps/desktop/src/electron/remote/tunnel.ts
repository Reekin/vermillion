import { failureText, serviceError, text, type ServiceText } from "@vermillion/workbench";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type TunnelConfig = { serverAddr: string; serverPort: number; frpToken: string; remotePort: number; frpcPath: string; trustedCaFile: string };
export type TunnelStatus = { state: "disabled" | "connecting" | "connected" | "error"; error?: ServiceText; frpcPath?: string };
export async function resolveFrpc(program: string): Promise<string> {
  const name = program || (process.platform === "win32" ? "frpc.exe" : "frpc");
  const candidates = isAbsolute(name) ? [name] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } catch { /* Continue PATH lookup. */ }
  }
  throw serviceError("remote.frpcNotFound");
}

export class RemoteTunnel {
  status: TunnelStatus = { state: "disabled" };
  private child?: ChildProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  constructor(private readonly directory: string) {}
  async start(config: TunnelConfig, localPort: number): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.status = { state: "connecting" };
    try {
      const program = await resolveFrpc(config.frpcPath);
      if (!config.trustedCaFile) throw serviceError("remote.caRequired");
      await access(config.trustedCaFile, constants.R_OK);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, "frpc.toml");
      const quote = (value: string) => JSON.stringify(value);
      await writeFile(file, [
        `serverAddr = ${quote(config.serverAddr)}`, `serverPort = ${config.serverPort}`,
        'auth.method = "token"', `auth.token = ${quote(config.frpToken)}`,
        "transport.tls.enable = true", `transport.tls.trustedCaFile = ${quote(config.trustedCaFile)}`,
        `transport.tls.serverName = ${quote(config.serverAddr)}`,
        "loginFailExit = false", 'log.to = "console"', 'log.level = "info"', "log.disablePrintColor = true",
        "[[proxies]]", `name = ${quote("vermillion-" + config.remotePort)}`, 'type = "tcp"', 'localIP = "127.0.0.1"',
        `localPort = ${localPort}`, `remotePort = ${config.remotePort}`, ""
      ].join("\n"), { mode: 0o600 });
      const launch = () => {
        if (this.stopped) return;
        this.status = { state: "connecting", frpcPath: program };
        const child = spawn(program, ["-c", file], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        this.child = child;
        let pending = "";
        const output = (chunk: Buffer) => {
          pending = (pending + chunk.toString()).slice(-8192);
          const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
          for (const raw of lines) {
            const line = config.frpToken ? raw.replaceAll(config.frpToken, "[redacted]") : raw;
            if (/start proxy success/.test(line)) this.status = { state: "connected", frpcPath: program };
            else if (/error|fail|connection.*closed|reconnect/i.test(line)) this.status = { state: "error", error: line.slice(-500), frpcPath: program };
          }
        };
        child.stdout?.on("data", output); child.stderr?.on("data", output);
        child.once("error", (error) => { this.status = { state: "error", error: error.message, frpcPath: program }; });
        child.once("close", (code) => {
          if (this.child === child) this.child = undefined;
          if (!this.stopped) {
            this.status = { state: "error", error: this.status.error ?? text("remote.frpcExited", { code: String(code ?? "signal") }), frpcPath: program };
            this.retry = setTimeout(launch, 5000);
          }
        });
      };
      launch();
    } catch (error) { this.status = { state: "error", error: error instanceof Error ? failureText(error) : text("remote.tunnelFailed") }; }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.once("close", () => { clearTimeout(kill); done(); });
        child.kill();
      });
    }
    this.child = undefined;
    this.status = { state: "disabled" };
  }
}
