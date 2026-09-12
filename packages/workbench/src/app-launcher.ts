import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareRealSessionFixture, type RealSessionFixture } from "./real-session-fixture.js";
import { prepareSessionTreeFixture, type SessionTreeFixture } from "./session-tree-fixture.js";

const execFileAsync = promisify(execFile);

export type AppStartInput = {
  /** Where the instance keeps its registry, sessions and CLI endpoint. Must not be the user's ~/.vermillion. */
  dataDir: string;
  /** Chromium user data dir; separate from the user's so the single-instance lock does not collide. */
  userDataDir?: string;
  /** CDP port. */
  port: number;
  /** Optional isolated acceptance data fixture. */
  fixture?: "session-tree" | "real-session";
  /** Existing Codex home used only as the source for a new real-session fixture. */
  codexConfigSource?: string;
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
  codexHome?: string;
};

export type AppWindowAction = "status" | "minimize" | "restore";

export type AppWindowInput = {
  dataDir: string;
  pid: number;
  action: AppWindowAction;
};

export type AppWindowResult = {
  dataDir: string;
  pid: number;
  action: AppWindowAction;
  visible: boolean;
  minimized: boolean;
};

export type AcceptanceLaunchRecord = {
  kind: "vermillion-acceptance";
  pid: number;
  desktop: string;
  token: string;
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

type LocalEndpoint = { port?: unknown; pid?: unknown };
type WorkspaceInfo = { workspaceId: string; rootPath: string };
type EngineModelCatalogResult = {
  catalog?: {
    engineId?: unknown;
    models?: unknown[];
  };
};
type LocalRpcResponse = { ok?: boolean; result?: unknown; error?: string };
const launchRecordFile = "app-start.json";
// Keep Page Visibility tied to the acceptance window's own hide/minimize state while it runs on an inactive desktop.
const hiddenDesktopChromiumArgs = [
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows"
];

const resolveConfiguredCodexPath = async (): Promise<string | undefined> => {
  for (const value of [process.env.VERMILLION_CODEX_BIN, process.env.CODEX_BIN, process.env.CODEX_PATH]) {
    if (value?.trim()) return value.trim();
  }
  try {
    const registry = JSON.parse(await readFile(join(homedir(), ".vermillion", "workspace-registry.json"), "utf8")) as {
      engineProgramPathsByEngineId?: Record<string, unknown>;
    };
    const configured = registry.engineProgramPathsByEngineId?.codex;
    return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  } catch {
    return undefined;
  }
};

const callLocalEndpoint = async <T>(dataDir: string, pid: number, method: string, params: object): Promise<T> => {
  const endpoint = JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8")) as LocalEndpoint;
  if (endpoint.pid !== pid || typeof endpoint.port !== "number") throw new Error("Acceptance endpoint ownership changed for PID " + pid);
  const response = await fetch("http://127.0.0.1:" + endpoint.port, {
    method: "POST", body: JSON.stringify({ method, params })
  });
  if (!response.ok) throw new Error("Acceptance endpoint returned HTTP " + response.status);
  const payload = await response.json() as LocalRpcResponse;
  if (!payload.ok) throw new Error(payload.error ?? "Acceptance endpoint rejected " + method);
  return payload.result as T;
};

const prepareFixtureWorkspace = async (
  dataDir: string,
  pid: number,
  fixture: SessionTreeFixture | RealSessionFixture
): Promise<string> => {
  let workspaces = await callLocalEndpoint<WorkspaceInfo[]>(dataDir, pid, "workspace.list", {});
  let matching = workspaces.find((workspace) => resolve(workspace.rootPath) === resolve(fixture.projectPath));
  if (!matching) {
    if (workspaces.length) throw new Error("Acceptance fixture registered an unrelated workspace");
    await callLocalEndpoint(dataDir, pid, "workspace.add", { rootPath: fixture.projectPath, label: "Real Session Fixture" });
    workspaces = await callLocalEndpoint<WorkspaceInfo[]>(dataDir, pid, "workspace.list", {});
    matching = workspaces.find((workspace) => resolve(workspace.rootPath) === resolve(fixture.projectPath));
  }
  if (!matching) throw new Error("Acceptance fixture workspace was not registered through the running service");
  return matching.workspaceId;
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
    if (input.codexConfigSource && input.fixture !== "real-session") {
      throw new Error("codexConfigSource is only valid with fixture real-session");
    }
    const fixture: (SessionTreeFixture | RealSessionFixture) | undefined = input.fixture === "session-tree"
      ? await prepareSessionTreeFixture(dataDir, this.packageRoot)
      : input.fixture === "real-session"
        ? await prepareRealSessionFixture(dataDir, input.codexConfigSource)
        : undefined;
    const launchToken = randomUUID();
    const configuredCodexPath = await resolveConfiguredCodexPath();
    const env: Record<string, string> = {
      ...input.env,
      ...(fixture?.env ?? {}),
      VERMILLION_PERSISTENCE_BASE_DIR: dataDir,
      VERMILLION_USER_DATA_DIR: userDataDir,
      VERMILLION_REMOTE_DEBUGGING_PORT: String(input.port),
      VERMILLION_ACCEPTANCE_LAUNCH_TOKEN: launchToken,
      ...(fixture && !input.env?.CODEX_HOME && !fixture.env.CODEX_HOME ? { CODEX_HOME: join(dataDir, "codex") } : {})
    };
    if (!env.VERMILLION_CODEX_BIN && !env.CODEX_BIN && !env.CODEX_PATH && configuredCodexPath) {
      env.VERMILLION_CODEX_BIN = configuredCodexPath;
    }
    const launchArgs = process.platform === "win32"
      ? [...this.command.args, ...hiddenDesktopChromiumArgs]
      : this.command.args;
    const pid = process.platform === "win32" ? await this.startHidden(env, launchArgs) : await this.startPlain(env, launchArgs);
    const cdpUrl = "http://127.0.0.1:" + input.port;
    // Electron takes a few seconds to open its debugging port. Return only once it answers, so callers can attach
    // immediately; a CDP client that probes too early may fall back to launching its own browser.
    await waitForCdp(cdpUrl, async () => { await this.stop(pid); });
    try {
      await waitForEndpoint(join(dataDir, "endpoint.json"), pid, async () => { await this.stop(pid); });
      const workspaceId = fixture ? await prepareFixtureWorkspace(dataDir, pid, fixture) : undefined;
      if (input.fixture === "real-session") {
        const catalog = await callLocalEndpoint<EngineModelCatalogResult>(dataDir, pid, "engine.listModels", { engineId: "codex" });
        if (
          catalog.catalog?.engineId !== "codex" ||
          !Array.isArray(catalog.catalog.models) ||
          catalog.catalog.models.length === 0
        ) {
          throw new Error("The real-session Codex engine did not return a usable model catalog");
        }
      }
      await writeFile(join(dataDir, launchRecordFile), JSON.stringify({
        kind: "vermillion-acceptance", pid, desktop: process.platform === "win32" ? this.desktop : "", token: launchToken
      } satisfies AcceptanceLaunchRecord) + "\n", "utf8");
      const codexHome = fixture && "codexHome" in fixture ? (fixture as RealSessionFixture).codexHome : undefined;
      return {
        pid,
        cdpUrl,
        desktop: process.platform === "win32" ? this.desktop : "",
        dataDir,
        ...(fixture ? { projectPath: fixture.projectPath } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(codexHome ? { codexHome } : {})
      };
    } catch (error) {
      await this.stop(pid);
      throw error;
    }
  }

  async stop(pid: number): Promise<void> {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
    } else {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }

  private async startHidden(env: Record<string, string>, args: string[]): Promise<number> {
    if (!existsSync(this.scriptPath)) throw new Error("Launcher script missing: " + this.scriptPath);
    const quoted = args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(" ");
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath,
      "-Desktop", this.desktop, "-Exe", this.command.exe, "-Args", quoted, "-Cwd", this.command.cwd, "-EnvJson", JSON.stringify(env)
    ], { env: { ...process.env, ...env } });
    const pid = Number(stdout.trim().split(/\r?\n/).at(-1));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Launcher did not return a pid: " + stdout);
    return pid;
  }

  private async startPlain(env: Record<string, string>, args: string[]): Promise<number> {
    const { spawn } = await import("node:child_process");
    const child = spawn(this.command.exe, args, { cwd: this.command.cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" });
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
