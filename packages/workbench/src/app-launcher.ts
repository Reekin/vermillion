import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
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
  dataDir?: string;
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
export type AppStopInput = { dataDir: string; pid: number; instanceId: string; keepData?: boolean };
export type AppStopResult = { dataDir: string; pid: number; stopped: true; portReleased: true; warnings?: string[] };
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
  desktopOwnerPid?: number;
  exitFile?: string;
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
const cdpReady = async (port: number): Promise<boolean> => {
  try { return (await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
};
const tcpPortOpen = (port: number): Promise<boolean> => new Promise((resolveOpen) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const finish = (open: boolean) => { socket.destroy(); resolveOpen(open); };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.setTimeout(500, () => finish(false));
});
const logLine = async (path: string, stage: string, detail: object = {}) =>
  appendFile(path, JSON.stringify({ at: new Date().toISOString(), stage, ...detail }) + "\n", "utf8");
const readJsonFile = async <T>(path: string): Promise<T> =>
  JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as T;
type HiddenLaunch = { pid: number; ownerPid: number; desktop: string; exitFile: string };
type HiddenLaunchResult = { pid?: unknown; ownerPid?: unknown; desktop?: unknown; error?: unknown };
type HiddenExit = { pid?: unknown; exitCode?: unknown };
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
  const response = await fetch("http://127.0.0.1:" + endpoint.port, {
    method: "POST",
    headers: { "x-vermillion-instance-id": instanceId },
    body: JSON.stringify({ method, params })
  });
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
  const packageRoot = join(rootPath, "packages", "workbench");
  return { kind: "source", rootPath, packageRoot, revision, command: resolveAppCommand(packageRoot) };
};
const prepareTargetBuild = async (target: AppTarget): Promise<void> => {
  if (target.kind !== "source") return;
  const built = await execFileAsync(process.execPath, [join(target.rootPath, "scripts", "needs-build.mjs")], { cwd: target.rootPath }).then(() => true, () => false);
  if (!built) {
    const pnpm = process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "npm", "pnpm.cmd") : "pnpm";
    const args = ["--filter", "@vermillion/desktop...", "--workspace-concurrency=1", "build"];
    await execFileAsync(process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : pnpm,
      process.platform === "win32" ? ["/d", "/s", "/c", pnpm, ...args] : args,
      { cwd: target.rootPath, maxBuffer: 16 * 1024 * 1024 });
  }
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
    const root = await this.acceptanceRoot();
    const dataDir = input.dataDir ? await this.existingDataDir(root, input.dataDir) : join(root, randomUUID());
    const fresh = !input.dataDir;
    const userDataDir = join(dataDir, "electron");
    const logPath = join(dataDir, "acceptance-launch.jsonl");
    let stage = "directory";
    let pid: number | undefined;
    let desktopOwnerPid: number | undefined;
    let exitFile: string | undefined;
    try {
      if (fresh) await mkdir(dataDir);
      await mkdir(userDataDir, { recursive: true });
      if (fresh) await writeFile(logPath, "", "utf8");
      stage = "target";
      const target = await resolveAppTarget(input.targetPath, input.expectedRevision);
      await logLine(logPath, stage, { targetPath: target.rootPath, targetKind: target.kind, revision: target.revision });
      if (target.kind === "source" && !input.expectedRevision) throw new Error("A source acceptance target requires expectedRevision");
      if (target.kind === "release" && !input.expectedBuildId) throw new Error("A release acceptance target requires expectedBuildId");
      stage = "build";
      await prepareTargetBuild(target);
      if (input.codexConfigSource && input.fixture !== "real-session") throw new Error("codexConfigSource is only valid with fixture real-session");
      stage = "fixture";
      const fixture = input.fixture === "session-tree" ? await prepareSessionTreeFixture(dataDir, target.packageRoot)
        : input.fixture === "real-session" ? await prepareRealSessionFixture(dataDir, input.codexConfigSource) : undefined;
      const instanceId = randomUUID();
      const desktop = process.platform === "win32" ? `${this.desktop}-${instanceId}` : "";
      const configuredCodexPath = await resolveConfiguredCodexPath();
      const env: Record<string, string> = { ...input.env, ...(fixture?.env ?? {}), VERMILLION_PERSISTENCE_BASE_DIR: dataDir,
        VERMILLION_USER_DATA_DIR: userDataDir, VERMILLION_REMOTE_DEBUGGING_PORT: String(input.port),
        VERMILLION_ACCEPTANCE_LAUNCH_TOKEN: instanceId, VERMILLION_ACCEPTANCE_DESKTOP: desktop };
      if (!env.VERMILLION_CODEX_BIN && !env.CODEX_BIN && !env.CODEX_PATH && configuredCodexPath) env.VERMILLION_CODEX_BIN = configuredCodexPath;
      const args = process.platform === "win32" ? [...target.command.args, ...hiddenDesktopChromiumArgs] : target.command.args;
      stage = "process";
      if (process.platform === "win32") {
        const launched = await this.startHidden(target.command, target.packageRoot, dataDir, instanceId, desktop, env, args);
        pid = launched.pid;
        desktopOwnerPid = launched.ownerPid;
        exitFile = launched.exitFile;
      } else {
        pid = await this.startPlain(target.command, env, args);
      }
      await logLine(logPath, stage, { pid, desktopOwnerPid, desktop });
      stage = "cdp";
      const cdp = await waitUntil(() => cdpReady(input.port), pid, this.timeoutMs);
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
      const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid, port: input.port, desktop,
        token: instanceId, targetPath: target.rootPath, buildId: runtime.buildId, logPath, desktopOwnerPid, exitFile };
      await writeFile(join(dataDir, launchRecordFile), JSON.stringify(record) + "\n", "utf8");
      const targetDescriptor = join(dataDir, `acceptance-target-${instanceId}.json`);
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
      const observedExit = exitFile ? await this.readExit(exitFile, 500) : undefined;
      const cleanupWarnings = failedPid ? await this.terminate(failedPid, undefined, desktopOwnerPid) : [];
      const cleanup = failedPid ? !processRunning(failedPid) : true;
      const exit = observedExit !== undefined ? `exited (code ${observedExit})`
        : failedPid && !running ? "exited (exit code unavailable)" : failedPid ? "running" : "not-created";
      const message = error instanceof Error ? error.message : String(error);
      await logLine(logPath, "failed", { failedStage: stage, pid, processStatus: exit, cleanup, cleanupWarnings, error: message }).catch(() => undefined);
      const details = await readFile(logPath, "utf8").then((value) => value.trim().split("\n").slice(-3).join(" | "), () => "log unavailable");
      let directory = "retained";
      if (fresh && cleanup) {
        try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); directory = "removed"; }
        catch (removeError) { directory = "remove failed: " + String(removeError); }
      }
      throw new Error(`app.start failed at ${stage}: ${message}; target=${input.targetPath}; process=${failedPid ?? "not-created"}; status=${exit}; cleanup=${cleanup ? "complete" : "failed"}; dataDir=${dataDir} (${directory}); log=${details}`);
    }
  }
  async stop(input: AppStopInput): Promise<AppStopResult> {
    const dataDir = await this.existingDataDir(await this.acceptanceRoot(), input.dataDir, true);
    let record: AcceptanceLaunchRecord;
    try { record = JSON.parse(await readFile(join(dataDir, launchRecordFile), "utf8")) as AcceptanceLaunchRecord; }
    catch { throw new Error("app.stop target has no acceptance launch record: " + dataDir); }
    if (record.kind !== "vermillion-acceptance" || record.pid !== input.pid || record.token !== input.instanceId) throw new Error("app.stop target identity does not match the launch record");
    const wasRunning = processRunning(input.pid);
    let warnings: string[] = [];
    if (wasRunning) {
      try {
        const runtime = await callLocalEndpoint<RuntimeInfo>(dataDir, input.pid, input.instanceId, "runtime.info", {});
        if (runtime.pid !== input.pid) throw new Error("runtime PID mismatch");
      }
      catch { throw new Error("app.stop refused to terminate a running PID whose live instance identity cannot be confirmed"); }
      warnings = await this.terminate(input.pid, record.port, record.desktopOwnerPid);
    }
    if (processRunning(input.pid)) throw new Error("app.stop could not confirm process exit: " + input.pid);
    if (await tcpPortOpen(record.port)) throw new Error("app.stop could not confirm port release: " + record.port);
    await logLine(record.logPath, "stopped", { pid: input.pid, port: record.port });
    if (!input.keepData) await rm(dataDir, { recursive: true, maxRetries: 5, retryDelay: 100 });
    return { dataDir, pid: input.pid, stopped: true, portReleased: true, ...(warnings.length ? { warnings } : {}) };
  }
  private async acceptanceRoot(): Promise<string> {
    const base = resolve(process.env.VERMILLION_PERSISTENCE_BASE_DIR?.trim() || join(homedir(), ".vermillion"));
    await mkdir(base, { recursive: true });
    const root = join(await realpath(base), "acceptance");
    await mkdir(root, { recursive: true });
    return realpath(root);
  }
  private async existingDataDir(root: string, requested: string, allowRunning = false): Promise<string> {
    const path = resolve(requested);
    if (dirname(path).toLowerCase() !== root.toLowerCase()) throw new Error("Acceptance dataDir must be an app.start-managed instance directory: " + path);
    let actual: string;
    try { actual = await realpath(path); } catch { throw new Error("Acceptance dataDir does not exist: " + path); }
    if (dirname(actual).toLowerCase() !== root.toLowerCase()) throw new Error("Acceptance dataDir is outside the managed directory: " + path);
    const record = await readJsonFile<AcceptanceLaunchRecord>(join(actual, launchRecordFile)).catch(() => undefined);
    if (record?.kind !== "vermillion-acceptance" || record.logPath !== join(actual, "acceptance-launch.jsonl"))
      throw new Error("Acceptance dataDir has no app.start launch record: " + path);
    if (!allowRunning && processRunning(record.pid)) throw new Error("Acceptance dataDir is still running: " + path);
    return actual;
  }
  private async terminate(pid: number, port?: number, ownerPid?: number): Promise<string[]> {
    const warnings: string[] = [];
    if (processRunning(pid)) {
      if (process.platform === "win32") {
        try { await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]); }
        catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
      } else {
        process.kill(pid, "SIGTERM");
      }
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (processRunning(pid) || (port !== undefined && await tcpPortOpen(port)))) await sleep(100);
    if (ownerPid) {
      const ownerDeadline = Date.now() + 2_000;
      while (Date.now() < ownerDeadline && processRunning(ownerPid)) await sleep(50);
      if (processRunning(ownerPid) && process.platform === "win32") {
        try { await execFileAsync("taskkill", ["/PID", String(ownerPid), "/T", "/F"]); }
        catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
      }
    }
    return warnings;
  }
  private async readExit(path: string, timeoutMs = 0): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        const result = await readJsonFile<HiddenExit>(path);
        return typeof result.exitCode === "number" ? result.exitCode : undefined;
      } catch {}
      if (Date.now() < deadline) await sleep(25);
    } while (Date.now() < deadline);
    return undefined;
  }
  private async startHidden(command: AppCommand, packageRoot: string, dataDir: string, instanceId: string,
    desktop: string, env: Record<string, string>, args: string[]): Promise<HiddenLaunch> {
    const script = join(packageRoot, "scripts", "start-on-hidden-desktop.ps1");
    const ownerScript = join(packageRoot, "scripts", "hidden-desktop-owner.ps1");
    if (!existsSync(script)) throw new Error("Launcher script missing: " + script);
    if (!existsSync(ownerScript)) throw new Error("Hidden desktop owner script missing: " + ownerScript);
    const quoted = args.map((value) => /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value).join(" ");
    const requestFile = join(dataDir, `desktop-owner-${instanceId}.request.json`);
    const resultFile = join(dataDir, `desktop-owner-${instanceId}.result.json`);
    const exitFile = join(dataDir, `desktop-owner-${instanceId}.exit.json`);
    const ownerLogFile = join(dataDir, `desktop-owner-${instanceId}.log`);
    const ownerPidFile = join(dataDir, `desktop-owner-${instanceId}.pid`);
    await writeFile(requestFile, JSON.stringify({ desktop, exe: command.exe, args: quoted, cwd: command.cwd, env }), "utf8");
    const starter = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-OwnerScript", ownerScript, "-RequestFile", requestFile, "-ResultFile", resultFile,
      "-ExitFile", exitFile, "-OwnerLog", ownerLogFile, "-OwnerPidFile", ownerPidFile], {
      cwd: command.cwd, env: { ...process.env, ...env }, stdio: "ignore", windowsHide: true
    });
    starter.unref();
    let ownerPid = 0;
    const starterDeadline = Date.now() + Math.min(this.timeoutMs, 5_000);
    while (Date.now() < starterDeadline) {
      try { ownerPid = Number((await readFile(ownerPidFile, "utf8")).trim()); } catch {}
      if (Number.isInteger(ownerPid) && ownerPid > 0) break;
      if (starter.pid && !processRunning(starter.pid)) await sleep(25);
      else await sleep(25);
    }
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      if (starter.pid) await this.terminate(starter.pid);
      await sleep(100);
      try { ownerPid = Number((await readFile(ownerPidFile, "utf8")).trim()); } catch {}
      if (Number.isInteger(ownerPid) && ownerPid > 0) await this.terminate(ownerPid);
      throw new Error("Hidden desktop starter did not publish an owner PID");
    }
    const deadline = Date.now() + Math.min(this.timeoutMs, 10_000);
    while (Date.now() < deadline) {
      try {
        const result = await readJsonFile<HiddenLaunchResult>(resultFile);
        if (typeof result.error === "string") throw new Error(result.error);
        if (typeof result.pid === "number" && typeof result.ownerPid === "number" && typeof result.desktop === "string") {
          return { pid: result.pid, ownerPid: result.ownerPid, desktop: result.desktop, exitFile };
        }
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
          // The owner publishes atomically enough for the next poll to retry a partial/missing file.
        } else {
          if (processRunning(ownerPid)) await this.terminate(ownerPid);
          throw error;
        }
      }
      if (!processRunning(ownerPid)) {
        await sleep(50);
        try {
          const result = await readJsonFile<HiddenLaunchResult>(resultFile);
          if (typeof result.error === "string") throw new Error(result.error);
          if (typeof result.pid === "number" && typeof result.ownerPid === "number" && typeof result.desktop === "string") {
            return { pid: result.pid, ownerPid: result.ownerPid, desktop: result.desktop, exitFile };
          }
        } catch (error) {
          if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        throw new Error("Hidden desktop owner exited before launching the app; ownerLog=" + ownerLogFile);
      }
      await sleep(50);
    }
    await this.terminate(ownerPid);
    throw new Error("Hidden desktop owner did not publish the app process");
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
