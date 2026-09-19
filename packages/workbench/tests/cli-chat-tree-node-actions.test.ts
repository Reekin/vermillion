import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { startLocalEndpoint } from "../src/local-endpoint.js";

it("exposes node identifiers and forwards each node action to the owning desktop", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "tree-node-cli-"));
  vi.stubEnv("VERMILLION_PERSISTENCE_BASE_DIR", baseDir);
  const handler = vi.fn(async (request: { method: string; params: unknown }) => ({ ok: true as const, result: request.params }));
  const endpoint = await startLocalEndpoint(baseDir, handler);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const params = { sessionId: "tree-root", nodeId: "other-branch-turn" };
    for (const action of ["copy_session_id", "copy_awb_session_id", "open_rollout", "hide_branch"]) {
      const input = { ...params, action };
      expect(await runCli(["chatTree.nodeAction", JSON.stringify(input)])).toBe(0);
      expect(handler).toHaveBeenLastCalledWith({ method: "chatTree.nodeAction", params: input });
      expect(stdout).toHaveBeenLastCalledWith(JSON.stringify(input, null, 2) + "\n");
    }
    expect(await runCli(["chatTree.get", JSON.stringify({ sessionId: params.sessionId })])).toBe(0);
    expect(handler).toHaveBeenLastCalledWith({ method: "chatTree.get", params: { sessionId: params.sessionId } });
    expect(await runCli(["chatTree.nodeAction", "--help"])).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("copy_awb_session_id"));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("open_rollout"));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("hide_branch"));
    const imageInput = { source: "file:///C:/images/example.png" };
    expect(await runCli(["clipboard.writeImage", JSON.stringify(imageInput)])).toBe(0);
    expect(handler).toHaveBeenLastCalledWith({ method: "clipboard.writeImage", params: imageInput });
    expect(await runCli(["clipboard.writeImage", "--help"])).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("系统剪贴板"));
  } finally {
    await endpoint.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(baseDir, { recursive: true, force: true });
  }
});
