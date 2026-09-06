import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const defaultsDir = new URL("../roles/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dirs: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn();
  await new Promise((r) => setTimeout(r, 100)); // let the recursive fs watcher release its handle
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const tick = () => new Promise((r) => setTimeout(r, 30));
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await tick();
  }
  throw new Error("timeout");
};

/** Scripted runner: records opened sessions and messages; test completes turns by hand. */
const createFakeRunner = () => {
  const sessions: Array<{ sessionId: string; title: string; cwd: string; metadata: Record<string, unknown>; developerInstructions: string; messages: string[]; reply?: string }> = [];
  const listeners = new Set<(e: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed" }) => void>();
  const runner: AgentRunner = {
    open: async (input) => {
      const sessionId = "s" + (sessions.length + 1);
      sessions.push({ sessionId, title: input.title, cwd: input.cwd, metadata: input.metadata, developerInstructions: input.developerInstructions, messages: [] });
      return { sessionId };
    },
    send: async (sessionId, content) => { sessions.find((s) => s.sessionId === sessionId)!.messages.push(content); },
    steer: async (sessionId, content) => { sessions.find((s) => s.sessionId === sessionId)!.messages.push("[steer] " + content); },
    interrupt: async () => {},
    lastReply: (sessionId) => sessions.find((s) => s.sessionId === sessionId)?.reply,
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const complete = (sessionId: string, reply: string) => {
    sessions.find((s) => s.sessionId === sessionId)!.reply = reply;
    for (const l of [...listeners]) l({ sessionId, turnId: "t", finishReason: "completed" });
  };
  return { runner, sessions, complete };
};

const setup = async (maxWorkers = 1) => {
  const root = await mkdtemp(join(tmpdir(), "verm-orch-"));
  const globalDir = await mkdtemp(join(tmpdir(), "verm-orch-roles-"));
  dirs.push(root, globalDir);
  const roles = new RoleService({ globalDir, defaultsDir });
  await roles.ensureGlobal();
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
  cleanup.push(() => service.dispose());
  const ws = await service.addWorkspace({ rootPath: root, label: "O" });
  await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers });
  const fake = createFakeRunner();
  const orchestrator = new Orchestrator({ service, roles, runner: fake.runner, maxIdleTurns: 1 });
  orchestrator.start();
  cleanup.push(() => orchestrator.dispose());
  return { service, ws, ...fake };
};

describe("Orchestrator", { timeout: 60000 }, () => {
  it("opens a steward per new revision and a worker per queued item, then closes the run on submit", async () => {
    const { service, ws, sessions, complete } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# spec\n- login\n");
    const mission = await service.createMission(ws.workspaceId, { title: "Login", summary: "" });
    await until(async () => sessions.some((s) => s.metadata.role === "steward" && s.messages.length > 0));
    const steward = sessions.find((s) => s.metadata.role === "steward")!;
    expect(steward.messages[0]).toContain("missionId: " + mission.missionId);
    expect(steward.messages[0]).toContain("spec.md |");
    expect(steward.messages[0]).toContain("git show --format= " + mission.revisions[0]!.commit);
    expect(steward.messages[0]).not.toContain("+- login");

    // steward creates a work item via the service (as the CLI would), then its turn ends
    const item = await service.createWorkItem(ws.workspaceId, {
      missionId: mission.missionId, title: "Impl login", objective: "do", risk: "R2",
      refs: [{ path: ".vermillion/docs/spec.md", commit: mission.revisions[0]!.commit }],
      scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, acceptance: [{ text: "t" }]
    });
    complete(steward.sessionId, "建了 1 个工单");
    await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.role === "worker")!;
    expect(worker.metadata.workItemId).toBe(item.workItemId);
    expect(worker.cwd).toContain("worktrees");
    expect(worker.developerInstructions).toContain("# Worker");
    expect(worker.developerInstructions).toContain("----- reviewer begin -----\n# Reviewer");
    expect(worker.developerInstructions).toContain("----- verifier begin -----\n# Verifier");
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).status === "running");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "steward" && r.status === "done"));
    const runs = await service.listRuns(ws.workspaceId);
    expect(runs.map((r) => r.role + ":" + r.status).sort()).toEqual(["steward:done", "worker:running"]);

    // worker submits, then its turn ends -> run done, nothing else scheduled
    await service.submitWorkItem(ws.workspaceId, item.workItemId, { contractVersion: 0, evidence: { summary: "ok", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [{ index: 0, pass: true, evidence: "seen" }], verdict: "pass" } });
    complete(worker.sessionId, "done");
    await until(async () => (await service.listRuns(ws.workspaceId)).every((r) => r.status === "done"));
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("review");
  });

  it("holds items until dependsOn are closed and needs slots are free", async () => {
    const { service, ws, sessions, complete } = await setup(3);
    const base = { objective: "o", risk: "R1" as const, scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] };
    await service.createWorkItem(ws.workspaceId, { ...base, title: "A", needs: ["browser"] });
    await service.createWorkItem(ws.workspaceId, { ...base, title: "B", needs: ["browser"] });
    await until(async () => sessions.filter((s) => s.metadata.role === "worker").length === 1);
    await tick();
    expect(sessions.filter((s) => s.metadata.role === "worker")).toHaveLength(1); // B waits for the browser slot
    await expect(service.createWorkItem(ws.workspaceId, { ...base, title: "X", dependsOn: ["nope"] })).rejects.toThrow(/dependsOn/);
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/d.md", "# d\n");
    const mission = await service.createMission(ws.workspaceId, { title: "D", summary: "" });
    await until(async () => sessions.some((s) => s.metadata.role === "steward" && s.messages.length > 0));
    complete(sessions.find((s) => s.metadata.role === "steward")!.sessionId, "no-op");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "steward" && r.status === "done"));
    const first = await service.createWorkItem(ws.workspaceId, { ...base, title: "first", missionId: mission.missionId });
    const second = await service.createWorkItem(ws.workspaceId, { ...base, title: "second", missionId: mission.missionId, dependsOn: [first.workItemId] });
    await until(async () => (await service.getWorkItem(ws.workspaceId, first.workItemId)).status === "running");
    await tick();
    expect((await service.getWorkItem(ws.workspaceId, second.workItemId)).status).toBe("queued");

    // cancelling the prerequisite does not release the dependant; the mission's steward is asked instead
    const stewardCount = sessions.filter((s) => s.metadata.role === "steward").length;
    await service.cancelWorkItem(ws.workspaceId, first.workItemId);
    await until(async () => sessions.filter((s) => s.metadata.role === "steward").length === stewardCount + 1);
    const steward = sessions.filter((s) => s.metadata.role === "steward").at(-1)!;
    expect(steward.messages[0]).toContain("已取消");
    expect(steward.messages[0]).toContain(second.workItemId);
    expect((await service.getWorkItem(ws.workspaceId, first.workItemId)).status).toBe("cancelled");
    expect((await service.getWorkItem(ws.workspaceId, second.workItemId)).status).toBe("queued");
    // a second revision arriving while that steward runs is steered into the same session, not a new one
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/d.md", "# d2\n");
    await service.addMissionRevision(ws.workspaceId, { missionId: mission.missionId, message: "more" });
    await until(async () => steward.messages.length === 2);
    expect(steward.messages[1]).toContain("（追加）");
    expect(sessions.filter((s) => s.metadata.role === "steward")).toHaveLength(stewardCount + 1);
    // steward drops the dependency; the dependant is scheduled
    await service.updateWorkItem(ws.workspaceId, second.workItemId, { dependsOn: [], note: "前置已取消，独立继续" });
    await until(async () => (await service.getWorkItem(ws.workspaceId, second.workItemId)).status === "running");
    complete(steward.sessionId, "done");
  });

  it("steers the running worker on a contract change and only voids submits made against an older version", async () => {
    const { service, ws, sessions, complete } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Op", objective: "v1", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.role === "worker")!;
    const v1 = await service.updateWorkItem(ws.workspaceId, item.workItemId, { objective: "v2", note: "范围收窄" });
    expect(v1.contractVersion).toBe(1);
    await until(async () => worker.messages.length === 2);
    expect(worker.messages[1]).toContain("[steer] 工单已调整：范围收窄"); // delivered mid-turn
    expect(worker.messages[1]).toContain("contractVersion");
    expect(sessions.some((s) => s.metadata.role === "supervisor")).toBe(false);

    // the worker re-read the contract (version 1) and submits against it: accepted even though a turn is still open
    const evidence = { summary: "done", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] };
    const accepted = await service.submitWorkItem(ws.workspaceId, item.workItemId, { contractVersion: 1, evidence, review: [], verify: { items: [], verdict: "pass" } });
    expect(accepted.status).toBe("closed"); // R1 auto-closes
    complete(worker.sessionId, "submitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "worker" && r.status === "done"));

    // a second item: a submit quoting a stale version is void
    const item2 = await service.createWorkItem(ws.workspaceId, { title: "Op2", objective: "v1", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.filter((s) => s.metadata.role === "worker").length === 2 && sessions[sessions.length - 1]!.messages.length > 0);
    const worker2 = sessions[sessions.length - 1]!;
    await service.updateWorkItem(ws.workspaceId, item2.workItemId, { objective: "v3", note: "再改" });
    const voided = await service.submitWorkItem(ws.workspaceId, item2.workItemId, { contractVersion: 0, evidence, review: [], verify: { items: [], verdict: "pass" } });
    expect(voided.status).toBe("queued");
    expect(voided.evidence).toBeUndefined();
    expect(voided.decisions.at(-1)).toContain("提交作废");
    complete(worker2.sessionId, "submitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "worker" && r.note === "提交作废：合同已变更"));
    // the item is queued again and picked up by a new worker
    await until(async () => sessions.filter((s) => s.metadata.role === "worker").length === 3);

    // cancelling the item interrupts its worker and closes the run as failed
    await until(async () => (await service.getWorkItem(ws.workspaceId, item2.workItemId)).status === "running");
    await service.cancelWorkItem(ws.workspaceId, item2.workItemId);
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "worker" && r.status === "failed" && r.note === "工单已取消"));
  });

  it("runs the supervisor after an unfinished worker turn and requeues after too many idle turns", async () => {
    const { service, ws, sessions, complete } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Package", objective: "pnpm package", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.role === "worker")!;
    expect(worker.cwd).not.toContain("worktrees");
    complete(worker.sessionId, "still going");
    await until(async () => sessions.some((s) => s.metadata.role === "supervisor" && s.messages.length > 0));
    const supervisor = sessions.find((s) => s.metadata.role === "supervisor")!;
    expect(supervisor.messages[0]).toContain("Worker turn #1");
    complete(supervisor.sessionId, "remind: 别跑题");
    await until(async () => worker.messages.length === 2);
    expect(worker.messages[1]).toContain("Supervisor 提醒：别跑题");
    complete(worker.sessionId, "still going");
    await until(async () => sessions.filter((s) => s.metadata.role === "supervisor").length === 1 && supervisor.messages.length === 2);
    complete(supervisor.sessionId, "none");
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.lastFailure === "多轮未提交");
    // requeued and immediately picked up again by a fresh worker session
    await until(async () => sessions.filter((s) => s.metadata.role === "worker").length === 2 && sessions[sessions.length - 1]!.messages.length > 0);
    const retried = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(retried.status).toBe("running");
    expect(retried.run.attempts).toBe(1);
    expect(sessions[sessions.length - 1]!.messages[0]).toContain("上次运行失败：多轮未提交");
    expect((await service.listRuns(ws.workspaceId)).filter((r) => r.role === "worker").map((r) => r.status).sort()).toEqual(["failed", "running"]);
  });
});
