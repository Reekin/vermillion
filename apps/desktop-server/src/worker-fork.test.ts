import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";

it("forks through the completed turn then appends Worker developer instructions without compacting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vermillion-worker-fork-"));
  const requestLog = join(directory, "requests.jsonl");
  const port = createCodexAppServerRuntimePort({
    commandPath: process.execPath,
    commandArgs: [fileURLToPath(new URL("../tests/fixtures/fake-codex-app-server.mjs", import.meta.url))],
    resolveConversationIdBySessionId: () => "conversation"
  });
  try {
    await port.start({ env: { FAKE_CODEX_REQUEST_LOG: requestLog, FAKE_CODEX_DEVELOPER_INSTRUCTIONS: "GLOBAL_ROLE" } });
    const fork = await port.forkThread("source", "completed-turn", { cwd: directory, developerInstructions: "WORKER_ROLE" });
    await port.resumeThread(fork.id, directory, "WORKER_ROLE");
    const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const forkRequest = requests.find((request) => request.method === "thread/fork");
    expect(forkRequest.params).toMatchObject({ threadId: "source", lastTurnId: "completed-turn", cwd: directory,
      developerInstructions: "GLOBAL_ROLE\n\nWORKER_ROLE", deferGoalContinuation: true });
    const tail = requests.find((request) => request.method === "thread/inject_items");
    expect(tail.params).toMatchObject({ threadId: fork.id, items: [{ type: "message", role: "developer",
      content: [{ type: "input_text", text: expect.stringContaining("WORKER_ROLE") }] }] });
    expect(requests.indexOf(tail)).toBeGreaterThan(requests.indexOf(forkRequest));
    expect(requests.find((request) => request.method === "thread/resume").params)
      .toMatchObject({ cwd: directory, developerInstructions: "GLOBAL_ROLE\n\nWORKER_ROLE" });
    expect(requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(1);
    expect(requests.some((request) => request.method.includes("compact"))).toBe(false);
  } finally {
    await port.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
