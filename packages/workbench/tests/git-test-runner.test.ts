import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { runFile } from "./run-git-tests.mjs";

it("kills the whole isolated test process on timeout before another file can inherit its work", async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-git-runner-"));
  const marker = join(root, "pid.txt");
  vi.stubEnv("VERMILLION_GIT_TEST_MARKER", marker);
  // Advance only the runner deadline after the fixture reports readiness.
  // Real Node/Vitest startup and process-tree shutdown remain on real time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const running = runFile("tests/fixtures/hanging-git-runner.test.ts");
  try {
    const deadline = performance.now() + 10_000;
    while (true) {
      try { JSON.parse(await readFile(marker, "utf8")); break; }
      catch (error) {
        if (performance.now() >= deadline) throw error;
        await sleep(25);
      }
    }
    await vi.runOnlyPendingTimersAsync();
    await expect(running).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("process tree stopped") });
    const { pid, childPid, tempRoot } = JSON.parse(await readFile(marker, "utf8")) as { pid: number; childPid: number; tempRoot: string };
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(childPid, 0)).toThrow();
    await expect(stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await vi.runOnlyPendingTimersAsync();
    await running;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
