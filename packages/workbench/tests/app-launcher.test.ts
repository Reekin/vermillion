import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppLauncher, resolveAppTarget, type AcceptanceLaunchRecord } from "../src/app-launcher.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("acceptance app target and lifecycle", () => {
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

  it("stops only the recorded instance and confirms process exit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "verm-stop-target-"));
    dirs.push(dataDir);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
    if (!child.pid) throw new Error("test child did not start");
    const instanceId = "recorded-instance", logPath = join(dataDir, "acceptance-launch.jsonl");
    const record: AcceptanceLaunchRecord = { kind: "vermillion-acceptance", pid: child.pid, port: 65431, desktop: "vermillion-qa",
      token: instanceId, targetPath: dataDir, buildId: "sha256:test", logPath };
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "app-start.json"), JSON.stringify(record), "utf8");
    await writeFile(logPath, "", "utf8");
    const launcher = new AppLauncher();
    await expect(launcher.stop({ dataDir, pid: child.pid, instanceId: "wrong" })).rejects.toThrow("identity does not match");
    await expect(launcher.stop({ dataDir, pid: child.pid, instanceId })).resolves.toMatchObject({ stopped: true, portReleased: true });
  });

  it.skipIf(process.platform !== "win32")("reports an early process exit with its stage and cleans it up", async () => {
    const release = await mkdtemp(join(tmpdir(), "verm-failing-release-"));
    const dataDir = await mkdtemp(join(tmpdir(), "verm-failing-launch-"));
    dirs.push(release, dataDir);
    await copyFile(process.execPath, join(release, "Vermillion.exe"));
    const scripts = join(release, "resources", "app", "scripts");
    await mkdir(scripts, { recursive: true });
    await copyFile(join(import.meta.dirname, "..", "scripts", "start-on-hidden-desktop.ps1"), join(scripts, "start-on-hidden-desktop.ps1"));
    const launcher = new AppLauncher({ timeoutMs: 2_000 });
    await expect(launcher.start({ targetPath: release, dataDir, port: 14979 })).rejects.toThrow(/app\.start failed at cdp: The app process exited.*cleanup=complete/);
  });
});
