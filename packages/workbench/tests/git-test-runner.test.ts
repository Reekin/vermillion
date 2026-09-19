import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("kills the whole isolated test process on timeout before another file can inherit its work", async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-git-runner-"));
  const marker = join(root, "pid.txt");
  try {
    await expect(execFileAsync(process.execPath, [join(import.meta.dirname, "run-git-tests.mjs")], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, VERMILLION_GIT_TEST_FILES: "tests/fixtures/hanging-git-runner.test.ts",
        VERMILLION_GIT_TEST_MAX_WORKERS: "1", VERMILLION_GIT_TEST_TIMEOUT_MS: "500", VERMILLION_GIT_TEST_MARKER: marker }
    })).rejects.toMatchObject({ code: 1 });
    const { pid, childPid, tempRoot } = JSON.parse(await readFile(marker, "utf8")) as { pid: number; childPid: number; tempRoot: string };
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(childPid, 0)).toThrow();
    await expect(stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
