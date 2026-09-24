import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppLauncher, resolveAppTarget, type AcceptanceLaunchRecord } from "../src/app-launcher.js";
import { startLocalEndpoint } from "../src/local-endpoint.js";

const dirs: string[] = [];
const originalBase = process.env.VERMILLION_PERSISTENCE_BASE_DIR;
let acceptanceRoot: string;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "verm-managed-"));
  dirs.push(base);
  process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
  acceptanceRoot = join(base, "acceptance");
  await mkdir(acceptanceRoot);
});
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  if (originalBase === undefined) delete process.env.VERMILLION_PERSISTENCE_BASE_DIR;
  else process.env.VERMILLION_PERSISTENCE_BASE_DIR = originalBase;
});
const managedDir = async (name: string) => {
  const path = join(acceptanceRoot, name);
  await mkdir(path);
  return path;
};

describe("acceptance app target and lifecycle", () => {
  it.skipIf(process.platform !== "win32")("keeps the hidden desktop owner alive until its app exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "verm desktop owner-"));
    dirs.push(root);
    const requestFile = join(root, "request.json"), resultFile = join(root, "result.json"), exitFile = join(root, "exit.json");
    const childScript = join(root, "child.cjs");
    await writeFile(childScript, "setInterval(() => {}, 1000);\n", "utf8");
    await writeFile(requestFile, JSON.stringify({ desktop: `verm-test-${Date.now()}`, exe: process.execPath,
      args: `\"${childScript}\"`, cwd: root, env: {} }), "utf8");
    const ownerLog = join(root, "owner.log"), ownerPidFile = join(root, "owner.pid");
    const starter = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(import.meta.dirname, "..", "scripts", "start-on-hidden-desktop.ps1"),
      "-OwnerScript", join(import.meta.dirname, "..", "scripts", "hidden-desktop-owner.ps1"),
      "-RequestFile", requestFile, "-ResultFile", resultFile, "-ExitFile", exitFile,
      "-OwnerLog", ownerLog, "-OwnerPidFile", ownerPidFile], { windowsHide: true, stdio: "ignore" });
    starter.unref();
    let ownerPid = 0;
    let appPid: number | undefined;
    let launchError: unknown;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          ownerPid ||= Number((await readFile(ownerPidFile, "utf8")).trim());
          const result = JSON.parse((await readFile(resultFile, "utf8")).replace(/^\uFEFF/, "")) as { pid?: number; error?: string };
          if (result.error) throw new Error(result.error);
          if (typeof result.pid !== "number") throw new SyntaxError("owner result is incomplete");
          appPid = result.pid;
          break;
        } catch (error) { launchError = error; await new Promise((done) => setTimeout(done, 25)); }
      }
      if (!appPid && launchError) throw launchError;
      expect(appPid).toBeTypeOf("number");
      expect(() => process.kill(ownerPid, 0)).not.toThrow();
      expect(() => process.kill(appPid!, 0)).not.toThrow();
      execFileSync("taskkill", ["/PID", String(appPid), "/T", "/F"]);
      const ownerDeadline = Date.now() + 5_000;
      while (Date.now() < ownerDeadline) {
        try { process.kill(ownerPid, 0); } catch { break; }
        await new Promise((done) => setTimeout(done, 25));
      }
      expect(() => process.kill(ownerPid, 0)).toThrow();
      expect(JSON.parse((await readFile(exitFile, "utf8")).replace(/^\uFEFF/, ""))).toMatchObject({ pid: appPid });
    } finally {
      if (appPid) try { process.kill(appPid, 0); execFileSync("taskkill", ["/PID", String(appPid), "/T", "/F"]); } catch {}
      try { process.kill(ownerPid, 0); execFileSync("taskkill", ["/PID", String(ownerPid), "/T", "/F"]); } catch {}
    }
  });

  it("rejects missing targets and a source revision mismatch before launch", async () => {
    await expect(resolveAppTarget(join(tmpdir(), "missing-vermillion-target"))).rejects.toThrow("does not exist");
    const root = join(import.meta.dirname, "..", "..", "..");
    await expect(resolveAppTarget(root, "0000000000000000000000000000000000000000")).rejects.toThrow("revision mismatch");
    const dirty = await mkdtemp(join(tmpdir(), "verm-dirty-target-"));
    dirs.push(dirty);
    await mkdir(join(dirty, "apps", "desktop"), { recursive: true });
    await mkdir(join(dirty, "packages", "workbench"), { recursive: true });
    await writeFile(join(dirty, "package.json"), "{}\n", "utf8");
    await writeFile(join(dirty, "apps", "desktop", "package.json"), "{}\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: dirty });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dirty });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dirty });
    execFileSync("git", ["add", "."], { cwd: dirty });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dirty });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirty, encoding: "utf8" }).trim();
    await writeFile(join(dirty, "package.json"), "{\"dirty\":true}\n", "utf8");
    await expect(resolveAppTarget(dirty, revision)).rejects.toThrow("uncommitted changes");
  });

  it("recognizes an unpacked release without treating it as a source checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "verm-release-target-"));
    dirs.push(root);
    await writeFile(join(root, "Vermillion.exe"), "fixture", "utf8");
    const target = await resolveAppTarget(root);
    expect(target).toMatchObject({ kind: "release", rootPath: root, command: { exe: join(root, "Vermillion.exe") } });
  });

  it("rejects caller-owned data directories before creating a launch", async () => {
    const outside = await mkdtemp(join(tmpdir(), "verm-caller-data-"));
    dirs.push(outside);
    await expect(new AppLauncher().start({ targetPath: outside, dataDir: outside, port: 14979 }))
      .rejects.toThrow("app.start-managed instance directory");
    expect(await stat(outside)).toBeDefined();
  });

  it("keeps an existing managed directory after a restart fails", async () => {
    const dataDir = await managedDir("restart-target");
    const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid: 2147483646, port: 65429, desktop: "vermillion-qa",
      token: "previous-instance", targetPath: dataDir, buildId: "sha256:test", logPath: join(dataDir, "acceptance-launch.jsonl") };
    await writeFile(join(dataDir, "app-start.json"), JSON.stringify(record), "utf8");
    await writeFile(record.logPath, "", "utf8");
    await writeFile(join(dataDir, "saved-state.txt"), "unchanged", "utf8");
    await expect(new AppLauncher().start({ targetPath: join(dataDir, "missing-target"), dataDir, port: 14979 }))
      .rejects.toThrow(/app\.start failed at target:.*dataDir=.*retained.*log=/);
    expect(await readFile(join(dataDir, "saved-state.txt"), "utf8")).toBe("unchanged");
  });

  it("stops only the recorded instance and confirms process exit", async () => {
    const dataDir = await managedDir("stop-target");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
    if (!child.pid) throw new Error("test child did not start");
    const instanceId = "recorded-instance", logPath = join(dataDir, "acceptance-launch.jsonl");
    const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid: child.pid, port: 65431, desktop: "vermillion-qa",
      token: instanceId, targetPath: dataDir, buildId: "sha256:test", logPath };
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "app-start.json"), JSON.stringify(record), "utf8");
    await writeFile(logPath, "", "utf8");
    const endpoint = await startLocalEndpoint(dataDir, async () => ({ ok: true, result: { pid: child.pid, buildId: "sha256:test" } }), { pid: child.pid, instanceId });
    const launcher = new AppLauncher();
    try {
      await expect(launcher.stop({ dataDir, pid: child.pid, instanceId: "wrong" })).rejects.toThrow("identity does not match");
      await expect(launcher.stop({ dataDir, pid: child.pid, instanceId })).resolves.toMatchObject({ stopped: true, portReleased: true });
      await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await endpoint.close();
    }
  });

  it("keeps a stopped instance directory when requested", async () => {
    const dataDir = await managedDir("keep-target");
    const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid: 2147483646, port: 65429, desktop: "vermillion-qa",
      token: "kept-instance", targetPath: dataDir, buildId: "sha256:test", logPath: join(dataDir, "acceptance-launch.jsonl") };
    await writeFile(join(dataDir, "app-start.json"), JSON.stringify(record), "utf8");
    await writeFile(record.logPath, "", "utf8");
    const launcher = new AppLauncher();
    await launcher.stop({ dataDir, pid: record.pid, instanceId: record.token, keepData: true });
    expect(await stat(dataDir)).toBeDefined();
    await launcher.stop({ dataDir, pid: record.pid, instanceId: record.token });
    await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to stop a live process when runtime identity reports another PID", async () => {
    const dataDir = await managedDir("stop-runtime-mismatch");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
    if (!child.pid) throw new Error("test child did not start");
    const instanceId = "runtime-mismatch", logPath = join(dataDir, "acceptance-launch.jsonl");
    const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid: child.pid, port: 65430, desktop: "vermillion-qa",
      token: instanceId, targetPath: dataDir, buildId: "sha256:test", logPath };
    await writeFile(join(dataDir, "app-start.json"), JSON.stringify(record), "utf8");
    await writeFile(logPath, "", "utf8");
    const endpoint = await startLocalEndpoint(dataDir, async () => ({ ok: true, result: { pid: child.pid + 1, buildId: "sha256:test" } }), { pid: child.pid, instanceId });
    try {
      await expect(new AppLauncher().stop({ dataDir, pid: child.pid, instanceId })).rejects.toThrow("live instance identity cannot be confirmed");
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      await endpoint.close();
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }
  });

  it("does not report a port released while another listener still owns it", async () => {
    const dataDir = await managedDir("stop-port");
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid: 2147483646, port, desktop: "vermillion-qa",
      token: "stopped-instance", targetPath: dataDir, buildId: "sha256:test", logPath: join(dataDir, "acceptance-launch.jsonl") };
    await writeFile(join(dataDir, "app-start.json"), JSON.stringify(record), "utf8");
    await writeFile(record.logPath, "", "utf8");
    try {
      await expect(new AppLauncher().stop({ dataDir, pid: record.pid, instanceId: record.token })).rejects.toThrow("port release");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it.skipIf(process.platform !== "win32")("reports an early process exit with its stage and cleans it up", async () => {
    const release = await mkdtemp(join(tmpdir(), "verm-failing-release-"));
    dirs.push(release);
    await copyFile(process.execPath, join(release, "Vermillion.exe"));
    const scripts = join(release, "resources", "app", "scripts");
    await mkdir(scripts, { recursive: true });
    await copyFile(join(import.meta.dirname, "..", "scripts", "start-on-hidden-desktop.ps1"), join(scripts, "start-on-hidden-desktop.ps1"));
    await copyFile(join(import.meta.dirname, "..", "scripts", "hidden-desktop-owner.ps1"), join(scripts, "hidden-desktop-owner.ps1"));
    const launcher = new AppLauncher({ timeoutMs: 2_000 });
    await expect(launcher.start({ targetPath: release, expectedBuildId: "sha256:test", port: 14979 }))
      .rejects.toThrow(/app\.start failed at (process|cdp): .*(exited|CreateProcess).*cleanup=complete/);
    expect(await import("node:fs/promises").then((fs) => fs.readdir(acceptanceRoot))).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("terminates a starter that does not publish ownership before its deadline", async () => {
    const release = await mkdtemp(join(tmpdir(), "verm-stalled-release-"));
    dirs.push(release);
    await copyFile(process.execPath, join(release, "Vermillion.exe"));
    const scripts = join(release, "resources", "app", "scripts"), marker = join(release, "late-starter.txt");
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, "hidden-desktop-owner.ps1"), "# fixture\n", "utf8");
    await writeFile(join(scripts, "start-on-hidden-desktop.ps1"), [
      "param([string]$OwnerScript,[string]$RequestFile,[string]$ResultFile,[string]$ExitFile,[string]$OwnerLog,[string]$OwnerPidFile)",
      "Start-Sleep -Seconds 2",
      `$PID | Set-Content -LiteralPath '${marker.replace(/'/g, "''")}'`
    ].join("\n"), "utf8");
    const launcher = new AppLauncher({ timeoutMs: 300 });
    await expect(launcher.start({ targetPath: release, expectedBuildId: "sha256:test", port: 14978 }))
      .rejects.toThrow(/app\.start failed at process: Hidden desktop starter did not publish an owner PID.*cleanup=complete/);
    await new Promise((done) => setTimeout(done, 2_100));
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
