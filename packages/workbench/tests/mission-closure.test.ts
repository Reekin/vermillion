import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const dirs: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  await delay(100);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

// This fake verifies orchestration only; it does not validate a real steward's judgment.
const fakeRunner = () => {
  const sessions: Array<{ sessionId: string; metadata: Record<string, unknown>; messages: string[] }> = [];
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  const send = async (id: string, message: string) => { sessions.find((s) => s.sessionId === id)!.messages.push(message); };
  const runner: AgentRunner = {
    open: async (input) => {
      const sessionId = "fake-" + (sessions.length + 1);
      sessions.push({ sessionId, metadata: input.metadata, messages: [] });
      return { sessionId };
    },
    send,
    steer: async (id, message) => { await send(id, message); return {}; },
    interrupt: async () => {},
    resume: async (id) => sessions.some((s) => s.sessionId === id),
    lastReply: () => "Fake turn completed",
    turnMessages: () => [],
    registerTool: () => {},
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  return {
    runner, sessions,
    complete: (sessionId: string) => {
      for (const listener of listeners) listener({ sessionId, turnId: "fake-turn", finishReason: "completed" });
    },
    closures: () => sessions.flatMap((s) => s.messages.filter((m) => m.includes("任务收尾判断请求")).map((message) => ({ ...s, message })))
  };
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-closure-"));
  const globalDir = await mkdtemp(join(tmpdir(), "verm-closure-roles-"));
  dirs.push(root, globalDir);
  const roles = new RoleService({ globalDir, defaultsDir: new URL("../roles/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  await roles.ensureGlobal();
  const workspaces = createMemoryWorkspaceSource();
  const openService = () => {
    const service = new WorkbenchService({ workspaces, roles });
    cleanup.push(() => service.dispose());
    return service;
  };
  const service = openService();
  const { workspaceId } = await service.addWorkspace({ rootPath: root, label: "Closure" });
  await service.setScheduler(workspaceId, { enabled: false, maxWorkers: 1 });
  await service.writeDoc(workspaceId, ".vermillion/docs/spec.md", "# Closure\n");
  const mission = await service.createMission(workspaceId, { title: "Closure", summary: "Deliver the result" });
  const item = (missionId?: string) => service.createWorkItem(workspaceId, {
    missionId, title: "Implementation", objective: "Deliver", risk: "R1",
    scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "Result delivered" }]
  });
  const close = async (id: string) => {
    await service.startWorkItem(workspaceId, id, {});
    return service.submitWorkItem(workspaceId, id, {
      evidence: { summary: "Delivered", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
      review: [], verify: { items: [{ index: 0, pass: true, evidence: "Result delivered" }], verdict: "pass" }
    });
  };
  const processed = async () => {
    const now = new Date().toISOString();
    await service.putRun(workspaceId, {
      runId: "historical-steward", role: "steward", sessionId: "historical-session", missionId: mission.missionId,
      revision: mission.revisions[0]!.commit, status: "done", turns: 1, startedAt: now, endedAt: now
    });
  };
  const fake = fakeRunner();
  const start = async (current = service) => {
    await current.setScheduler(workspaceId, { enabled: true, maxWorkers: 1 });
    const orchestrator = new Orchestrator({ service: current, roles, runner: fake.runner });
    cleanup.push(() => orchestrator.dispose());
    orchestrator.start();
    return orchestrator;
  };
  return { service, workspaceId, mission, item, close, processed, start, openService, ...fake };
};

const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 10000, interval: 30 });

describe("Mission closure", { timeout: 30000 }, () => {
  it("guards done against own unfinished and related non-closed work, and persists partial result updates", async () => {
    const { service, workspaceId, mission, item, close, openService } = await setup();
    const other = await service.createMission(workspaceId, { title: "Other", summary: "" });
    const own = await item(mission.missionId);
    const related = await item(other.missionId);
    const standalone = await item();
    for (const id of [own.workItemId, standalone.workItemId, "missing"]) {
      await expect(service.setMissionResult(workspaceId, mission.missionId, { relatedWorkItemIds: [id] })).rejects.toThrow();
    }
    await service.setMissionResult(workspaceId, mission.missionId, { resultSummary: "Awaiting handoff", relatedWorkItemIds: [related.workItemId] });
    await service.setMissionResult(workspaceId, mission.missionId, { resultSummary: "Handoff registered" });
    await expect(service.setMissionStatus(workspaceId, mission.missionId, "done")).rejects.toThrow(/unfinished/);
    await service.cancelWorkItem(workspaceId, own.workItemId);
    await expect(service.setMissionStatus(workspaceId, mission.missionId, "done")).rejects.toThrow(/not closed/);
    await service.cancelWorkItem(workspaceId, related.workItemId);
    await expect(service.setMissionStatus(workspaceId, mission.missionId, "done")).rejects.toThrow(/not closed/);
    const replacement = await item(other.missionId);
    await close(replacement.workItemId);
    await service.setMissionResult(workspaceId, mission.missionId, { relatedWorkItemIds: [replacement.workItemId] });
    await service.setMissionStatus(workspaceId, mission.missionId, "done");
    service.dispose();
    expect((await openService().listMissions(workspaceId)).find((m) => m.missionId === mission.missionId)).toMatchObject({
      status: "done", resultSummary: "Handoff registered", relatedWorkItemIds: [replacement.workItemId]
    });
  });

  it("cancels all unfinished own work while preserving closed and other mission work", async () => {
    const { service, workspaceId, mission, item, close } = await setup();
    const queued = await item(mission.missionId);
    const running = await item(mission.missionId);
    await service.startWorkItem(workspaceId, running.workItemId, {});
    const parked = await item(mission.missionId);
    await service.startWorkItem(workspaceId, parked.workItemId, {});
    await service.createDecision(workspaceId, { workItemId: parked.workItemId, question: "Proceed?", context: "", options: [] });
    const closed = await item(mission.missionId);
    await close(closed.workItemId);
    const other = await service.createMission(workspaceId, { title: "Other", summary: "" });
    const related = await item(other.missionId);
    await service.setMissionResult(workspaceId, mission.missionId, { relatedWorkItemIds: [related.workItemId] });
    expect((await service.setMissionStatus(workspaceId, mission.missionId, "cancelled")).status).toBe("cancelled");
    for (const work of [queued, running, parked]) expect((await service.getWorkItem(workspaceId, work.workItemId)).status).toBe("cancelled");
    expect((await service.getWorkItem(workspaceId, closed.workItemId)).status).toBe("closed");
    expect((await service.getWorkItem(workspaceId, related.workItemId)).status).toBe("queued");
  });

  it.each(["done", "cancelled"] as const)("reopens a %s mission on a new revision", async (status) => {
    const { service, workspaceId, mission } = await setup();
    await service.setMissionStatus(workspaceId, mission.missionId, status);
    await service.writeDoc(workspaceId, ".vermillion/docs/spec.md", "# Closure\nAdditional delivery\n");
    const revised = await service.addMissionRevision(workspaceId, { missionId: mission.missionId, message: "Additional delivery" });
    expect(revised.status).toBe("active");
    expect(revised.revisions).toHaveLength(2);
    expect(revised.revisions[1]!.commit).not.toBe(mission.revisions[0]!.commit);
  });

  it("waits for the revision steward to finish, then requests judgment without completing the mission", async () => {
    const { service, workspaceId, mission, item, close, start, sessions, complete, closures } = await setup();
    const own = await item(mission.missionId);
    await close(own.workItemId);
    await start();
    await waitFor(() => expect(sessions[0]?.messages.length).toBe(1));
    expect(closures()).toHaveLength(0);
    complete(sessions[0]!.sessionId);
    await waitFor(() => expect(closures()).toHaveLength(1));
    expect(closures()[0]!.message).toContain(own.workItemId);
    expect(closures()[0]!.message).toContain("Delivered");
    expect((await service.listMissions(workspaceId))[0]!.status).toBe("active");
  });

  it("compensates all-cancelled history at startup and persists closure deduplication across restart", async () => {
    const { service, workspaceId, mission, item, processed, start, complete, closures, openService } = await setup();
    const own = await item(mission.missionId);
    await service.cancelWorkItem(workspaceId, own.workItemId);
    await processed();
    const first = await start();
    await waitFor(() => expect(closures()).toHaveLength(1));
    expect(closures()[0]!.message).toContain('"status":"cancelled"');
    complete(closures()[0]!.sessionId);
    await waitFor(async () => expect((await service.listRuns(workspaceId)).find((r) => r.closureKey)?.status).toBe("done"));
    const key = (await service.listRuns(workspaceId)).find((r) => r.closureKey)!.closureKey;
    first.dispose();
    service.dispose();
    const restarted = openService();
    expect((await restarted.listRuns(workspaceId)).find((r) => r.closureKey)?.closureKey).toBe(key);
    await start(restarted);
    await delay(250);
    expect(closures()).toHaveLength(1);
    expect((await restarted.listMissions(workspaceId))[0]!.status).toBe("active");
  });

  it("requests another judgment when a related work item changes status", async () => {
    const { service, workspaceId, mission, item, processed, start, complete, closures } = await setup();
    const own = await item(mission.missionId);
    await service.cancelWorkItem(workspaceId, own.workItemId);
    const other = await service.createMission(workspaceId, { title: "Handoff", summary: "" });
    const related = await item(other.missionId);
    await service.setMissionResult(workspaceId, mission.missionId, { resultSummary: "Handed off", relatedWorkItemIds: [related.workItemId] });
    await processed();
    await start();
    await waitFor(() => expect(closures().filter((c) => c.metadata.missionId === mission.missionId)).toHaveLength(1));
    const first = closures().find((c) => c.metadata.missionId === mission.missionId)!;
    expect(first.message).toContain(related.workItemId);
    expect(first.message).toContain("Handed off");
    // Hold this judgment turn open while the handoff completes; the next request must wait.
    await waitFor(async () => expect((await service.getWorkItem(workspaceId, related.workItemId)).status).toBe("running"));
    await service.submitWorkItem(workspaceId, related.workItemId, {
      evidence: { summary: "Handoff delivered", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
      review: [], verify: { items: [{ index: 0, pass: true, evidence: "Handoff delivered" }], verdict: "pass" }
    });
    expect(closures().filter((c) => c.metadata.missionId === mission.missionId)).toHaveLength(1);
    complete(first.sessionId);
    await waitFor(() => expect(closures().filter((c) => c.metadata.missionId === mission.missionId)).toHaveLength(2));
    expect(closures().filter((c) => c.metadata.missionId === mission.missionId)[1]!.message).toContain("Handoff delivered");
    expect((await service.listMissions(workspaceId)).find((m) => m.missionId === mission.missionId)!.status).toBe("active");

    // Removing and restoring a handoff revisits an old snapshot; only the latest request deduplicates.
    const second = closures().filter((c) => c.metadata.missionId === mission.missionId)[1]!;
    complete(second.sessionId);
    await waitFor(async () => expect((await service.listRuns(workspaceId)).find((r) => r.sessionId === second.sessionId)?.status).toBe("done"));
    await service.setMissionResult(workspaceId, mission.missionId, { relatedWorkItemIds: [] });
    await waitFor(() => expect(closures().filter((c) => c.metadata.missionId === mission.missionId)).toHaveLength(3));
    const third = closures().filter((c) => c.metadata.missionId === mission.missionId)[2]!;
    complete(third.sessionId);
    await waitFor(async () => expect((await service.listRuns(workspaceId)).find((r) => r.sessionId === third.sessionId)?.status).toBe("done"));
    await service.setMissionResult(workspaceId, mission.missionId, { relatedWorkItemIds: [related.workItemId] });
    await waitFor(() => expect(closures().filter((c) => c.metadata.missionId === mission.missionId)).toHaveLength(4));
    const fourth = closures().filter((c) => c.metadata.missionId === mission.missionId)[3]!;
    const runs = await service.listRuns(workspaceId);
    expect(runs.find((r) => r.sessionId === fourth.sessionId)!.closureKey).toBe(runs.find((r) => r.sessionId === second.sessionId)!.closureKey);
  });

  it("does not restart a failed closure for the same snapshot", async () => {
    const { service, workspaceId, mission, item, processed, start, closures } = await setup();
    await service.cancelWorkItem(workspaceId, (await item(mission.missionId)).workItemId);
    await processed();
    const orchestrator = await start();
    await waitFor(() => expect(closures()).toHaveLength(1));
    orchestrator.dispose();
    const run = (await service.listRuns(workspaceId)).find((entry) => entry.closureKey)!;
    await service.putRun(workspaceId, { ...run, status: "failed", endedAt: new Date().toISOString() });
    await start();
    await delay(250);
    expect(closures()).toHaveLength(1);
  });
});
