import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareSessionTreeFixture } from "./session-tree-fixture.js";

const execFileAsync = promisify(execFile);

export type AppStartInput = {
  /** Where the instance keeps its registry, sessions and CLI endpoint. Must not be the user's ~/.vermillion. */
  dataDir: string;
  /** Chromium user data dir; separate from the user's so the single-instance lock does not collide. */
  userDataDir?: string;
  /** CDP port. */
  port: number;
  /** Optional isolated acceptance data fixture. */
  fixture?: "session-tree";
  /** Extra environment for the instance. */
  env?: Record<string, string>;
};

export type AppStartResult = {
  pid: number;
  cdpUrl: string;
  desktop: string;
  dataDir?: string;
  projectPath?: string;
  workspaceId?: string;
};

export type AppLauncherOptions = {
  /** Vermillion executable in a release, or electron + main.js in the repo. */
  command: { exe: string; args: string[]; cwd: string };
  /** Root of the workbench package (where scripts/ lives). */
  packageRoot?: string;
  desktop?: string;
};

const defaultPackageRoot = (): string => fileURLToPath(new URL("..", import.meta.url));

/**
 * Starts and stops Vermillion instances for acceptance runs. On Windows the instance goes to a separate desktop so
 * dialogs and focus changes never reach the user; elsewhere it starts normally.
 */
const waitForCdp = async (cdpUrl: string, abort: () => Promise<void>, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(cdpUrl + "/json/version", { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  await abort();
  throw new Error("The app instance did not open its debugging port within " + timeoutMs / 1000 + "s: " + cdpUrl);
};

const waitForEndpoint = async (path: string, pid: number, abort: () => Promise<void>, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const endpoint = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      if (endpoint.pid === pid) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  await abort();
  throw new Error("The app instance did not publish its current local endpoint within " + timeoutMs / 1000 + "s: " + path);
};

export class AppLauncher {
  private readonly command: AppLauncherOptions["command"];
  private readonly scriptPath: string;
  private readonly packageRoot: string;
  private readonly desktop: string;

  constructor(options: AppLauncherOptions) {
    this.command = options.command;
    this.packageRoot = options.packageRoot ?? defaultPackageRoot();
    this.scriptPath = join(this.packageRoot, "scripts", "start-on-hidden-desktop.ps1");
    this.desktop = options.desktop ?? "vermillion-qa";
  }

  async start(input: AppStartInput): Promise<AppStartResult> {
    const dataDir = resolve(input.dataDir);
    const userDataDir = resolve(input.userDataDir ?? join(dataDir, "electron"));
    await mkdir(dataDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    const fixture = input.fixture === "session-tree"
      ? await prepareSessionTreeFixture(dataDir, this.packageRoot)
      : undefined;
    const env = {
      ...input.env,
      ...(fixture?.env ?? {}),
      VERMILLION_PERSISTENCE_BASE_DIR: dataDir,
      VERMILLION_USER_DATA_DIR: userDataDir,
      VERMILLION_REMOTE_DEBUGGING_PORT: String(input.port),
      ...(fixture ? { CODEX_HOME: input.env?.CODEX_HOME ?? join(dataDir, "codex") } : {})
    };
    const pid = process.platform === "win32" ? await this.startHidden(env) : await this.startPlain(env);
    const cdpUrl = "http://127.0.0.1:" + input.port;
    // Electron takes a few seconds to open its debugging port. Return only once it answers, so callers can attach
    // immediately; a CDP client that probes too early may fall back to launching its own browser.
    await waitForCdp(cdpUrl, async () => { await this.stop(pid); });
    if (fixture) {
      await waitForEndpoint(join(dataDir, "endpoint.json"), pid, async () => { await this.stop(pid); });
    }
    return {
      pid,
      cdpUrl,
      desktop: process.platform === "win32" ? this.desktop : "",
      dataDir,
      ...(fixture ? { projectPath: fixture.projectPath, workspaceId: fixture.workspaceId } : {})
    };
  }

  async stop(pid: number): Promise<void> {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
    } else {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }

  private async startHidden(env: Record<string, string>): Promise<number> {
    if (!existsSync(this.scriptPath)) throw new Error("Launcher script missing: " + this.scriptPath);
    const quoted = this.command.args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(" ");
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath,
      "-Desktop", this.desktop, "-Exe", this.command.exe, "-Args", quoted, "-Cwd", this.command.cwd, "-EnvJson", JSON.stringify(env)
    ], { env: { ...process.env, ...env } });
    const pid = Number(stdout.trim().split(/\r?\n/).at(-1));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Launcher did not return a pid: " + stdout);
    return pid;
  }

  private async startPlain(env: Record<string, string>): Promise<number> {
    const { spawn } = await import("node:child_process");
    const child = spawn(this.command.exe, this.command.args, { cwd: this.command.cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" });
    child.unref();
    if (!child.pid) throw new Error("spawn failed");
    return child.pid;
  }
}

/** Resolves the app command for the current checkout or release. */
export const resolveAppCommand = (appRoot: string): AppLauncherOptions["command"] => {
  const releaseExe = resolve(appRoot, "..", "..", "Vermillion.exe");
  if (existsSync(releaseExe)) return { exe: releaseExe, args: [], cwd: dirname(releaseExe) };
  const repoRoot = resolve(appRoot, "..", "..");
  const electron = process.platform === "win32"
    ? resolve(repoRoot, "node_modules", "electron", "dist", "electron.exe")
    : resolve(repoRoot, "node_modules", "electron", "dist", "electron");
  const desktopDir = resolve(repoRoot, "apps", "desktop");
  return { exe: electron, args: [resolve(desktopDir, "dist-electron", "main.js")], cwd: desktopDir };
};
