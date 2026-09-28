import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { SessionIndexStore } from "./session-index.js";
import { WrapperChatTreeService } from "./wrapper-chat-tree.js";
import { CodexSessionDiscoveryProvider } from "./engines/codex/session-discovery.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const setup = async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "tree-actions-"));
  dirs.push(baseDir);
  const index = new SessionIndexStore({ baseDir });
  const time = "2026-09-09T00:00:00Z";
  const ids = ["root", "branch", "descendant", "sibling"];
  const snapshot = parseDomainSnapshot({
    conversations: [{ conversationId: "conversation", workspaceId: "workspace", participantEngineIds: ["codex"], sessionIds: ids, createdAt: time, updatedAt: time }],
    sessions: ids.map((sessionId) => ({ sessionId, conversationId: "conversation", engineId: "codex", status: "idle", createdAt: time, updatedAt: time })),
    turns: ids.flatMap((sessionId) => [1, 2].map((n) => ({ turnId: `${sessionId}-${n}`, sessionId, status: "completed", startedAt: `2026-09-09T00:00:0${n}Z` })))
  });
  for (const session of snapshot.sessions) await index.upsertSession({ workspaceId: "workspace", session });
  for (const [parentSessionId, childSessionId, sourceTurnId] of [
    ["root", "branch", "root-1"], ["branch", "descendant", "branch-1"], ["root", "sibling", "root-1"]
  ]) await index.upsertRelation({ workspaceId: "workspace", parentSessionId: parentSessionId!, childSessionId: childSessionId!, relationType: "fork", sourceTurnId });
  const load = vi.fn(async (_id: string) => true);
  const fork = vi.fn(async () => "new-fork");
  const create = (store: SessionIndexStore) => new WrapperChatTreeService({ sessionIndexStore: store,
    reconciliation: { ensureSessionLoaded: load } as never,
    runtimeService: { getSnapshot: () => snapshot, getSession: (id: string) => snapshot.sessions.find((s) => s.sessionId === id),
      getRevision: () => "initial", getSessionHistoryRevision: () => "history", hasSessionWindow: () => false,
      subscribe: () => () => {}, notifyChatTreeChanged: vi.fn() } as never,
    capabilities: { forkSessionFromTurn: fork } as never });
  return { baseDir, index, fork, create };
};

const sendOperation = (operationId: string, nodeId: string) => ({ cancelRequested: false, operation: {
  operationId, sessionId: "root", nodeId, content: operationId, attachments: [], status: "creating"
} });

it("hides a node with all later nodes, keeping earlier history and siblings after reload", async () => {
  const { baseDir, index, create } = await setup();
  const tree = create(index);
  await tree.get("root");
  await tree.jump("root", "descendant-2");
  const operations = (tree as unknown as { operations: Map<string, unknown> }).operations;
  operations.set("hidden-op", sendOperation("hidden-op", "descendant-1"));
  operations.set("kept-op", sendOperation("kept-op", "root-1"));
  await expect(tree.hideNode("root", "root-1")).rejects.toThrow("root node");
  expect(await tree.hideNode("root", "branch-1")).toEqual({ hidden: true });
  // 只记录被隐藏的这一个节点，引擎会话保持未归档。
  expect(index.getEntry("branch")?.hiddenTurnIds).toEqual(["branch-1"]);
  expect(index.getEntry("descendant")?.hiddenTurnIds).toBeUndefined();
  expect(index.getEntry("branch")?.archivedAt).toBeUndefined();
  // 查看位置回到隐藏范围之前的 root-1，而不是父会话末端。
  expect(index.getTreeView("root")).toEqual({ sessionId: "root", nodeId: "root-1", followTip: false });
  expect((await tree.get("root")).visibleTurnIds).toEqual(["root-1"]);
  expect(tree.listOperations("root").map((operation) => operation.operationId)).toEqual(["kept-op"]);
  await expect(tree.jump("root", "branch-2")).rejects.toThrow("Unknown tree node");
  tree.dispose();
  const reloaded = new SessionIndexStore({ baseDir });
  await reloaded.ready();
  const cold = create(reloaded);
  try {
    const result = await cold.get("root");
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["root-1", "root-2", "sibling-1", "sibling-2"]);
    expect(result.windows).toBeUndefined();
    await expect(cold.getNodeSession("root", "branch-1")).rejects.toThrow("Unknown tree node");
    await cold.jump("root", "sibling-2");
    expect(await cold.prepareSend("root")).toEqual({ sessionId: "sibling" });
    expect(reloaded.listRelations()).toHaveLength(3);
  } finally { cold.dispose(); }
});

it("forks from the last visible node when a session's tail is hidden", async () => {
  const { index, create, fork } = await setup();
  const tree = create(index);
  try {
    await tree.get("root");
    await tree.selectSession("root");
    await tree.hideNode("root", "root-2");
    expect(index.getTreeView("root")).toEqual({ sessionId: "root", nodeId: "root-1", followTip: false });
    // 正文窗口不带被隐藏的轮次。
    const path = await tree.get("root", "path");
    expect(path.windows!.flatMap((window) => window.snapshot.turns).map((turn) => turn.turnId)).toEqual(["root-1"]);
    // 引擎里 root 仍以 root-2 结尾，从 root-1 继续提问必须 fork，隐藏的轮次不进入新分支上下文。
    expect(await tree.prepareSend("root")).toEqual({ sessionId: "new-fork" });
    expect(fork).toHaveBeenCalledExactlyOnceWith("root", "root-1");
  } finally { tree.dispose(); }
});

it("reads archived cold history without resuming the engine session", async () => {
  const thread = { id: "archived", cwd: "I:/isolated-history", status: { type: "notLoaded" },
    createdAt: 1, updatedAt: 2, source: "cli", turns: [{ id: "shared", status: "completed", items: [
      { type: "agentMessage", id: "answer", text: "Shared ancestor answer", phase: "final_answer" }
    ] }] };
  const readThread = vi.fn(async () => thread);
  const resumeThread = vi.fn(async () => { throw new Error("archived sessions cannot resume"); });
  const releaseHistoryRead = vi.fn();
  const provider = new CodexSessionDiscoveryProvider({ codexRuntimePort: {
    readThread, resumeThread, releaseHistoryRead, attachThreadToSession: vi.fn()
  } as never });
  const result = await provider.hydrateSession({ workspaceId: "workspace", sessionId: "archived", conversationId: "conversation",
    unreadState: "read", source: "registry",
    engineId: "codex", providerKind: "codex-thread", providerSessionId: "archived", archivedAt: "2026-09-09T00:00:00Z",
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z" });
  expect(result?.turns.map((turn) => turn.turnId)).toEqual(["shared"]);
  expect(result?.messageBlocks).toContainEqual(expect.objectContaining({ text: "Shared ancestor answer" }));
  expect(readThread).toHaveBeenCalledWith("archived", true, { signal: undefined });
  expect(resumeThread).not.toHaveBeenCalled();
  expect(releaseHistoryRead).not.toHaveBeenCalled();
});
