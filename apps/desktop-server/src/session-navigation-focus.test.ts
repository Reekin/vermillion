import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { SessionRuntimeService } from "./runtime-service.js";
import { SessionIndexStore } from "./session-index.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { SessionCatalogService } from "./session-catalog.js";
import { SessionShellService } from "./session-shell-service.js";
import { WrapperChatTreeService } from "./wrapper-chat-tree.js";
import { createWorkbenchRpcHandler } from "./session-rpc-handler.js";

it("explicit activation selects the requested member tip and emits a refresh, while ordinary activation retains the saved view", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "navigation-focus-"));
  const index = new SessionIndexStore({ baseDir });
  const registry = new WorkspaceRegistryService({ baseDir });
  const runtime = new SessionRuntimeService({ sessionIndexStore: index, workspaceRegistry: registry, engines: [{ engineId: "codex", displayName: "Codex", capabilities: [] }] });
  const tree = new WrapperChatTreeService({
    runtimeService: runtime, sessionIndexStore: index,
    reconciliation: { ensureSessionLoaded: async () => true } as never,
    capabilities: { forkSessionFromTurn: vi.fn() } as never
  });
  try {
    const workspace = await registry.registerWorkspace({ absolutePath: baseDir });
    const time = "2026-09-08T00:00:00.000Z";
    const ids = ["root", "branch", "empty"];
    const snapshot = parseDomainSnapshot({
      conversations: [{ conversationId: "conversation", workspaceId: workspace.workspaceId, participantEngineIds: ["codex"], sessionIds: ids, createdAt: time, updatedAt: time }],
      sessions: ids.map((sessionId) => ({ sessionId, conversationId: "conversation", engineId: "codex", status: "idle", createdAt: time, updatedAt: time })),
      turns: ["root", "branch"].map((sessionId) => ({ sessionId, turnId: `${sessionId}-turn`, status: "completed", startedAt: time }))
    });
    for (const session of snapshot.sessions) {
      runtime.hydrateDiscoveredSession({ workspaceId: workspace.workspaceId, conversation: snapshot.conversations[0]!, session, turns: snapshot.turns.filter((turn) => turn.sessionId === session.sessionId), messageBlocks: [], toolCalls: [], terminalStreams: [], sessionRelations: [] });
      await index.upsertSession({ workspaceId: workspace.workspaceId, session });
    }
    await index.upsertRelation({ workspaceId: workspace.workspaceId, parentSessionId: "root", childSessionId: "branch", relationType: "fork", sourceTurnId: "root-turn" });
    await index.setTreeView("root", { sessionId: "branch", nodeId: "branch-turn", followTip: false });
    const shell = new SessionShellService({ runtimeService: runtime, wrapperChatTree: tree, sessionCatalog: new SessionCatalogService({ runtimeService: runtime, workspaceRegistry: registry, sessionIndexStore: index }) });
    const rpc = createWorkbenchRpcHandler(shell);
    const events = vi.fn();
    runtime.subscribe(events, { eventTypes: ["conversationGraph.updated"] });
    await shell.activateSession("root");
    expect((await tree.get("root")).currentSessionId).toBe("branch");
    expect(events).not.toHaveBeenCalled();
    expect(await rpc.handleRequest({ id: "focus", method: "sessionBrowser.activate", params: { sessionId: "root", focusTree: true } })).toMatchObject({ ok: true });
    expect(await tree.get("root")).toMatchObject({ currentSessionId: "root", currentNodeId: "root-turn", visibleTurnIds: ["root-turn"] });
    expect(index.getTreeView("root")).toEqual({ sessionId: "root", nodeId: "root-turn", followTip: true });
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: "conversationGraph.updated", sessionId: "root", currentNodeId: "root-turn" }) }));
    await shell.activateSession("branch", { focusTree: true });
    expect(await tree.get("root")).toMatchObject({ currentSessionId: "branch", currentNodeId: "branch-turn", visibleTurnIds: ["root-turn", "branch-turn"] });
    await shell.activateSession("empty", { focusTree: true });
    expect(await tree.get("empty")).toMatchObject({ currentSessionId: "empty", currentNodeId: undefined, visibleTurnIds: [] });
    expect(index.getTreeView("empty")).toMatchObject({ sessionId: "empty", followTip: true });
    const reopened = new SessionIndexStore({ baseDir });
    await reopened.ready();
    expect(reopened.getTreeView("root")).toMatchObject({ sessionId: "branch", nodeId: "branch-turn", followTip: true });
  } finally {
    tree.dispose();
    await runtime.dispose();
    await rm(baseDir, { recursive: true, force: true });
  }
});
