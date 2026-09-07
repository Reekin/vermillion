import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { SessionIndexStore } from "./session-index.js";
import { WrapperChatTreeService } from "./wrapper-chat-tree.js";

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
  const reloaded = new SessionIndexStore({ baseDir });
  await reloaded.ready();
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
    fork: vi.fn()
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
