import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerRuntimePort } from "../src/engines/codex/runtime-port.js";
import { createSessionRuntimeService } from "../src/prod-service.js";
import { SessionIndexStore } from "../src/session-index.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

afterEach(() => vi.restoreAllMocks());

it("loads a persisted fork tree cold without changing its conversation during history release", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "vermillion-cold-fork-"));
  const registry = new WorkspaceRegistryService({ baseDir });
  const workspace = await registry.registerWorkspace({ absolutePath: baseDir });
  const index = new SessionIndexStore({ baseDir });
  const timestamp = "2026-09-09T17:40:00.000Z";
  for (const sessionId of ["parent", "child"]) {
    await index.upsertSession({ workspaceId: workspace.workspaceId, source: "discovery",
      providerKind: "codex-thread", providerSessionId: sessionId,
      session: { sessionId, conversationId: "shared-conversation", engineId: "codex",
        createdAt: timestamp, updatedAt: timestamp } });
  }
  await index.upsertRelation({ workspaceId: workspace.workspaceId,
    parentSessionId: "parent", childSessionId: "child", relationType: "fork", sourceTurnId: "turn-parent" });
  vi.spyOn(CodexAppServerRuntimePort.prototype, "start").mockResolvedValue();
  const internals = CodexAppServerRuntimePort.prototype as unknown as {
    rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  const rpc = vi.spyOn(internals, "rpc").mockImplementation(async (method, params) => {
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method !== "thread/read" && method !== "thread/resume") throw new Error(method);
    const id = String(params.threadId);
    const ids = id === "parent" ? ["parent"] : ["parent", "child"];
    return { thread: { id, sessionId: id, forkedFromId: id === "child" ? "parent" : null,
      preview: id, ephemeral: false, modelProvider: "openai", createdAt: 1788975600, updatedAt: 1788975601,
      status: { type: method === "thread/read" ? "notLoaded" : "idle" }, path: null, cwd: baseDir,
      cliVersion: "test", source: "appServer", threadSource: "user", agentNickname: null,
      agentRole: null, gitInfo: null, name: id,
      turns: method === "thread/read" ? [] : ids.map((owner) => ({ id: "turn-" + owner,
        status: "completed", error: null, itemsView: "full", startedAt: null, completedAt: null, durationMs: null,
        items: [{ type: "agentMessage", id: "answer-" + owner, text: "Saved " + owner,
          phase: "final_answer", memoryCitation: null }] })) } };
  });
  const service = createSessionRuntimeService({ persistenceBaseDir: baseDir });
  try {
    await service.executeCommand({ commandId: "initialize", command: { type: "initialize" } });
    const tree = await service.getChatTree("child");
    expect(tree.treeId).toBe("parent");
    expect(service.getSnapshot().sessions.map(({ sessionId, conversationId }) => ({ sessionId, conversationId })))
      .toEqual(expect.arrayContaining(["parent", "child"].map((sessionId) => ({ sessionId, conversationId: "shared-conversation" }))));
    expect(service.getSnapshot().messageBlocks.map((block) => block.text)).toContain("Saved child");
    expect(rpc.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toHaveLength(2);
    expect(rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  } finally {
    await service.dispose();
    await rm(baseDir, { recursive: true, force: true });
  }
});
