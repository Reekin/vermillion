import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitest = resolve(packageRoot, "..", "..", "node_modules", "vitest", "vitest.mjs");
const defaults = [
  "tests/app-launcher.test.ts",
  "tests/docs-diff.test.ts",
  "tests/docs-discard.test.ts",
  "tests/docs-draft.test.ts",
  "tests/integration-git.test.ts",
  "tests/workflow-git.test.ts",
  "tests/worktree-cleanup.test.ts"
];
const files = process.env.VERMILLION_GIT_TEST_FILES?.split(",").filter(Boolean) ?? defaults;
const concurrency = Number(process.env.VERMILLION_GIT_TEST_MAX_WORKERS ?? 2);
const timeoutMs = Number(process.env.VERMILLION_GIT_TEST_TIMEOUT_MS ?? 90_000);
if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
  throw new Error("Invalid Git test runner limits");
}

const processRunning = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const killTree = async (pid) => {
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]); }
    catch (error) { if (processRunning(pid)) throw error; }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processRunning(pid)) await new Promise((done) => setTimeout(done, 25));
  if (processRunning(pid)) throw new Error("Test process tree did not stop: " + pid);
};

const runFile = async (file) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "verm-git-file-"));
  return new Promise((resolveRun) => {
  const child = spawn(process.execPath, [vitest, "run", file, "--testTimeout=0", "--hookTimeout=0"], {
    cwd: packageRoot,
    env: { ...process.env, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot },
    detached: process.platform !== "win32",
    stdio: "inherit"
  });
  if (!child.pid) {
    void rm(tempRoot, { recursive: true, force: true }).finally(() =>
      resolveRun({ file, ok: false, reason: "spawn failed", fatal: true }));
    return;
  }
  let timedOut = false;
  let finished = false;
  const finish = async (code, signal, fatalError) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (fatalError) {
      child.removeAllListeners();
      child.unref();
      resolveRun({ file, ok: false, fatal: true, tempRoot,
        reason: `process-tree termination failed: ${fatalError instanceof Error ? fatalError.message : String(fatalError)}` });
      return;
    }
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      resolveRun({ file, ok: !timedOut && code === 0,
        reason: timedOut ? `timed out after ${timeoutMs}ms; process tree stopped` : `exit ${code ?? signal}` });
    } catch (error) {
      resolveRun({ file, ok: false, fatal: true, tempRoot,
        reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child.pid).then(
      () => finish(undefined, undefined, undefined),
      (error) => finish(undefined, undefined, error)
    );
  }, timeoutMs);
  child.once("exit", (code, signal) => { if (!timedOut) void finish(code, signal, undefined); });
  });
};

let next = 0;
const results = [];
let fatal = false;
const worker = async () => {
  while (!fatal && next < files.length) {
    const file = files[next++];
    const result = await runFile(file);
    results.push(result);
    if (result.fatal) fatal = true;
    if (!result.ok) process.exitCode = 1;
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
for (const result of results) process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.file} (${result.reason})\n`);
