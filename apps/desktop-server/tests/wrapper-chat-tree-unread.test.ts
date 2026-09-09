import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { SessionRuntimeService } from "../src/runtime-service.js";
import { SessionIndexStore } from "../src/session-index.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";
import { SessionCatalogService } from "../src/session-catalog.js";
import { SessionShellService } from "../src/session-shell-service.js";
import { WrapperChatTreeService } from "../src/wrapper-chat-tree.js";
import { createWorkbenchRpcHandler } from "../src/session-rpc-handler.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const baseDir = await mkdtemp(join(tmpdir(), "tree-unread-"));
  const index = new SessionIndexStore({ baseDir });
  const registry = new WorkspaceRegistryService({ baseDir });
  const runtime = new SessionRuntimeService({ sessionIndexStore: index, workspaceRegistry: registry,
    engines: [{ engineId: "codex", displayName: "Codex", capabilities: [] }] });
  const createTree = (store: SessionIndexStore) => new WrapperChatTreeService({
    runtimeService: runtime, sessionIndexStore: store,
    reconciliation: { ensureSessionLoaded: async () => true } as never,
    fork: async () => { throw new Error("Unexpected fork"); }
  });
  const tree = createTree(index);
  cleanups.push(async () => { tree.dispose(); await runtime.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  const workspace = await registry.registerWorkspace({ absolutePath: baseDir });
  const time = "2026-09-09T00:00:00.000Z";
  const snapshot = parseDomainSnapshot({
    conversations: [{ conversationId: "conversation", workspaceId: workspace.workspaceId,
      participantEngineIds: ["codex"], sessionIds: ["root", "branch"], createdAt: time, updatedAt: time }],
    sessions: ["root", "branch"].map((sessionId) => ({ sessionId, conversationId: "conversation",
      engineId: "codex", status: "idle", createdAt: time, updatedAt: time })),
    turns: [["a", "root"], ["b", "root"], ["c", "branch"]].map(([turnId, sessionId], i) => ({
      turnId, sessionId, status: "completed", startedAt: `2026-09-09T00:00:0${i}.000Z`
    }))
  });
  for (const session of snapshot.sessions) {
    runtime.hydrateDiscoveredSession({ workspaceId: workspace.workspaceId, conversation: snapshot.conversations[0]!,
      session, turns: snapshot.turns.filter((turn) => turn.sessionId === session.sessionId),
      messageBlocks: [], toolCalls: [], terminalStreams: [], sessionRelations: [] });
    await index.upsertSession({ workspaceId: workspace.workspaceId, session });
  }
  await index.upsertRelation({ workspaceId: workspace.workspaceId, parentSessionId: "root", childSessionId: "branch",
    relationType: "fork", sourceTurnId: "a" });
  const shell = new SessionShellService({ runtimeService: runtime, wrapperChatTree: tree,
    sessionCatalog: new SessionCatalogService({ runtimeService: runtime, workspaceRegistry: registry, sessionIndexStore: index }) });
  const rpc = createWorkbenchRpcHandler(shell);
  const unread = async () => (await tree.get("root")).nodes.filter((node) => node.unread).map((node) => node.nodeId);
  return { tree, runtime, index, baseDir, createTree, rpc, unread, workspace };
}

it("keeps completed nodes unread through viewing and session activation, and reads only the displayed ancestor path", async () => {
  const f = await fixture();
  expect(await f.unread()).toEqual(["a", "b", "c"]);
  await f.tree.jump("root", "a");
  await f.index.markSessionRead("root");
  expect(await f.unread()).toEqual(["a", "b", "c"]);
  expect(await f.tree.markRead("root", "a")).toEqual({ readNodeIds: ["a"] });
  expect(await f.unread()).toEqual(["b", "c"]);
  expect(await f.rpc.handleRequest({ id: "read", method: "chatTree.markRead",
    params: { sessionId: "root", nodeId: "c" } })).toMatchObject({ ok: true, result: { readNodeIds: ["a", "c"] } });
  expect(await f.unread()).toEqual(["b"]);
  const response = await f.rpc.handleRequest({ id: "get", method: "chatTree.get", params: { sessionId: "root" } });
  expect(response).toMatchObject({ ok: true, result: { chatTree: { nodes: [
    expect.objectContaining({ nodeId: "a", unread: false }),
    expect.objectContaining({ nodeId: "b", unread: true }),
    expect.objectContaining({ nodeId: "c", unread: false })
  ] } } });
});

it("does not premark a running turn before completion", async () => {
  const f = await fixture();
  await f.tree.get("root");
  f.runtime.applyRuntimeEvent({ type: "turn.started", sessionId: "branch", turnId: "d" });
  expect((await f.tree.get("root")).nodes.find((node) => node.nodeId === "d")).toMatchObject({ status: "pending", unread: false });
  expect(await f.tree.markRead("root", "d")).toEqual({ readNodeIds: ["a", "c"] });
  f.runtime.applyRuntimeEvent({ type: "turn.completed", sessionId: "branch", turnId: "d", finishReason: "completed" });
  expect(await f.unread()).toEqual(["b", "d"]);
  expect(await f.tree.markRead("branch", "d")).toEqual({ readNodeIds: ["a", "c", "d"] });
  expect(await f.unread()).toEqual(["b"]);
  const revision = f.runtime.getRevision();
  await f.tree.markRead("branch", "d");
  expect(f.runtime.getRevision()).toBe(revision);
});

it("persists per-turn reads across session updates and reopening the index", async () => {
  const f = await fixture();
  await f.tree.markRead("branch", "c");
  await f.index.upsertSession({ workspaceId: f.workspace.workspaceId, session: f.runtime.getSession("root")! });
  await f.index.markSessionUnreadCompleted("root");
  const reopened = new SessionIndexStore({ baseDir: f.baseDir });
  await reopened.ready();
  const tree = f.createTree(reopened);
  try {
    expect((await tree.get("root")).nodes.filter((node) => node.unread).map((node) => node.nodeId)).toEqual(["b"]);
    expect(reopened.getEntry("root")?.readTurnIds).toEqual(["a"]);
    expect(reopened.getEntry("branch")?.readTurnIds).toEqual(["c"]);
  } finally { tree.dispose(); }
});
