import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot, type EventEnvelope } from "@vermillion/shared";
import { SessionIndexStore } from "../src/session-index.js";
import { WrapperChatTreeService } from "../src/wrapper-chat-tree.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const fixture = async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "wrapper-tree-"));
  dirs.push(baseDir);
  const index = new SessionIndexStore({ baseDir });
  await index.ready();
  const time = "2026-09-07T00:00:00Z";
  const sessions = ["root", "branch", "other"].map((sessionId) => ({
    sessionId, conversationId: "conversation", engineId: "codex", status: "idle",
    createdAt: time, updatedAt: time
  }));
  const snapshot = parseDomainSnapshot({
    conversations: [{ conversationId: "conversation", workspaceId: "workspace", participantEngineIds: ["codex"],
      sessionIds: sessions.map((s) => s.sessionId), createdAt: time, updatedAt: time }],
    sessions,
    turns: [["a", "root"], ["b", "root"], ["c", "branch"], ["x", "other"]].map(([turnId, sessionId], i) => ({
      turnId, sessionId, status: "completed", startedAt: `2026-09-07T00:00:0${i}Z`
    }))
  });
  for (const session of snapshot.sessions) await index.upsertSession({ workspaceId: "workspace", session });
  await index.upsertRelation({ workspaceId: "workspace", parentSessionId: "root", childSessionId: "branch",
    relationType: "fork", sourceTurnId: "a" });
  let listener: (event: EventEnvelope) => void = () => {};
  const load = vi.fn().mockResolvedValue(true);
  const changed = vi.fn();
  const fork = vi.fn(async (_sessionId: string, _turnId: string) => "branch");
  const service = new WrapperChatTreeService({
    sessionIndexStore: index,
    reconciliation: { ensureSessionLoaded: load } as never,
    runtimeService: {
      getSnapshot: () => snapshot,
      getSession: (id: string) => snapshot.sessions.find((s) => s.sessionId === id),
      getRevision: () => "initial",
      notifyChatTreeChanged: changed,
      subscribe: (next: typeof listener) => { listener = next; return () => {}; }
    } as never,
    fork
  });
  return { service, index, snapshot, load, fork, baseDir, changed,
    completed: (sessionId: string, turnId: string) => listener({ event: { type: "turn.completed", sessionId, turnId, finishReason: "completed" } } as EventEnvelope),
    started: (sessionId: string, turnId: string) => listener({ event: { type: "turn.started", sessionId, turnId } } as EventEnvelope) };
};

describe("wrapper session trees", () => {
  it("opens the requested discussion branch even when preparation is newer", async () => {
    const f = await fixture();
    const preparation = f.snapshot.sessions.find((session) => session.sessionId === "branch")!;
    preparation.metadata = { role: "work-preparation", requestId: "request" };
    preparation.updatedAt = "2026-09-08T00:00:00Z";
    expect(await f.service.get("root")).toMatchObject({ currentSessionId: "root", currentNodeId: "b" });
    await f.service.jump("root", "a");
    expect(f.index.getTreeView("root")).toEqual({ sessionId: "root", nodeId: "a", followTip: false });
    await f.service.prepareSend("root");
    expect(f.fork).toHaveBeenCalledWith("root", "a");
    f.service.dispose();
  });

  it("retains the viewed branch for shared ancestors and selects the owner on a cross-branch jump", async () => {
    const f = await fixture();
    expect(await f.service.get("branch")).toMatchObject({ currentSessionId: "branch", currentNodeId: "c" });
    await f.service.jump("root", "a");
    expect(f.index.getTreeView("root")?.sessionId).toBe("branch");
    await f.service.jump("root", "b");
    expect(f.index.getTreeView("root")?.sessionId).toBe("root");
    await f.service.jump("root", "c");
    expect(await f.service.prepareSend("branch", "c")).toEqual({ sessionId: "branch" });
    expect(f.fork).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it("invalidates the existing graph subscription when any branch completes", async () => {
    const f = await fixture();
    await f.service.get("root");
    f.completed("branch", "c");
    expect(f.changed).toHaveBeenCalledWith("branch", ["b"]);
    f.service.dispose();
  });
  it("follows multiple automatic turns on the viewed branch without prepareSend", async () => {
    const f = await fixture();
    expect((await f.service.get("root")).currentNodeId).toBe("b");
    for (const [i, turnId] of ["d", "e"].entries()) {
      f.snapshot.turns.push({ turnId, sessionId: "root", status: "streaming", startedAt: `2026-09-07T00:01:0${i}Z` });
      f.started("root", turnId);
      const tree = await f.service.get("root");
      expect(tree.currentNodeId).toBe(turnId);
      expect(tree.visibleTurnIds).toEqual(["a", "b", ...["d", "e"].slice(0, i + 1)]);
      f.snapshot.turns.at(-1)!.status = "completed";
    }
    f.snapshot.turns.push({ turnId: "f", sessionId: "branch", status: "streaming", startedAt: "2026-09-07T00:02:00Z" });
    f.started("branch", "f");
    expect((await f.service.get("root")).currentNodeId).toBe("e");
    expect(f.fork).not.toHaveBeenCalled();
    await f.index.setTreeView("root", f.index.getTreeView("root")!);
    f.service.dispose();
  });

  it("recovers legacy automatic cursors and catches up with turns loaded without a live event", async () => {
    const f = await fixture();
    await f.index.setTreeView("root", { sessionId: "root", nodeId: "a" });
    expect((await f.service.get("root")).currentNodeId).toBe("b");
    f.snapshot.turns.push({ turnId: "d", sessionId: "root", status: "completed", startedAt: "2026-09-07T00:01:00Z" });
    expect((await f.service.get("root")).visibleTurnIds).toEqual(["a", "b", "d"]);
    f.service.dispose();
  });

  it("keeps explicit jumps pinned through automatic turns, including a jump after prepareSend", async () => {
    const f = await fixture();
    await f.service.get("root");
    await f.service.prepareSend("root");
    await f.service.jump("root", "a");
    for (const [i, sessionId] of ["root", "branch"].entries()) {
      const turnId = `auto-${i}`;
      f.snapshot.turns.push({ turnId, sessionId, status: "streaming", startedAt: `2026-09-07T00:01:0${i}Z` });
      f.started(sessionId, turnId);
      const tree = await f.service.get("root");
      expect(tree.currentNodeId).toBe("a");
      expect(tree.visibleTurnIds).toEqual(["a"]);
      expect(tree.nodes.find((node) => node.nodeId === turnId)?.status).toBe("pending");
    }
    const reloaded = new SessionIndexStore({ baseDir: f.baseDir });
    await reloaded.ready();
    expect(reloaded.getTreeView("root")).toEqual({ sessionId: "root", nodeId: "a", followTip: false });
    expect(f.fork).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it("projects shared-prefix branches once and jumps entirely within the loaded wrapper", async () => {
    const f = await fixture();
    const tree = await f.service.get("branch");
    expect(tree.treeId).toBe("root");
    expect(tree.nodes.map((n) => [n.nodeId, n.parentNodeId])).toEqual([["a", undefined], ["b", "a"], ["c", "a"]]);
    expect(f.load).toHaveBeenCalledTimes(2);
    await f.service.jump("root", "a");
    expect((await f.service.get("root")).visibleTurnIds).toEqual(["a"]);
    await f.service.jump("root", "c");
    expect((await f.service.get("branch")).visibleTurnIds).toEqual(["a", "c"]);
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.fork).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it("persists a separate viewing position per tree", async () => {
    const f = await fixture();
    await f.service.get("root");
    await f.service.jump("root", "a");
    await f.service.get("other");
    const reloaded = new SessionIndexStore({ baseDir: f.baseDir });
    await reloaded.ready();
    expect(reloaded.getTreeView("branch")?.nodeId).toBe("a");
    expect(reloaded.getTreeView("other")?.nodeId).toBe("x");
    expect((await f.service.get("root")).currentNodeId).toBe("a");
    f.service.dispose();
  });

  it("continues at a completed tip and forks from a historical turn without stopping other tips", async () => {
    const f = await fixture();
    await f.service.get("root");
    await f.service.jump("root", "b");
    expect(await f.service.prepareSend("root")).toEqual({ sessionId: "root" });
    expect(f.fork).not.toHaveBeenCalled();
    f.snapshot.turns.find((t) => t.turnId === "b")!.status = "streaming";
    await f.service.jump("root", "a");
    expect(await f.service.prepareSend("root")).toEqual({ sessionId: "branch" });
    expect(f.fork).toHaveBeenCalledWith("root", "a");
    f.snapshot.turns.find((t) => t.turnId === "c")!.status = "streaming";
    f.started("branch", "c");
    expect((await f.service.get("root")).currentNodeId).toBe("c");
    await f.service.jump("root", "a");
    const tree = await f.service.get("root");
    expect(tree.nodes.filter((n) => n.status === "pending").map((n) => n.nodeId)).toEqual(["b", "c"]);
    expect(tree.visibleTurnIds).toEqual(["a"]);
    await expect(f.service.prepareSend("root", "b")).rejects.toThrow("finish");
    f.service.dispose();
  });
});
