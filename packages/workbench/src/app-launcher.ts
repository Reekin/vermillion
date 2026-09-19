import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareRealSessionFixture, type RealSessionFixture } from "./real-session-fixture.js";
import { prepareSessionTreeFixture, type SessionTreeFixture } from "./session-tree-fixture.js";

const execFileAsync = promisify(execFile);

export type AppStartInput = {
  targetPath: string;
  expectedRevision?: string;
  expectedBuildId?: string;
  dataDir: string;
  userDataDir?: string;
  port: number;
  fixture?: "session-tree" | "real-session";
  codexConfigSource?: string;
  env?: Record<string, string>;
};
export type DirectedCliTarget = { targetFile: string; executable: string; args: string[] };
export type AppStartResult = {
  pid: number;
  instanceId: string;
  cdpUrl: string;
  desktop: string;
  dataDir: string;
  targetPath: string;
  targetKind: "source" | "release";
  targetRevision?: string;
  buildId: string;
  logPath: string;
  cli: DirectedCliTarget;
  engineEnv?: Record<string, string>;
  projectPath?: string;
  workspaceId?: string;
  codexHome?: string;
  piAgentDir?: string;
};
export type AppStopInput = { dataDir: string; pid: number; instanceId: string };
export type AppStopResult = { dataDir: string; pid: number; stopped: true; portReleased: true };
export type AppWindowAction = "status" | "minimize" | "restore";
export type AppWindowInput = { dataDir: string; pid: number; action: AppWindowAction };
export type AppWindowResult = { dataDir: string; pid: number; action: AppWindowAction; visible: boolean; minimized: boolean };
export type AcceptanceLaunchRecord = {
  kind: "vermillion-acceptance";
  pid: number;
  port: number;
  desktop: string;
  token: string;
  targetPath: string;
  buildId: string;
  logPath: string;
};
export type AppLauncherOptions = { desktop?: string; timeoutMs?: number };
type AppCommand = { exe: string; args: string[]; cwd: string };
type AppTarget = { kind: "source" | "release"; rootPath: string; command: AppCommand; packageRoot: string; revision?: string };
type LocalEndpoint = { port?: unknown; pid?: unknown; instanceId?: unknown };
type WorkspaceInfo = { workspaceId: string; rootPath: string };
type RuntimeInfo = { buildId?: unknown; pid?: unknown };
type EngineModelCatalogResult = { catalog?: { engineId?: unknown; models?: unknown[] } };
type LocalRpcResponse = { ok?: boolean; result?: unknown; error?: string };

const launchRecordFile = "app-start.json";
const targetFile = "acceptance-target.json";
const hiddenDesktopChromiumArgs = ["--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows"];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const processRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const portOpen = async (port: number): Promise<boolean> => {
  try { return (await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
};
const logLine = async (path: string, stage: string, detail: object = {}) =>
  appendFile(path, JSON.stringify({ at: new Date().toISOString(), stage, ...detail }) + "\n", "utf8");
const waitUntil = async (check: () => Promise<boolean>, pid: number, timeoutMs: number): Promise<"ready" | "exited" | "timeout"> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processRunning(pid)) return "exited";
    if (await check()) return "ready";
    await sleep(250);
  }
  return "timeout";
};

const resolveConfiguredCodexPath = async (): Promise<string | undefined> => {
  for (const value of [process.env.VERMILLION_CODEX_BIN, process.env.CODEX_BIN, process.env.CODEX_PATH]) if (value?.trim()) return value.trim();
  try {
    const registry = JSON.parse(await readFile(join(homedir(), ".vermillion", "workspace-registry.json"), "utf8")) as { engineProgramPathsByEngineId?: Record<string, unknown> };
    const configured = registry.engineProgramPathsByEngineId?.codex;
    return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  } catch { return undefined; }
};

const callLocalEndpoint = async <T>(dataDir: string, pid: number, instanceId: string, method: string, params: object): Promise<T> => {
  const endpoint = JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8")) as LocalEndpoint;
  if (endpoint.pid !== pid || endpoint.instanceId !== instanceId || typeof endpoint.port !== "number") throw new Error("Acceptance endpoint identity changed");
  const response = await fetch("http://127.0.0.1:" + endpoint.port, { method: "POST", body: JSON.stringify({ method, params }) });
  if (!response.ok) throw new Error("Acceptance endpoint returned HTTP " + response.status);
  const payload = await response.json() as LocalRpcResponse;
  if (!payload.ok) throw new Error(payload.error ?? "Acceptance endpoint rejected " + method);
  return payload.result as T;
};
const prepareFixtureWorkspace = async (dataDir: string, pid: number, instanceId: string, fixture: SessionTreeFixture | RealSessionFixture): Promise<string> => {
  let workspaces = await callLocalEndpoint<WorkspaceInfo[]>(dataDir, pid, instanceId, "workspace.list", {});
  let matching = workspaces.find((workspace) => resolve(workspace.rootPath) === resolve(fixture.projectPath));
  if (!matching) {
    if (workspaces.length) throw new Error("Acceptance fixture registered an unrelated workspace");
    await callLocalEndpoint(dataDir, pid, instanceId, "workspace.add", { rootPath: fixture.projectPath, label: "Real Session Fixture" });
    workspaces = await callLocalEndpoint<WorkspaceInfo[]>(dataDir, pid, instanceId, "workspace.list", {});
    matching = workspaces.find((workspace) => resolve(workspace.rootPath) === resolve(fixture.projectPath));
  }
  if (!matching) throw new Error("Acceptance fixture workspace was not registered through the running service");
  return matching.workspaceId;
};

const sourceTarget = async (rootPath: string, expectedRevision?: string): Promise<AppTarget> => {
  for (const path of [join(rootPath, "package.json"), join(rootPath, "apps", "desktop", "package.json"), join(rootPath, "packages", "workbench")]) {
    if (!existsSync(path)) throw new Error("Source acceptance target is incomplete: " + rootPath);
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootPath });
  const revision = stdout.trim();
  if (expectedRevision && revision.toLowerCase() !== expectedRevision.toLowerCase()) throw new Error(`Acceptance target revision mismatch: expected ${expectedRevision}, found ${revision}`);
  if (expectedRevision) {
    const status = (await execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: rootPath })).stdout;
    if (status.length) throw new Error("Acceptance target has uncommitted changes and cannot represent expectedRevision: " + rootPath);
  }
  const built = await execFileAsync(process.execPath, [join(rootPath, "scripts", "needs-build.mjs")], { cwd: rootPath }).then(() => true, () => false);
  if (!built) {
    const pnpm = process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "npm", "pnpm.cmd") : "pnpm";
    const args = ["--filter", "@vermillion/desktop...", "--workspace-concurrency=1", "build"];
    await execFileAsync(process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : pnpm,
      process.platform === "win32" ? ["/d", "/s", "/c", pnpm, ...args] : args,
      { cwd: rootPath, maxBuffer: 16 * 1024 * 1024 });
  }
  const packageRoot = join(rootPath, "packages", "workbench");
  return { kind: "source", rootPath, packageRoot, revision, command: resolveAppCommand(packageRoot) };
};
export const resolveAppTarget = async (targetPath: string, expectedRevision?: string): Promise<AppTarget> => {
  const requested = resolve(targetPath);
  let info; try { info = await stat(requested); } catch { throw new Error("Acceptance target does not exist: " + requested); }
  const executable = info.isFile() ? requested : join(requested, "Vermillion.exe");
  if (existsSync(executable) && basename(executable).toLowerCase() === "vermillion.exe") {
    if (expectedRevision) throw new Error("expectedRevision is only valid for a source checkout");
    return { kind: "release", rootPath: dirname(executable), packageRoot: join(dirname(executable), "resources", "app"), command: { exe: executable, args: [], cwd: dirname(executable) } };
  }
  if (!info.isDirectory()) throw new Error("Acceptance target must be a source checkout or Vermillion release: " + requested);
  return sourceTarget(requested, expectedRevision);
};

export class AppLauncher {
  private readonly desktop: string;
  private readonly timeoutMs: number;
  constructor(options: AppLauncherOptions = {}) {
    this.desktop = options.desktop ?? "vermillion-qa";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }
  async start(input: AppStartInput): Promise<AppStartResult> {
    const dataDir = resolve(input.dataDir);
    const userDataDir = resolve(input.userDataDir ?? join(dataDir, "electron"));
    await mkdir(dataDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    const logPath = join(dataDir, "acceptance-launch.jsonl");
    await writeFile(logPath, "", "utf8");
    let stage = "target";
    let pid: number | undefined;
    try {
      const target = await resolveAppTarget(input.targetPath, input.expectedRevision);
      await logLine(logPath, stage, { targetPath: target.rootPath, targetKind: target.kind, revision: target.revision });
      if (input.codexConfigSource && input.fixture !== "real-session") throw new Error("codexConfigSource is only valid with fixture real-session");
      stage = "fixture";
      const fixture = input.fixture === "session-tree" ? await prepareSessionTreeFixture(dataDir, target.packageRoot)
        : input.fixture === "real-session" ? await prepareRealSessionFixture(dataDir, input.codexConfigSource) : undefined;
      const instanceId = randomUUID();
      const configuredCodexPath = await resolveConfiguredCodexPath();
      const env: Record<string, string> = { ...input.env, ...(fixture?.env ?? {}), VERMILLION_PERSISTENCE_BASE_DIR: dataDir,
        VERMILLION_USER_DATA_DIR: userDataDir, VERMILLION_REMOTE_DEBUGGING_PORT: String(input.port), VERMILLION_ACCEPTANCE_LAUNCH_TOKEN: instanceId };
      if (!env.VERMILLION_CODEX_BIN && !env.CODEX_BIN && !env.CODEX_PATH && configuredCodexPath) env.VERMILLION_CODEX_BIN = configuredCodexPath;
      const args = process.platform === "win32" ? [...target.command.args, ...hiddenDesktopChromiumArgs] : target.command.args;
      stage = "process";
      pid = process.platform === "win32" ? await this.startHidden(target.command, target.packageRoot, env, args) : await this.startPlain(target.command, env, args);
      await logLine(logPath, stage, { pid });
      stage = "cdp";
      const cdp = await waitUntil(() => portOpen(input.port), pid, this.timeoutMs);
      if (cdp !== "ready") throw new Error(cdp === "exited" ? "The app process exited before opening CDP" : "The app did not open CDP within " + this.timeoutMs / 1000 + "s");
      stage = "rpc";
      const endpoint = await waitUntil(async () => {
        try { const value = JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8")) as LocalEndpoint; return value.pid === pid && value.instanceId === instanceId; } catch { return false; }
      }, pid, this.timeoutMs);
      if (endpoint !== "ready") throw new Error(endpoint === "exited" ? "The app process exited before publishing RPC" : "The app did not publish RPC within " + this.timeoutMs / 1000 + "s");
      const runtime = await callLocalEndpoint<RuntimeInfo>(dataDir, pid, instanceId, "runtime.info", {});
      if (runtime.pid !== pid || typeof runtime.buildId !== "string") throw new Error("Runtime identity did not match the launched process");
      if (input.expectedBuildId && runtime.buildId !== input.expectedBuildId) throw new Error(`Acceptance build mismatch: expected ${input.expectedBuildId}, found ${runtime.buildId}`);
      const workspaceId = fixture ? await prepareFixtureWorkspace(dataDir, pid, instanceId, fixture) : undefined;
      if (input.fixture === "real-session") {
        const catalog = await callLocalEndpoint<EngineModelCatalogResult>(dataDir, pid, instanceId, "engine.listModels", { engineId: "codex" });
        if (catalog.catalog?.engineId !== "codex" || !Array.isArray(catalog.catalog.models) || !catalog.catalog.models.length) throw new Error("The real-session Codex engine did not return a usable model catalog");
      }
      const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid, port: input.port, desktop: process.platform === "win32" ? this.desktop : "",
        token: instanceId, targetPath: target.rootPath, buildId: runtime.buildId, logPath };
      await writeFile(join(dataDir, launchRecordFile), JSON.stringify(record) + "\n", "utf8");
      const targetDescriptor = join(dataDir, targetFile);
      await writeFile(targetDescriptor, JSON.stringify({ dataDir, pid, instanceId }) + "\n", "utf8");
      await logLine(logPath, "ready", { pid, buildId: runtime.buildId });
      const real = fixture && "codexHome" in fixture ? fixture as RealSessionFixture : undefined;
      const cliExecutable = target.kind === "source" ? process.execPath : join(target.rootPath, "vermillion-cli.cmd");
      const cliArgs = target.kind === "source" ? [join(target.rootPath, "packages", "workbench", "bin", "vermillion.mjs"), "--target", targetDescriptor] : ["--target", targetDescriptor];
      return { pid, instanceId, cdpUrl: "http://127.0.0.1:" + input.port, desktop: record.desktop, dataDir, targetPath: target.rootPath,
        targetKind: target.kind, ...(target.revision ? { targetRevision: target.revision } : {}), buildId: runtime.buildId, logPath,
        cli: { targetFile: targetDescriptor, executable: cliExecutable, args: cliArgs }, ...(fixture ? { projectPath: fixture.projectPath } : {}),
        ...(workspaceId ? { workspaceId } : {}), ...(real ? { codexHome: real.codexHome, piAgentDir: real.piAgentDir, engineEnv: real.env } : {}) };
    } catch (error) {
      const failedPid = pid;
      const running = failedPid ? processRunning(failedPid) : false;
      const cleanup = failedPid ? await this.terminate(failedPid).then(() => !processRunning(failedPid), () => false) : true;
      await logLine(logPath, "failed", { failedStage: stage, pid, processRunning: running, cleanup, error: error instanceof Error ? error.message : String(error) });
      throw new Error(`app.start failed at ${stage}: ${error instanceof Error ? error.message : String(error)}; log=${logPath}; process=${pid ?? "not-created"}; cleanup=${cleanup ? "complete" : "failed"}`);
    }
  }
  async stop(input: AppStopInput): Promise<AppStopResult> {
    const dataDir = resolve(input.dataDir);
    let record: AcceptanceLaunchRecord;
    try { record = JSON.parse(await readFile(join(dataDir, launchRecordFile), "utf8")) as AcceptanceLaunchRecord; }
    catch { throw new Error("app.stop target has no acceptance launch record: " + dataDir); }
    if (record.kind !== "vermillion-acceptance" || record.pid !== input.pid || record.token !== input.instanceId) throw new Error("app.stop target identity does not match the launch record");
    await this.terminate(input.pid, record.port);
    if (processRunning(input.pid)) throw new Error("app.stop could not confirm process exit: " + input.pid);
    if (await portOpen(record.port)) throw new Error("app.stop could not confirm CDP port release: " + record.port);
    await logLine(record.logPath, "stopped", { pid: input.pid, port: record.port });
    return { dataDir, pid: input.pid, stopped: true, portReleased: true };
  }
  private async terminate(pid: number, port?: number): Promise<void> {
    if (processRunning(pid)) {
      if (process.platform === "win32") await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]); else process.kill(pid, "SIGTERM");
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (processRunning(pid) || (port !== undefined && await portOpen(port)))) await sleep(100);
  }
  private async startHidden(command: AppCommand, packageRoot: string, env: Record<string, string>, args: string[]): Promise<number> {
    const script = join(packageRoot, "scripts", "start-on-hidden-desktop.ps1");
    if (!existsSync(script)) throw new Error("Launcher script missing: " + script);
    const quoted = args.map((value) => /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value).join(" ");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Desktop", this.desktop, "-Exe", command.exe, "-Args", quoted, "-Cwd", command.cwd, "-EnvJson", JSON.stringify(env)], { env: { ...process.env, ...env } });
    const pid = Number(stdout.trim().split(/\r?\n/).at(-1));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Launcher did not return a pid: " + stdout);
    return pid;
  }
  private async startPlain(command: AppCommand, env: Record<string, string>, args: string[]): Promise<number> {
    const { spawn } = await import("node:child_process");
    const child = spawn(command.exe, args, { cwd: command.cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" });
    child.unref();
    if (!child.pid) throw new Error("spawn failed");
    return child.pid;
  }
}

export const resolveAppCommand = (appRoot: string): AppCommand => {
  const repoRoot = resolve(appRoot, "..", ".."), desktopDir = resolve(repoRoot, "apps", "desktop");
  const electron = process.platform === "win32" ? resolve(repoRoot, "node_modules", "electron", "dist", "electron.exe") : resolve(repoRoot, "node_modules", "electron", "dist", "electron");
  return { exe: electron, args: [resolve(desktopDir, "dist-electron", "main.js")], cwd: desktopDir };
};
