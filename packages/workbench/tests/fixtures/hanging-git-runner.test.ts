import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { it } from "vitest";

it("stays active until the isolated runner terminates this process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await writeFile(process.env.VERMILLION_GIT_TEST_MARKER!, JSON.stringify({ pid: process.pid, childPid: child.pid, tempRoot: tmpdir() }), "utf8");
  await new Promise(() => {});
});
