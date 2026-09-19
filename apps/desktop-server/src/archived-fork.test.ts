import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { SessionIndexStore } from "./session-index.js";
import { WrapperChatTreeService } from "./wrapper-chat-tree.js";
import { SessionReconciliationService } from "./session-discovery.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("excludes archived forks from loading and projection while keeping live forks navigable", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "archived-fork-"));
  dirs.push(baseDir);
  const index = new SessionIndexStore({ baseDir });
  const time = "2026-09-07T00:00:00Z";
  const ids = ["root", "clarification", "branch"];
  const snapshot = parseDomainSnapshot({
    conversations: [{ conversationId: "conversation", workspaceId: "workspace",
      participantEngineIds: ["codex"], sessionIds: ids, createdAt: time, updatedAt: time }],
    sessions: ids.map((sessionId) => ({ sessionId, conversationId: "conversation",
      engineId: "codex", status: "idle", createdAt: time, updatedAt: time })),
    turns: ids.map((sessionId) => ({ turnId: `${sessionId}-turn`, sessionId,
      status: "completed", startedAt: time }))
  });
  for (const session of snapshot.sessions) await index.upsertSession({ workspaceId: "workspace", session });
  for (const childSessionId of ids.slice(1)) await index.upsertRelation({
    workspaceId: "workspace", parentSessionId: "root", childSessionId,
    relationType: "fork", sourceTurnId: "root-turn"
  });
  await index.setTreeView("root", { sessionId: "clarification", nodeId: "clarification-turn" });
  await index.archiveSession("clarification", time);
  // A late runtime snapshot was captured before archive and carries no archive field.
  await index.upsertSession({ workspaceId: "workspace", session: {
    ...snapshot.sessions[1]!, title: "Late completion", updatedAt: "2026-09-07T00:01:00Z"
  } });
  const reloaded = new SessionIndexStore({ baseDir });
  await reloaded.ready();
  expect(reloaded.getEntry("clarification")).toMatchObject({ archivedAt: time, title: "Late completion" });
  const load = vi.fn(async (id: string) => {
    if (id === "clarification") throw new Error("session is archived");
    return true;
  });
  const service = new WrapperChatTreeService({
    sessionIndexStore: reloaded,
    reconciliation: { ensureSessionLoaded: load } as never,
    runtimeService: {
      getSnapshot: () => snapshot,
      getSession: (id: string) => snapshot.sessions.find((session) => session.sessionId === id),
      getRevision: () => "initial", subscribe: () => () => {}
    } as never,
    capabilities: { forkSessionFromTurn: vi.fn() } as never
  });
  try {
    expect(reloaded.getTreeMembers("root")).toEqual(["root", "branch"]);
    const tree = await service.get("root");
    expect(load.mock.calls.map(([id]) => id)).toEqual(["root", "branch"]);
    expect(tree.memberSessionIds).toEqual(["root", "branch"]);
    expect(tree.nodes.map((node) => node.nodeId)).toEqual(["root-turn", "branch-turn"]);
    expect(tree.visibleTurnIds).toEqual(["root-turn"]);
    await service.jump("root", "branch-turn");
    expect((await service.get("root")).visibleTurnIds).toEqual(["root-turn", "branch-turn"]);
    await reloaded.archiveSession("branch", time);
    expect((await service.get("root")).visibleTurnIds).toEqual(["root-turn"]);
    expect(reloaded.listRelations()).toHaveLength(2);
  } finally {
    service.dispose();
  }
});

it("repairs a missing archive marker from the provider without breaking the first tree load", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "archived-fork-"));
  dirs.push(baseDir);
  const index = new SessionIndexStore({ baseDir });
  const time = "2026-09-07T00:00:00Z";
  const snapshot = parseDomainSnapshot({
    conversations: [{ conversationId: "conversation", workspaceId: "workspace", participantEngineIds: ["codex"],
      sessionIds: ["root"], createdAt: time, updatedAt: time }],
    sessions: [{ sessionId: "root", conversationId: "conversation", engineId: "codex", status: "idle", createdAt: time, updatedAt: time }],
    turns: [{ turnId: "root-turn", sessionId: "root", status: "completed", startedAt: time }]
  });
  await index.upsertSession({ workspaceId: "workspace", session: snapshot.sessions[0]! });
  await index.upsertSession({ workspaceId: "workspace", providerKind: "codex-thread", providerSessionId: "archived-provider",
    session: { ...snapshot.sessions[0]!, sessionId: "clarification" } });
  await index.upsertRelation({ workspaceId: "workspace", parentSessionId: "root", childSessionId: "clarification", relationType: "fork", sourceTurnId: "root-turn" });
  const runtimeService = {
    getSnapshot: () => snapshot, getSession: (id: string) => snapshot.sessions.find((s) => s.sessionId === id),
    listSessions: () => snapshot.sessions, getRevision: () => "initial", subscribe: () => () => {}
  } as never;
  const hydrate = vi.fn(async () => { throw new Error("session archived-provider is archived. Run `codex unarchive archived-provider` to unarchive it first."); });
  const reconciliation = new SessionReconciliationService({
    workspaceRegistry: {} as never, sessionIndexStore: index, runtimeService,
    providers: [{
      engineId: "codex",
      hydrateSession: hydrate,
      isSessionArchivedError: (entry: { providerSessionId?: string }, error: unknown) =>
        Boolean(entry.providerSessionId) && error instanceof Error &&
        error.message.includes("is archived.")
    } as never]
  });
  const service = new WrapperChatTreeService({ runtimeService, sessionIndexStore: index, reconciliation, capabilities: { forkSessionFromTurn: vi.fn() } as never });
  try {
    expect((await service.get("root")).memberSessionIds).toEqual(["root"]);
    expect(index.getEntry("clarification")?.archivedAt).toBeTruthy();
    const reloaded = new SessionIndexStore({ baseDir });
    await reloaded.ready();
    expect(reloaded.getTreeMembers("root")).toEqual(["root"]);
    await service.get("root");
    expect(hydrate).toHaveBeenCalledTimes(1);

    // Provider 对账只补当前成员的归档标记，不把仍活跃的 fork 后代迁移成归档。
    await index.upsertSession({ workspaceId: "workspace", providerKind: "codex-thread", providerSessionId: "descendant-provider",
      session: { ...snapshot.sessions[0]!, sessionId: "descendant" } });
    await index.upsertRelation({ workspaceId: "workspace", parentSessionId: "clarification", childSessionId: "descendant",
      relationType: "fork", sourceTurnId: "root-turn" });
    expect(await reconciliation.ensureSessionLoaded("clarification", { force: true })).toBe(false);
    expect(index.getEntry("descendant")?.archivedAt).toBeUndefined();

    await index.upsertSession({ workspaceId: "workspace", providerKind: "codex-thread", providerSessionId: "live-provider",
      session: { ...snapshot.sessions[0]!, sessionId: "live" } });
    await index.upsertRelation({ workspaceId: "workspace", parentSessionId: "root", childSessionId: "live", relationType: "fork", sourceTurnId: "root-turn" });
    hydrate.mockRejectedValueOnce(new Error("connection lost"));
    const cold = new WrapperChatTreeService({ runtimeService, sessionIndexStore: index, reconciliation, capabilities: { forkSessionFromTurn: vi.fn() } as never });
    try {
      await expect(cold.get("root")).rejects.toThrow("connection lost");
      expect(index.getEntry("live")?.archivedAt).toBeUndefined();
    } finally { cold.dispose(); }
  } finally { service.dispose(); }
});
