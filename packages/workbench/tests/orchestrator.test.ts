import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const defaultsDir = new URL("../roles/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dirs: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 100)); // let the recursive fs watcher release its handle
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const tick = () => delay(30);
const until = async (check: () => Promise<boolean>) => {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await tick();
  }
  throw new Error("timeout");
};

const advanceBackoff = async (service: WorkbenchService, workspaceId: string, workItemId: string, minutes: number) => {
  const item = await service.getWorkItem(workspaceId, workItemId);
  expect(Date.parse(item.run.retryAt!) - Date.now()).toBe(minutes * 60_000);
  await tick(); // allow the persisted change event to arm the scheduler timer
  await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1);
  await tick();
  expect((await service.getWorkItem(workspaceId, workItemId)).status).toBe("queued");
  await vi.advanceTimersByTimeAsync(1);
  await until(async () => (await service.getWorkItem(workspaceId, workItemId)).status === "running");
};

/** Scripted runner: records opened sessions and messages; test completes turns by hand. */
const createFakeRunner = () => {
  const sessions: Array<{ sessionId: string; title: string; cwd: string; metadata: Record<string, unknown>; developerInstructions: string; messages: string[]; reply?: string; turnOpen?: boolean }> = [];
  const tools = new Map<string, { role: string; handle: (args: Record<string, unknown>, callerSessionId: string) => Promise<string> }>();
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  const runner: AgentRunner = {
    open: async (input) => {
      const sessionId = "s" + (sessions.length + 1);
      sessions.push({ sessionId, title: input.title, cwd: input.cwd, metadata: input.metadata, developerInstructions: input.developerInstructions, messages: [] });
      return { sessionId };
    },
    send: async (sessionId, content) => { const s = sessions.find((s) => s.sessionId === sessionId)!; s.messages.push(content); s.turnOpen = true; },
    steer: async (sessionId, content) => { const s = sessions.find((s) => s.sessionId === sessionId)!; s.messages.push("[steer] " + content); return { turnId: s.turnOpen ? "t-" + s.messages.length : undefined }; },
    interrupt: async () => {},
    resume: async (sessionId) => sessions.some((s) => s.sessionId === sessionId),
    lastReply: (sessionId) => sessions.find((s) => s.sessionId === sessionId)?.reply,
    turnMessages: (sessionId) => { const s = sessions.find((s) => s.sessionId === sessionId); return s?.reply ? [s.reply] : []; },
    registerTool: (tool) => { tools.set(tool.name, tool); },
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const complete = (sessionId: string, reply: string, finishReason: "completed" | "interrupted" | "failed" = "completed", failure?: string) => {
    const s = sessions.find((s) => s.sessionId === sessionId)!;
    s.reply = reply;
    s.turnOpen = false;
    for (const l of [...listeners]) l({ sessionId, turnId: "t", finishReason, failure });
  };
  return { runner, sessions, complete, tools };
};

const setup = async (maxWorkers = 1, patrolIntervalMs = 60_000) => {
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
  const orchestrator = new Orchestrator({ service, roles, runner: fake.runner, maxIdleTurns: 1, patrolIntervalMs });
  orchestrator.start();
  cleanup.push(() => orchestrator.dispose());
  return { service, ws, roles, orchestrator, ...fake };
};

describe("Orchestrator", { timeout: 60000 }, () => {
  it.each(["update", "cancel", "decision"])("holds contract problems for the steward and resumes the original worker after %s", async (action) => {
    const { service, ws, sessions, complete, orchestrator, roles, runner } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# contract\n");
    const mission = await service.createMission(ws.workspaceId, { title: "Contract", summary: "" });
    await until(async () => sessions.some((s) => s.metadata.role === "steward" && s.messages.length > 0));
    const steward = sessions.find((s) => s.metadata.role === "steward")!;
    const item = await service.createWorkItem(ws.workspaceId, {
      missionId: mission.missionId, title: "Worker", objective: "fix", risk: "R2",
      scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, acceptance: [{ text: "fixed" }]
    });
    await until(async () => sessions.some((s) => s.metadata.workItemId === item.workItemId && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.workItemId === item.workItemId)!;
    const before = await service.getWorkItem(ws.workspaceId, item.workItemId);
    await service.escalateWorkItem(ws.workspaceId, item.workItemId, "需要调整允许路径");
    await until(async () => steward.messages.some((m) => m.includes("需要调整允许路径")));
    expect(steward.messages.at(-1)).toContain(item.workItemId);
    complete(worker.sessionId, "已上报");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.workItemId === item.workItemId && r.status === "done"));
    const held = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(held.status).toBe("queued");
    expect(held.contractIssue).toMatchObject({ message: "需要调整允许路径", notifiedAt: expect.any(String) });
    expect(held.run).toMatchObject({ sessionId: worker.sessionId, worktreePath: before.run.worktreePath, branch: before.run.branch });
    expect(held.run.attempts).toBeUndefined();
    await access(before.run.worktreePath!);
    expect(await service.listDecisions(ws.workspaceId)).toHaveLength(0);

    // A restart reads the persisted hold and does not reassign the worker or redeliver the problem.
    orchestrator.dispose();
    const restarted = new Orchestrator({ service, roles, runner });
    cleanup.push(() => restarted.dispose());
    restarted.start();
    await until(async () => steward.messages.some((m) => m.includes("工作台重启过")));
    await tick();
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("queued");
    expect(steward.messages.filter((m) => m.includes("需要调整允许路径"))).toHaveLength(1);

    if (action === "cancel") {
      await service.cancelWorkItem(ws.workspaceId, item.workItemId);
      await tick();
      expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("cancelled");
      await expect(access(before.run.worktreePath!)).rejects.toThrow();
      expect(worker.messages).toHaveLength(1);
      return;
    }
    if (action === "update") {
      await service.updateWorkItem(ws.workspaceId, item.workItemId, { note: "允许修复保存代码", scope: { ...item.scope, allowedPaths: ["src/", "storage/"] } });
    } else {
      const card = await service.createDecision(ws.workspaceId, {
        workItemId: item.workItemId, missionId: mission.missionId, sessionId: steward.sessionId,
        question: "是否扩大修复范围？", context: "保存代码需要一同修复。", details: "保存入口：storage/save.ts",
        options: [{ key: "yes", label: "继续修复", detail: "一并修复保存代码" }]
      });
      expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("decision");
      const inbox = await service.listInbox();
      expect(inbox.some((i) => i.kind === "decision" && i.card.decisionId === card.decisionId)).toBe(true);
      await service.answerDecision(ws.workspaceId, card.decisionId, { note: "继续修复" });
    }
    await until(async () => worker.messages.length === 2);
    const resumed = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(resumed.status).toBe("running");
    expect(resumed.run.sessionId).toBe(worker.sessionId);
    expect(resumed.run.worktreePath).toBe(before.run.worktreePath);
    expect(sessions.filter((s) => s.metadata.workItemId === item.workItemId)).toHaveLength(1);
    expect(worker.messages[1]).toContain(action === "update" ? "工单已调整：允许修复保存代码" : "用户决策答复：");
  });

  it("delivers current-main rebase instructions even with a custom worker role", async () => {
    const { service, ws, sessions } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# base\n");
    await service.commitDocs(ws.workspaceId, { message: "base" });
    await service.writeRoleOverride(ws.workspaceId, "worker", "# Custom worker\nFollow the contract.");
    const item = await service.createWorkItem(ws.workspaceId, {
      title: "Rebase", objective: "do", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, acceptance: []
    });
    await until(async () => sessions.some((s) => s.metadata.workItemId === item.workItemId && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.workItemId === item.workItemId)!;
    expect(worker.developerInstructions).toContain("Follow the contract.");
    expect(worker.messages[0]).toContain("git -C " + JSON.stringify(await service.workspaceRoot(ws.workspaceId)) + " rev-parse HEAD");
    expect(worker.messages[0]).toContain("git rebase <该 SHA>");
    expect(worker.messages[0]).toContain("基于 rebase 后的结果做 review 和验收");
    expect(worker.messages[0]).toContain("workItem.submit 前再次读取主分支 HEAD");
    expect(worker.messages[0]).toContain("不要修改或合并主分支");
  });

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
    await service.submitWorkItem(ws.workspaceId, item.workItemId, { evidence: { summary: "ok", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [{ index: 0, pass: true, evidence: "seen" }], verdict: "pass" } });
    complete(worker.sessionId, "done");
    await until(async () => (await service.listRuns(ws.workspaceId)).every((r) => r.status === "done"));
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("review");
  });

  it("after a restart, resumes the interrupted worker session instead of re-queuing; requeues only when the session is gone", async () => {
    const { service, ws, roles, sessions, runner } = await setup();
    const a = await service.createWorkItem(ws.workspaceId, { title: "A", objective: "o", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => (await service.getWorkItem(ws.workspaceId, a.workItemId)).status === "running");
    const workerA = sessions.find((s) => s.metadata.role === "worker")!;
    // simulate a second item whose session no longer exists after the restart
    const b = await service.createWorkItem(ws.workspaceId, { title: "B", objective: "o", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await service.startWorkItem(ws.workspaceId, b.workItemId, { sessionId: "ghost" });
    await service.putRun(ws.workspaceId, { runId: "run-ghost", role: "worker", sessionId: "ghost", workItemId: b.workItemId, status: "running", turns: 0, startedAt: new Date().toISOString() });

    // "restart": a fresh orchestrator over the same files and the same (persistent) sessions
    const second = new Orchestrator({ service, roles, runner, maxIdleTurns: 1, patrolIntervalMs: 120 });
    second.start();
    cleanup.push(() => second.dispose());
    await until(async () => workerA.messages.some((m) => m.includes("会话已恢复")));
    expect((await service.getWorkItem(ws.workspaceId, a.workItemId)).status).toBe("running");
    expect((await service.getWorkItem(ws.workspaceId, a.workItemId)).run.sessionId).toBe(workerA.sessionId);
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.runId === "run-ghost" && r.status === "failed"));
    const bAfter = await service.getWorkItem(ws.workspaceId, b.workItemId);
    expect(bAfter.run.lastFailure).toContain("无法恢复");
    expect(sessions.filter((s) => s.metadata.role === "worker")).toHaveLength(1); // A was not re-dispatched
  });

  it("delivers two rejections as next messages in the same session and merges the accumulated work on approval", async () => {
    const { service, ws, sessions, complete } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# spec\n");
    await service.commitDocs(ws.workspaceId, { message: "seed" });
    await promisify(execFile)("git", ["config", "core.autocrlf", "false"], { cwd: ws.rootPath });
    const item = await service.createWorkItem(ws.workspaceId, {
      title: "Rework", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["result.txt"] }, acceptance: [{ text: "result" }]
    });
    await until(async () => sessions.some((s) => s.messages.length > 0));
    const worker = sessions[0]!;
    const original = (await service.getWorkItem(ws.workspaceId, item.workItemId)).run;
    const submit = (summary: string) => service.submitWorkItem(ws.workspaceId, item.workItemId, {
      evidence: { summary, commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
      review: [{ comment: summary, decision: "accepted", reason: "fixed" }],
      verify: { items: [{ index: 0, pass: true, evidence: summary }], verdict: "pass" }
    });
    await writeFile(join(worker.cwd, "result.txt"), "initial\n");
    await submit("initial");
    const rejected = await service.rejectWorkItem(ws.workspaceId, item.workItemId, "first correction");
    expect(rejected.run.resumeMessage).toBe("用户打回：first correction");
    await tick();
    expect(worker.messages).toHaveLength(1); // Inbox can reject before the submitting turn has finished.
    complete(worker.sessionId, "initial submitted");
    await until(async () => worker.messages.length === 2);
    expect(worker.messages[1]).toContain("用户打回：first correction");
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run).toMatchObject({ sessionId: original.sessionId, worktreePath: original.worktreePath, branch: original.branch });
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.resumeMessage).toBeUndefined();
    expect(await readFile(join(worker.cwd, "result.txt"), "utf8")).toBe("initial\n");
    await writeFile(join(worker.cwd, "result.txt"), "initial\nfirst correction\n");
    await submit("first corrected");
    complete(worker.sessionId, "first correction submitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).every((r) => r.status === "done"));
    await service.rejectWorkItem(ws.workspaceId, item.workItemId, "second correction");
    await until(async () => worker.messages.length === 3);
    expect(worker.messages[2]).toContain("用户打回：second correction");
    expect(worker.messages[2]).not.toContain("first correction");
    expect(sessions).toHaveLength(1);
    const second = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(second.run).toMatchObject({ sessionId: original.sessionId, worktreePath: original.worktreePath, branch: original.branch });
    expect(second.rejections.map((r) => r.reason)).toEqual(["first correction", "second correction"]);
    expect(await readFile(join(worker.cwd, "result.txt"), "utf8")).toBe("initial\nfirst correction\n");
    await writeFile(join(worker.cwd, "result.txt"), "initial\nfirst correction\nsecond correction\n");
    await submit("second corrected");
    complete(worker.sessionId, "second correction submitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).every((r) => r.status === "done"));
    const inbox = await service.listInbox();
    expect(inbox).toHaveLength(1);
    const submitted = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(submitted.evidence?.summary).toBe("second corrected");
    expect(submitted.review[0]?.comment).toBe("second corrected");
    expect(submitted.verify?.items[0]?.evidence).toBe("second corrected");
    expect((await service.listRuns(ws.workspaceId)).map((r) => r.sessionId)).toEqual([worker.sessionId, worker.sessionId, worker.sessionId]);
    const closed = await service.approveWorkItem(ws.workspaceId, item.workItemId);
    expect(closed.status).toBe("closed");
    expect(await readFile(join(ws.rootPath, "result.txt"), "utf8")).toBe("initial\nfirst correction\nsecond correction\n");
    await expect(access(worker.cwd)).rejects.toThrow();
    expect(await service.listInbox()).toEqual([]);
  });

  it("returns a merge conflict to the same worker session with the file list, then merges the rebased resubmission", async () => {
    const { service, ws, sessions, complete } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# spec\n");
    await service.commitDocs(ws.workspaceId, { message: "seed" });
    const gitRoot = (...args: string[]) => promisify(execFile)("git", args, { cwd: ws.rootPath });
    await gitRoot("config", "core.autocrlf", "false");
    await writeFile(join(ws.rootPath, "result.txt"), "base\n");
    await gitRoot("add", "-A");
    await gitRoot("-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "base");
    const item = await service.createWorkItem(ws.workspaceId, {
      title: "Conflict", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["result.txt"] }, acceptance: [{ text: "result" }]
    });
    await until(async () => sessions.some((s) => s.messages.length > 0));
    const worker = sessions[0]!;
    const original = (await service.getWorkItem(ws.workspaceId, item.workItemId)).run;
    const submit = (summary: string) => service.submitWorkItem(ws.workspaceId, item.workItemId, {
      evidence: { summary, commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
      review: [],
      verify: { items: [{ index: 0, pass: true, evidence: summary }], verdict: "pass" }
    });
    await writeFile(join(worker.cwd, "result.txt"), "worker\n");
    await submit("worker result");
    complete(worker.sessionId, "submitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).every((r) => r.status === "done"));

    // Main moves on the same file while the item waits for review; approving hits a real conflict.
    await writeFile(join(ws.rootPath, "result.txt"), "upstream\n");
    await gitRoot("add", "-A");
    await gitRoot("-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "upstream");
    const mainHead = (await gitRoot("rev-parse", "HEAD")).stdout.trim();
    const rejected = await service.approveWorkItem(ws.workspaceId, item.workItemId);
    expect(rejected.status).toBe("queued");
    expect(rejected.rejections[0]!.reason).toContain("- result.txt");
    expect(rejected.run).toMatchObject({ sessionId: original.sessionId, worktreePath: original.worktreePath, branch: original.branch });
    await until(async () => worker.messages.length === 2);
    expect(sessions).toHaveLength(1);
    expect(worker.messages[1]).toContain("合并冲突");
    expect(worker.messages[1]).toContain("- result.txt");
    expect(worker.messages[1]).toContain("rebase");
    expect((await gitRoot("status", "--porcelain")).stdout).toBe("");
    expect(await service.listInbox()).toEqual([]);

    // The worker resolves on its own branch and resubmits; the second approval merges and cleans up.
    const gitWork = (...args: string[]) => promisify(execFile)("git", args, { cwd: worker.cwd });
    await expect(gitWork("rebase", mainHead)).rejects.toThrow();
    await writeFile(join(worker.cwd, "result.txt"), "upstream\nworker resolved\n");
    await gitWork("add", "result.txt");
    await gitWork("-c", "core.editor=true", "rebase", "--continue");
    await submit("resolved");
    complete(worker.sessionId, "resubmitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).every((r) => r.status === "done"));
    expect((await service.listInbox()).map((e) => e.kind)).toEqual(["review"]);
    const closed = await service.approveWorkItem(ws.workspaceId, item.workItemId);
    expect(closed.status).toBe("closed");
    expect(closed.run.worktreePath).toBeUndefined();
    expect(await readFile(join(ws.rootPath, "result.txt"), "utf8")).toBe("upstream\nworker resolved\n");
    await expect(access(worker.cwd)).rejects.toThrow();
  });

  it.each(["available", "missing", "throws"])("recovers a queued rejection after restart when the session is %s", async (availability) => {
    const { service, ws, roles, sessions, runner, orchestrator } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Rework", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.messages.length > 0));
    const worker = sessions[0]!;
    await service.setScheduler(ws.workspaceId, { enabled: false, maxWorkers: 1 });
    for (const reason of ["first reason", "second reason"]) {
      await service.submitWorkItem(ws.workspaceId, item.workItemId, { evidence: { summary: "done", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [], verdict: "pass" } });
      await service.rejectWorkItem(ws.workspaceId, item.workItemId, reason);
    }
    orchestrator.dispose();
    const resumed: string[] = [];
    runner.resume = async (id) => { resumed.push(id); if (availability === "throws") throw new Error("unavailable"); return availability === "available"; };
    const second = new Orchestrator({ service, roles, runner });
    second.start();
    cleanup.push(() => second.dispose());
    await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
    await until(async () => sessions.reduce((count, s) => count + s.messages.length, 0) === 2);
    expect(resumed).toEqual([worker.sessionId]);
    expect((await service.listRuns(ws.workspaceId)).filter((r) => r.status === "running")).toHaveLength(1);
    if (availability === "available") {
      expect(sessions).toHaveLength(1);
      expect(worker.messages[1]).toContain("用户打回：second reason");
      expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.sessionId).toBe(worker.sessionId);
    } else {
      expect(sessions).toHaveLength(2);
      expect(sessions[1]!.messages[0]).toContain("用户打回：first reason");
      expect(sessions[1]!.messages[0]).toContain("用户打回：second reason");
      expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.sessionId).toBe(sessions[1]!.sessionId);
    }
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.attempts).toBeUndefined();
  });

  it("delivers decision answers after the issuing turn finishes and retains the session and worktree", async () => {
    const { service, ws, sessions, complete } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# spec\n");
    await service.commitDocs(ws.workspaceId, { message: "seed" });
    const item = await service.createWorkItem(ws.workspaceId, {
      title: "Decision", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["result.txt"] }, acceptance: [{ text: "result" }]
    });
    await until(async () => sessions.some((s) => s.messages.length > 0));
    const worker = sessions[0]!;
    const original = (await service.getWorkItem(ws.workspaceId, item.workItemId)).run;
    await writeFile(join(worker.cwd, "result.txt"), "before decision\n");
    for (const kind of ["worker", undefined] as const) {
      const card = await service.createDecision(ws.workspaceId, {
        kind, workItemId: item.workItemId, sessionId: worker.sessionId, question: "Choose a format?", context: "",
        options: [{ key: "plain", label: "Plain text", detail: "" }]
      });
      const messageCount = worker.messages.length;
      await service.answerDecision(ws.workspaceId, card.decisionId, { key: "plain", note: "keep previous lines" });
      await tick();
      expect(worker.messages).toHaveLength(messageCount);
      complete(worker.sessionId, "waiting for decision");
      await until(async () => worker.messages.length === messageCount + 1);
      expect(worker.messages.at(-1)).toContain("用户决策答复：Choose a format? -> Plain text (keep previous lines)");
      const continued = await service.getWorkItem(ws.workspaceId, item.workItemId);
      expect(continued.status).toBe("running");
      expect(continued.run).toMatchObject({ sessionId: original.sessionId, worktreePath: original.worktreePath, branch: original.branch });
      expect(continued.run.resumeMessage).toBeUndefined();
      expect(await readFile(join(worker.cwd, "result.txt"), "utf8")).toBe("before decision\n");
      expect(sessions).toHaveLength(1);
    }
    expect((await service.listRuns(ws.workspaceId)).map((r) => r.sessionId)).toEqual([worker.sessionId, worker.sessionId, worker.sessionId]);
  });

  it.each(["available", "missing", "throws"])("recovers an answered decision after restart when the session is %s", async (availability) => {
    const { service, ws, roles, sessions, runner, orchestrator } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Decision", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.messages.length > 0));
    const worker = sessions[0]!;
    await service.setScheduler(ws.workspaceId, { enabled: false, maxWorkers: 1 });
    const card = await service.createDecision(ws.workspaceId, {
      workItemId: item.workItemId, sessionId: worker.sessionId, question: "A or B?", context: "",
      options: [{ key: "a", label: "A", detail: "" }]
    });
    await service.answerDecision(ws.workspaceId, card.decisionId, { key: "a", note: "keep it simple" });
    orchestrator.dispose();
    const resumed: string[] = [];
    runner.resume = async (id) => { resumed.push(id); if (availability === "throws") throw new Error("unavailable"); return availability === "available"; };
    const second = new Orchestrator({ service, roles, runner });
    second.start();
    cleanup.push(() => second.dispose());
    await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
    await until(async () => sessions.reduce((count, s) => count + s.messages.length, 0) === 2);
    expect(resumed).toEqual([worker.sessionId]);
    expect((await service.listRuns(ws.workspaceId)).filter((r) => r.status === "running")).toHaveLength(1);
    const active = sessions.at(-1)!;
    expect(active.messages.at(-1)).toContain("A or B? -> A (keep it simple)");
    expect(sessions).toHaveLength(availability === "available" ? 1 : 2);
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.sessionId).toBe(active.sessionId);
  });

  it("backs off idle workers four times and resumes the fifth worker after the decision", async () => {
    const { service, ws, sessions, runner, complete } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# base\n");
    await service.commitDocs(ws.workspaceId, { message: "base" });
    const item = await service.createWorkItem(ws.workspaceId, { title: "Retry", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["progress.txt"] }, acceptance: [{ text: "t" }] });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    for (let attempt = 0; attempt < 5; attempt++) {
      await until(async () => sessions.length === attempt + 1 && sessions[attempt]!.messages.length > 0);
      const worker = sessions[attempt]!;
      if (attempt === 0) await writeFile(join(worker.cwd, "progress.txt"), "unfinished work");
      expect(worker.cwd).toBe(sessions[0]!.cwd);
      expect(await readFile(join(worker.cwd, "progress.txt"), "utf8")).toBe("unfinished work");
      complete(worker.sessionId, "unfinished");
      await until(async () => worker.messages.length === 2);
      complete(worker.sessionId, "still unfinished");
      await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.attempts === attempt + 1);
      if (attempt < 4) await advanceBackoff(service, ws.workspaceId, item.workItemId, [1, 5, 30, 300][attempt]!);
    }
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).status === "decision");
    const [card] = await service.listDecisions(ws.workspaceId);
    expect(card!.kind).toBe("attempts");
    const resumed: string[] = [];
    runner.resume = async (id) => { resumed.push(id); return true; };
    await service.answerDecision(ws.workspaceId, card!.decisionId, { key: "retry", note: "try once more" });
    await until(async () => sessions[4]!.messages.length === 3);
    expect(sessions).toHaveLength(5);
    expect(resumed).toEqual([sessions[4]!.sessionId]);
    expect(sessions[4]!.messages.at(-1)).toContain("再试一次 (try once more)");
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.attempts).toBe(0);
  });

  it("restores the persisted retry deadline after restart and respects the scheduler switch", async () => {
    const { service, ws, roles, runner, sessions, complete, orchestrator } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Restart backoff", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [] });
    await until(async () => sessions[0]?.messages.length === 1);
    const worker = sessions[0]!;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    complete(worker.sessionId, "", "failed", "network down");
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).status === "queued");
    await tick();
    const retryAt = (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.retryAt;
    orchestrator.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    const second = new Orchestrator({ service, roles, runner });
    second.start();
    cleanup.push(() => second.dispose());
    await tick();
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.retryAt).toBe(retryAt);
    await vi.advanceTimersByTimeAsync(29_999);
    await tick();
    expect(worker.messages).toHaveLength(1);
    await service.setScheduler(ws.workspaceId, { enabled: false, maxWorkers: 1 });
    await tick();
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(worker.messages).toHaveLength(1);
    await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
    await until(async () => worker.messages.length === 2);
    expect(sessions).toHaveLength(1);
    expect(worker.messages[1]).toContain("network down");
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.retryAt).toBeUndefined();
  });

  it.each(["failed", "interrupted"] as const)("backs off four times after %s, preserving conversation and worktree through manual retry", async (reason) => {
    const { service, ws, sessions, complete } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# base\n");
    await service.commitDocs(ws.workspaceId, { message: "base" });
    const item = await service.createWorkItem(ws.workspaceId, { title: "Failure", objective: "o", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, acceptance: [] });
    await until(async () => sessions.length === 1 && sessions[0]!.messages.length === 1);
    const worker = sessions[0]!;
    await writeFile(join(worker.cwd, "progress.txt"), "unfinished work");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    for (let attempt = 1; attempt <= 5; attempt++) {
      complete(worker.sessionId, "working", reason, "failure " + attempt);
      await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.attempts === attempt);
      const failed = await service.getWorkItem(ws.workspaceId, item.workItemId);
      expect(failed.run.sessionId).toBe(worker.sessionId);
      expect(failed.run.worktreePath).toBe(worker.cwd);
      if (attempt < 5) {
        expect(failed.status).toBe("queued");
        await advanceBackoff(service, ws.workspaceId, item.workItemId, [1, 5, 30, 300][attempt - 1]!);
        await until(async () => worker.messages.length === attempt + 1);
        expect(worker.messages.at(-1)).toContain("turn " + reason + ": failure " + attempt);
      }
    }
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).status === "decision");
    const [card] = await service.listDecisions(ws.workspaceId);
    expect(card!.sessionId).toBe(worker.sessionId);
    expect(card!.context).toContain("failure 5");
    await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
    await tick();
    expect(worker.messages).toHaveLength(5);
    await service.answerDecision(ws.workspaceId, card!.decisionId, { key: "retry", note: "quota restored" });
    await until(async () => worker.messages.length === 6);
    expect(worker.messages.at(-1)).toContain("再试一次 (quota restored)");
    expect(sessions).toHaveLength(1);
    expect(await readFile(join(worker.cwd, "progress.txt"), "utf8")).toBe("unfinished work");
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.attempts).toBe(0);
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
    await until(async () => sessions.filter((s) => s.metadata.role === "steward").length === stewardCount + 1 && sessions.filter((s) => s.metadata.role === "steward").at(-1)!.messages.length > 0);
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

  it("delivers a free decision answer and the adjustments made while parked to the resuming worker", async () => {
    const { service, ws, sessions, complete } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Op", objective: "v1", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.role === "worker")!;
    const card = await service.createDecision(ws.workspaceId, { question: "A or B?", context: "", options: [{ key: "a", label: "A" }], workItemId: item.workItemId, sessionId: worker.sessionId });
    complete(worker.sessionId, "asked");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "worker" && r.note === "等待决策"));
    // steward adjusts the parked item: nothing is steered, the card gets the note
    await service.updateWorkItem(ws.workspaceId, item.workItemId, { objective: "v2", note: "范围收窄到 A" });
    await tick();
    expect(worker.messages.some((m) => m.includes("工单已调整"))).toBe(false);
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("decision");
    // free answer: note only; the same worker session gets the note plus the adjustment as its next message
    const messageCount = worker.messages.length;
    await service.answerDecision(ws.workspaceId, card.decisionId, { note: "做 A，但别碰配置文件" });
    await until(async () => worker.messages.length === messageCount + 1);
    expect(worker.messages.at(-1)).toContain("用户决策答复：A or B? -> 备注：做 A，但别碰配置文件；挂起期间工单调整：范围收窄到 A");
    expect(sessions.filter((s) => s.metadata.role === "worker")).toHaveLength(1);
  });

  it("steers the running worker on a contract change and voids a submit from the turn the change landed in", async () => {
    const { service, ws, sessions, complete } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Op", objective: "v1", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.role === "worker")!;
    // update lands mid-turn (the worker's first turn is still open)
    await service.updateWorkItem(ws.workspaceId, item.workItemId, { objective: "v2", note: "范围收窄" });
    await until(async () => worker.messages.length === 2);
    expect(worker.messages[1]).toContain("[steer] 工单已调整：范围收窄");
    expect(worker.messages[1]).not.toContain("contractVersion");
    expect(sessions.some((s) => s.metadata.role === "supervisor")).toBe(false);
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.staleTurnId !== undefined);

    // that turn ends without a submit; the next turn starts on the new contract, so its submit is accepted
    complete(worker.sessionId, "re-reading");
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.staleTurnId === undefined);
    await until(async () => worker.messages.length === 3); // orchestrator's continue prompt opened a new turn
    const evidence = { summary: "done", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] };
    const accepted = await service.submitWorkItem(ws.workspaceId, item.workItemId, { evidence, review: [], verify: { items: [], verdict: "pass" } });
    expect(accepted.status).toBe("closed"); // R1 auto-closes
    complete(worker.sessionId, "submitted");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "worker" && r.status === "done"));

    // a second item: update lands mid-turn and the worker submits in that same turn -> void
    const item2 = await service.createWorkItem(ws.workspaceId, { title: "Op2", objective: "v1", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.filter((s) => s.metadata.role === "worker").length === 2 && sessions[sessions.length - 1]!.messages.length > 0);
    const worker2 = sessions[sessions.length - 1]!;
    await service.updateWorkItem(ws.workspaceId, item2.workItemId, { objective: "v3", note: "再改" });
    await until(async () => (await service.getWorkItem(ws.workspaceId, item2.workItemId)).run.staleTurnId !== undefined);
    const voided = await service.submitWorkItem(ws.workspaceId, item2.workItemId, { evidence, review: [], verify: { items: [], verdict: "pass" } });
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

  it("a worker deferring on another item goes back to the queue with its session kept, and resumes that session once the prerequisite closes", async () => {
    const { service, ws, sessions, complete, runner } = await setup(2);
    const base = { objective: "o", risk: "R2" as const, scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, acceptance: [{ text: "t" }] };
    // B lives in a mission (a different group than the standalone A); its docs commit also gives worktrees a HEAD
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/b.md", "# b\n");
    const mission = await service.createMission(ws.workspaceId, { title: "B", summary: "" });
    await until(async () => sessions.some((s) => s.metadata.role === "steward" && s.messages.length > 0));
    complete(sessions.find((s) => s.metadata.role === "steward")!.sessionId, "no-op");
    const a = await service.createWorkItem(ws.workspaceId, { ...base, title: "A" });
    await until(async () => sessions.some((s) => s.metadata.workItemId === a.workItemId && s.messages.length > 0));
    const workerA = sessions.find((s) => s.metadata.workItemId === a.workItemId)!;
    const before = await service.getWorkItem(ws.workspaceId, a.workItemId);
    expect(before.run.worktreePath).toContain("worktrees");
    const b = await service.createWorkItem(ws.workspaceId, { ...base, title: "B", missionId: mission.missionId, scope: { ...base.scope, allowedPaths: [] } });
    await until(async () => (await service.getWorkItem(ws.workspaceId, b.workItemId)).status === "running");

    // worker A (via CLI) defers on B, then its turn ends
    const deferred = await service.deferWorkItem(ws.workspaceId, a.workItemId, b.workItemId, "要用 B 的接口");
    expect(deferred.status).toBe("queued");
    expect(deferred.dependsOn).toEqual([b.workItemId]);
    expect(deferred.run).toMatchObject({ sessionId: workerA.sessionId, worktreePath: before.run.worktreePath, branch: before.run.branch });
    expect(deferred.run.attempts).toBeUndefined();
    await expect(service.deferWorkItem(ws.workspaceId, a.workItemId, b.workItemId, "again")).rejects.toThrow(/not running/);
    complete(workerA.sessionId, "已退回队列");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.workItemId === a.workItemId && r.status === "done" && r.note === "退回队列"));
    await tick();
    expect((await service.getWorkItem(ws.workspaceId, a.workItemId)).status).toBe("queued"); // still held by dependsOn
    expect((await service.listDecisions(ws.workspaceId))).toHaveLength(0);

    // B closes -> A is picked up again in the same session, with a resume message instead of a fresh briefing
    const workerB = sessions.find((s) => s.metadata.workItemId === b.workItemId)!;
    await service.submitWorkItem(ws.workspaceId, b.workItemId, { evidence: { summary: "ok", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [], verdict: "pass" } });
    await service.approveWorkItem(ws.workspaceId, b.workItemId);
    complete(workerB.sessionId, "done");
    await until(async () => (await service.getWorkItem(ws.workspaceId, a.workItemId)).status === "running");
    const resumed = await service.getWorkItem(ws.workspaceId, a.workItemId);
    expect(resumed.run.sessionId).toBe(workerA.sessionId);
    expect(resumed.run.worktreePath).toBe(before.run.worktreePath);
    expect(sessions.filter((s) => s.metadata.workItemId === a.workItemId)).toHaveLength(1);
    await until(async () => workerA.messages.length === 2);
    expect(workerA.messages[1]).toContain("对工单「B」（" + b.workItemId + "）的等待已结束。退回原因：要用 B 的接口");
    await access(before.run.worktreePath!);
    expect(workerA.messages[1]).toContain("rebase");
    expect(resumed.run.resumeMessage).toBeUndefined();
    expect((await service.listRuns(ws.workspaceId)).filter((r) => r.workItemId === a.workItemId).map((r) => r.status).sort()).toEqual(["done", "running"]);

    // when the kept session cannot be opened, a fresh worker takes over instead
    const c = await service.createWorkItem(ws.workspaceId, { ...base, title: "C" });
    await until(async () => (await service.getWorkItem(ws.workspaceId, c.workItemId)).status === "running");
    const d = await service.createWorkItem(ws.workspaceId, { ...base, title: "D" });
    await service.deferWorkItem(ws.workspaceId, c.workItemId, d.workItemId, "等 D");
    const gone = sessions.find((s) => s.metadata.workItemId === c.workItemId)!;
    complete(gone.sessionId, "退回");
    gone.sessionId = "vanished"; // runner.resume can no longer find it
    expect(await runner.resume((await service.getWorkItem(ws.workspaceId, c.workItemId)).run.sessionId!)).toBe(false);
    await until(async () => (await service.getWorkItem(ws.workspaceId, d.workItemId)).status === "running");
    await service.submitWorkItem(ws.workspaceId, d.workItemId, { evidence: { summary: "ok", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [], verdict: "pass" } });
    await service.approveWorkItem(ws.workspaceId, d.workItemId);
    complete(sessions.find((s) => s.metadata.workItemId === d.workItemId)!.sessionId, "done");
    await until(async () => sessions.filter((s) => s.metadata.workItemId === c.workItemId).length === 2);
    const fresh = sessions.filter((s) => s.metadata.workItemId === c.workItemId).at(-1)!;
    await until(async () => fresh.messages.length > 0);
    expect(fresh.messages[0]).toContain("你负责工单「C」");
    expect(fresh.messages[0]).toContain("已决策：等待工单 " + d.workItemId);

    // a mission item deferred on a standalone one: cancelling that prerequisite wakes the dependant's own steward
    for (const id of [a.workItemId, c.workItemId]) {
      await service.submitWorkItem(ws.workspaceId, id, { evidence: { summary: "ok", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [], verdict: "pass" } });
    }
    complete(workerA.sessionId, "done");
    complete(fresh.sessionId, "done");
    const e = await service.createWorkItem(ws.workspaceId, { ...base, title: "E", missionId: mission.missionId, scope: { ...base.scope, allowedPaths: [] } });
    const f = await service.createWorkItem(ws.workspaceId, { ...base, title: "F", scope: { ...base.scope, allowedPaths: [] } });
    await until(async () => (await service.getWorkItem(ws.workspaceId, e.workItemId)).status === "running");
    await service.deferWorkItem(ws.workspaceId, e.workItemId, f.workItemId, "等 F");
    complete(sessions.find((s) => s.metadata.workItemId === e.workItemId)!.sessionId, "退回");
    const stewardCount = sessions.filter((s) => s.metadata.role === "steward").length;
    await service.cancelWorkItem(ws.workspaceId, f.workItemId);
    await until(async () => sessions.filter((s) => s.metadata.role === "steward").length === stewardCount + 1 && sessions.filter((s) => s.metadata.role === "steward").at(-1)!.messages.length > 0);
    const steward = sessions.filter((s) => s.metadata.role === "steward").at(-1)!;
    expect(steward.metadata.missionId).toBe(mission.missionId);
    expect(steward.messages[0]).toContain("- " + e.workItemId + " E");
  });

  it("patrols running workers with a fresh supervisor session, relays remind into the worker's turn, and requeues after too many idle turns", async () => {
    const { service, ws, sessions, complete, tools } = await setup(1, 120);
    const item = await service.createWorkItem(ws.workspaceId, { title: "Package", objective: "pnpm package", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
    const worker = sessions.find((s) => s.metadata.role === "worker")!;
    expect(worker.cwd).not.toContain("worktrees");
    worker.reply = "我先把整个测试套件跑一遍";
    // the patrol timer opens a supervisor session while the worker's turn is still open
    await until(async () => sessions.some((s) => s.metadata.role === "supervisor" && s.messages.length > 0));
    const supervisor1 = sessions.find((s) => s.metadata.role === "supervisor")!;
    expect(supervisor1.messages[0]).toContain("workItemId: " + item.workItemId);
    expect(supervisor1.messages[0]).toContain("整个测试套件");
    // supervisor calls the remind tool -> steered into the worker mid-turn
    const remind = tools.get("remind")!;
    expect(remind.role).toBe("supervisor");
    await remind.handle({ workItemId: item.workItemId, message: "别跑全量测试，工单只要求打包" }, supervisor1.sessionId);
    expect(worker.messages[1]).toContain("[steer] Supervisor 提醒：别跑全量测试");
    complete(supervisor1.sessionId, "已提醒");
    await until(async () => (await service.listRuns(ws.workspaceId)).some((r) => r.role === "supervisor" && r.status === "done"));
    // next patrol is a new session, not the same one
    await until(async () => sessions.filter((s) => s.metadata.role === "supervisor").length >= 2);
    const supervisor2 = sessions.filter((s) => s.metadata.role === "supervisor").at(-1)!;
    expect(supervisor2.sessionId).not.toBe(supervisor1.sessionId);
    complete(supervisor2.sessionId, "无事");
    // worker's turn ends twice without submitting -> requeued
    complete(worker.sessionId, "still going");
    await until(async () => worker.messages.some((m) => m.includes("工单仍是进行中")));
    complete(worker.sessionId, "still going");
    await until(async () => (await service.getWorkItem(ws.workspaceId, item.workItemId)).run.lastFailure === "多轮未提交");
    // A fresh worker starts only after backoff.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((await service.getWorkItem(ws.workspaceId, item.workItemId)).run.retryAt!);
    await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
    await until(async () => sessions.filter((s) => s.metadata.role === "worker").length === 2 && sessions[sessions.length - 1]!.messages.length > 0);
    const retried = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(retried.status).toBe("running");
    expect(retried.run.attempts).toBe(1);
    expect(sessions[sessions.length - 1]!.messages[0]).toContain("上次运行失败：多轮未提交");
    expect((await service.listRuns(ws.workspaceId)).filter((r) => r.role === "worker").map((r) => r.status).sort()).toEqual(["failed", "running"]);
  });
});
