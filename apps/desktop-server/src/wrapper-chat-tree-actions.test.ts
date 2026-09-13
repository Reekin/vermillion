import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { SessionIndexStore } from "./session-index.js";
import { WrapperChatTreeService } from "./wrapper-chat-tree.js";
import { CodexSessionDiscoveryProvider } from "./session-discovery.js";

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
      getRevision: () => "initial", subscribe: () => () => {}, notifyChatTreeChanged: vi.fn() } as never, fork });
  return { baseDir, index, load, create };
};

it("archives an entire fork but retains its shared prefix, early descendants and siblings after reload", async () => {
  const { baseDir, index, create } = await setup();
  const tree = create(index);
  await tree.get("root");
  await tree.jump("root", "branch-2");
  const operations = (tree as unknown as { operations: Map<string, unknown> }).operations;
  operations.set("archive-op", { cancelRequested: false, operation: {
    operationId: "archive-op", sessionId: "root", targetSessionId: "branch",
    nodeId: "root-1", content: "archived branch", attachments: [], status: "sent"
  } });
  expect(tree.listOperations("root")).toHaveLength(1);
  expect(await tree.getNodeTarget("root", "branch-1")).toEqual({ sessionId: "branch", canArchive: false });
  expect(await tree.getNodeTarget("root", "root-2")).toEqual({ sessionId: "root", canArchive: false });
  const archive = vi.fn(async (id: string) => index.archiveSessions([id]));
  expect(await tree.archiveBranch("root", "branch-2", archive)).toEqual({ archived: true });
  expect(archive).toHaveBeenCalledExactlyOnceWith("branch");
  expect(tree.listOperations("root")).toEqual([]);
  tree.dispose();
  const reloaded = new SessionIndexStore({ baseDir });
  await reloaded.ready();
  const cold = create(reloaded);
  try {
    const result = await cold.get("root");
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["root-1", "root-2", "branch-1", "sibling-1", "sibling-2", "descendant-1", "descendant-2"]);
    expect(result.windows!.flatMap((window) => window.snapshot.turns).map((turn) => turn.turnId)).not.toContain("branch-2");
    expect(await cold.getNodeTarget("root", "branch-1")).toEqual({ sessionId: "branch", canArchive: false });
    await cold.jump("root", "branch-1");
    expect(await cold.get("root")).toMatchObject({ currentSessionId: "descendant", visibleTurnIds: ["root-1", "branch-1"] });
    await cold.jump("root", "descendant-2");
    expect(await cold.prepareSend("root")).toEqual({ sessionId: "descendant" });
    await cold.jump("root", "sibling-2");
    expect(await cold.prepareSend("root")).toEqual({ sessionId: "sibling" });
    expect(reloaded.listRelations()).toHaveLength(3);
  } finally { cold.dispose(); }
});

it("waits for unloaded tree members before deciding whether a node is terminal", async () => {
  const { index, create, load } = await setup();
  const tree = create(index);
  await tree.get("root");
  await index.upsertRelation({ workspaceId: "workspace", parentSessionId: "branch", childSessionId: "descendant", relationType: "fork", sourceTurnId: "branch-2" });
  // A fresh service must finish all member loads before resolving any action.
  tree.dispose();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  load.mockClear();
  load.mockImplementation(async (id) => { if (id === "descendant") await gate; return true; });
  const cold = create(index);
  try {
    const archive = vi.fn();
    const pending = expect(cold.archiveBranch("root", "branch-2", archive)).rejects.toThrow("Only a terminal fork");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("descendant", { force: false }));
    expect(archive).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(archive).not.toHaveBeenCalled();
  } finally { finish(); cold.dispose(); }
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
