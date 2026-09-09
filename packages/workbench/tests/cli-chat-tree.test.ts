import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { startLocalEndpoint } from "../src/local-endpoint.js";

describe("chat tree CLI operations", () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "verm-cli-chat-tree-"));
    vi.stubEnv("VERMILLION_PERSISTENCE_BASE_DIR", baseDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(baseDir, { recursive: true, force: true });
  });

  it.each(["chatTree.submit", "chatTree.retry", "chatTree.operations", "chatTree.markRead"])("requires a running desktop for %s", async (method) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli([method, "{}"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("需要运行 Vermillion 桌面应用"));
    expect(await readdir(baseDir)).toEqual([]);
  });

  it("forwards operation parameters and results through the desktop endpoint", async () => {
    const operation = { operationId: "op-1", status: "queued" };
    const calls = [
      { method: "chatTree.markRead", params: { sessionId: "s-1", nodeId: "n-1" }, result: { readNodeIds: ["n-1"] } },
      { method: "chatTree.submit", params: { sessionId: "s-1", nodeId: "n-1", content: "continue", attachments: [], execution: { engineId: "codex" } }, result: operation },
      { method: "chatTree.retry", params: { operationId: "op-1" }, result: operation },
      { method: "chatTree.operations", params: { sessionId: "s-1" }, result: { operations: [operation] } }
    ];
    const handler = vi.fn(async (request: { method: string; params: unknown }) => ({
      ok: true as const, result: calls.find((call) => call.method === request.method)?.result ?? []
    }));
    const endpoint = await startLocalEndpoint(baseDir, handler);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      for (const { method, params, result } of calls) {
        expect(await runCli([method, JSON.stringify(params)])).toBe(0);
        expect(handler).toHaveBeenCalledWith({ method, params });
        expect(stdout).toHaveBeenLastCalledWith(JSON.stringify(result, null, 2) + "\n");
      }
    } finally {
      await endpoint.close();
    }
  });

  it("prints desktop operation errors and rejects unrelated session methods", async () => {
    const endpoint = await startLocalEndpoint(baseDir, async () => ({ ok: false, error: "operation not found" }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await runCli(["chatTree.retry", '{"operationId":"missing"}'])).toBe(1);
      expect(stderr).toHaveBeenLastCalledWith("operation not found\n");
      expect(await runCli(["chatTree.prepareSend", "{}"])).toBe(1);
      expect(stderr).toHaveBeenLastCalledWith("unknown method: chatTree.prepareSend\n");
    } finally {
      await endpoint.close();
    }
  });

  it("lists the operation methods in help", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runCli(["--help"])).toBe(0);
    for (const method of ["chatTree.submit", "chatTree.retry", "chatTree.operations", "chatTree.markRead"]) {
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(method));
    }
    expect(await runCli(["chatTree.markRead", "--help"])).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("readNodeIds"));
  });
});
