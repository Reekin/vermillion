import { afterEach, expect, it, vi } from "vitest";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { DocsService } from "../src/docs.js";
import { contract, git, setup, submission } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const orchestrators: Orchestrator[] = [];
afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.dispose();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

it("schedules workers without waiting for patrol scans and does not rescan for work events", async () => {
  const f = await fixture();
  let finishScan!: () => void;
  const domainRead = vi.spyOn(f.service, "listDomains").mockImplementationOnce(() => new Promise((resolve) => {
    finishScan = () => resolve([]);
  })).mockResolvedValue([]);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker-a" });
  f.orchestrator.start();

  await vi.waitFor(() => expect(domainRead).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker-b" });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(domainRead).toHaveBeenCalledOnce();
  finishScan();
});

it("keeps the worker session at workspace root while directing tools to its worktree", async () => {
  const f = await fixture();
  const worktreePath = f.root + "/worker-tree";
  await git(f.root, "worktree", "add", "-b", "worker-test", worktreePath);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original", worktreePath, branch: "worker-test" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  expect(f.runner.resume).toHaveBeenCalledWith("original", expect.objectContaining({ cwd: f.root }));
  const message = vi.mocked(f.runner.send).mock.calls[0]![1];
  expect(message).toContain("工作目录: " + worktreePath);
  expect(message).toContain("显式指定工具 workdir、git -C 或 worktree 内的绝对路径");
});

it("passes resolved reviewer and verifier model configuration separately from their prompts", async () => {
  const f = await fixture();
  await f.roles.writeOverride(f.root, "reviewer", [
    "---", "mode: override", "model: reviewer-model", "reasoningOptionId: high", "---", "# 审阅者", "中文交接：查看候选成果。"
  ].join("\n"));
  await f.roles.writeOverride(f.root, "verifier", [
    "---", "mode: override", "model: verifier-model", "reasoningOptionId: max", "serviceTierId: priority", "---", "# Verifier override"
  ].join("\n"));
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());

  const content = (await f.service.resolveWorkerRole(f.workspaceId)).content;
  expect(content).toContain("# 审阅者");
  expect(content).toContain("中文交接：查看候选成果。");
  expect(content).not.toContain("mode: override");
  expect(content).toContain("## reviewer subagent model configuration（JSON；仅用于核对）");
  expect(content).toContain(JSON.stringify({ modelId: "reviewer-model", reasoningOptionId: "high" }));
  expect(content).toContain("## reviewer spawn_agent top-level parameters（JSON；复制到工具参数，不放入 message）");
  expect(content).toContain(JSON.stringify({ fork_context: false, model: "reviewer-model", reasoning_effort: "high" }));
  expect(content).toContain("# Verifier override");
  expect(content).not.toContain("serviceTierId: priority");
  expect(content).toContain("## verifier subagent model configuration（JSON；仅用于核对）");
  expect(content).toContain(JSON.stringify({ modelId: "verifier-model", reasoningOptionId: "max", serviceTierId: "priority" }));
  expect(content).toContain("## verifier spawn_agent top-level parameters（JSON；复制到工具参数，不放入 message）");
  expect(content).toContain(JSON.stringify({ fork_context: false, model: "verifier-model", reasoning_effort: "max" }));
});

it("detaches a completed worker after its turn ends without waiting for release ACK", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  let ack!: () => void;
  vi.mocked(f.runner.release).mockImplementation(() => new Promise<void>((resolve) => { ack = resolve; }));
  try {
    expect((await f.service.submitWorkItem(f.workspaceId, item.workItemId, { ...submission, sessionId: "original" })).status).toBe("closed");
    expect(f.runner.release).not.toHaveBeenCalled();
    f.complete("original");
    await vi.waitFor(() => expect(f.runner.release).toHaveBeenCalledExactlyOnceWith("original"));
    const next = await f.service.createWorkItem(f.workspaceId, contract);
    await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, next.workItemId)).status).toBe("running"));
  } finally { ack?.(); }
});

it("unsubscribes again after a user follows up in a completed worker session", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await f.service.submitWorkItem(f.workspaceId, item.workItemId, { ...submission, sessionId: "original" });
  f.complete("original");
  await vi.waitFor(() => expect(f.runner.release).toHaveBeenCalledOnce());
  f.active.add("original");
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(f.runner.release).toHaveBeenCalledOnce();
  f.complete("original", "user-followup");
  await vi.waitFor(() => expect(f.runner.release).toHaveBeenCalledTimes(2));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("closed");
});

it("interrupts a cancelled worker before sending work to the next shared-resource owner", async () => {
  // Exercise service-event ordering independently of filesystem notification timing.
  const watcher = vi.spyOn(DocsService.prototype, "watch").mockReturnValue({ close() {} });
  const f = await fixture();
  const needs = ["browser:shared-profile"];
  const first = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker-a", needs }).finally(() => watcher.mockRestore());
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const second = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker-b", needs });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await f.service.getWorkItem(f.workspaceId, second.workItemId)).status).toBe("queued");
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.active.has("worker-a")).toBe(true);

  const order: string[] = [];
  vi.mocked(f.runner.interrupt).mockImplementation(async (id, turnId) => {
    order.push("interrupt:" + id);
    f.complete(id, turnId, "interrupted");
  });
  vi.mocked(f.runner.send).mockImplementation(async (id) => {
    order.push("send:" + id);
    f.active.add(id);
  });
  await f.service.cancelWorkItem(f.workspaceId, first.workItemId);
  await vi.waitFor(() => expect(order).toContain("send:worker-b"));
  expect(order).toEqual(["interrupt:worker-a", "send:worker-b"]);
  expect((await f.service.getWorkItem(f.workspaceId, second.workItemId)).status).toBe("running");
});

async function fixture(now?: () => string) {
  const f = await setup(now); fixtures.push(f);
  const active = new Set<string>();
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  const started = new Set<Parameters<NonNullable<AgentRunner["onTurnStarted"]>>[0]>();
  const activeTurns = new Map<string, string>();
  let turnSequence = 0;
  let messageSequence = 0;
  // A turn the user opened carries no message id of ours; the scheduler's sends and steers pass theirs.
  const startTurn = (sessionId: string, turnId: string, messageId?: string) => {
    active.add(sessionId);
    activeTurns.set(sessionId, turnId);
    for (const listener of started) listener({ sessionId, turnId, ...(messageId ? { messageId } : {}) });
  };
  const nextTurnId = () => "turn-" + ++turnSequence;
  let sequence = 0;
  const runner: AgentRunner = {
    open: vi.fn(async () => ({ sessionId: "open-" + ++sequence })),
    fork: vi.fn(async (input) => {
      if (input.sourceTurnId === "missing") throw new Error("Unknown source turn");
      return { sessionId: "fork-" + ++sequence, treeId: "tree" };
    }),
    resolveSourceTurn: vi.fn(async () => "source-turn"),
    resume: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    send: vi.fn(async (id, _content, options) => {
      const turnId = nextTurnId();
      const messageId = options?.messageId ?? "message-" + ++messageSequence;
      startTurn(id, turnId, messageId);
      return { turnId, messageId };
    }),
    steer: vi.fn(async (id, _content, messageId) => {
      const activeTurnId = activeTurns.get(id);
      if (activeTurnId) return { turnId: activeTurnId, delivery: "steered" as const };
      const turnId = nextTurnId();
      startTurn(id, turnId, messageId);
      return { turnId, messageId, delivery: "started" as const };
    }),
    interrupt: vi.fn(async (id) => { active.delete(id); }),
    isActive: (id) => active.has(id),
    getActiveTurnId: (id: string) => activeTurns.get(id),
    onTurnStarted: (listener: Parameters<NonNullable<AgentRunner["onTurnStarted"]>>[0]) => {
      started.add(listener); return () => { started.delete(listener); };
    },
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const orchestrator = new Orchestrator({ service: f.service, roles: f.roles, runner, now });
  orchestrators.push(orchestrator);
  const complete = (sessionId: string, turnId = activeTurns.get(sessionId) ?? "end", finishReason: "completed" | "interrupted" | "failed" = "completed") => {
    if (!activeTurns.has(sessionId) || activeTurns.get(sessionId) === turnId) {
      active.delete(sessionId);
      activeTurns.delete(sessionId);
    }
    for (const listener of listeners) listener({ sessionId, turnId, finishReason, ...(finishReason === "failed" ? { failure: "Runtime failed" } : {}) });
  };
  return { ...f, runner, active, orchestrator, complete, startTurn };
}


it("records an ended Worker without automatically sending a handoff reminder", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  f.complete("worker");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined());
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
});

it("requires explicit business continuation after a user stops the Worker", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  f.complete("worker", undefined, "interrupted");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.userStopped).toBe(true));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(f.runner.send).toHaveBeenCalledOnce();
  await f.service.resumeWorkItem(f.workspaceId, item.workItemId);
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
});

it("forks one configured supervisor from completed preparation and waits five minutes after every check", async () => {
  let at = "2026-09-23T01:00:00.000Z";
  const f = await fixture(() => at);
  await f.roles.writeOverride(f.root, "supervisor", "---\nmodel: observer-model\nreasoningOptionId: high\n---\n# 监工");
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.activeTurnId).toBeDefined());
  const prep = (await f.service.listWorkRequests(f.workspaceId))[0]!;
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: prep.workerSessionId });
  await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: prep.workerSessionId!, workItemIds: [item.workItemId] });
  expect(vi.mocked(f.runner.fork).mock.calls.filter(([input]) => input.metadata.role === "supervisor")).toHaveLength(0);
  const prepTurn = prep.activeTurnId;
  f.complete(prep.workerSessionId!);
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.supervisor?.activeTurnId).toBeDefined());
  const current = (await f.service.listWorkRequests(f.workspaceId))[0]!;
  const supervisor = current.supervisor!.sessionId!;
  expect(vi.mocked(f.runner.fork).mock.calls.filter(([input]) => input.metadata.role === "supervisor")).toEqual([
    [expect.objectContaining({ sourceSessionId: prep.workerSessionId, sourceTurnId: prepTurn, modelConfig: { modelId: "observer-model", reasoningOptionId: "high" } })]
  ]);
  const count = () => vi.mocked(f.runner.send).mock.calls.filter(([id]) => id === supervisor).length;
  expect(count()).toBe(1);
  at = "2026-09-23T01:10:00.000Z";
  await reconcile(f.orchestrator, f.workspaceId);
  expect(count()).toBe(1);
  f.complete(supervisor);
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.supervisor?.nextCheckAt).toBe("2026-09-23T01:15:00.000Z"));
  at = "2026-09-23T01:14:59.000Z";
  await reconcile(f.orchestrator, f.workspaceId);
  expect(count()).toBe(1);
  at = "2026-09-23T01:15:00.000Z";
  await reconcile(f.orchestrator, f.workspaceId);
  expect(count()).toBe(2);
  expect(vi.mocked(f.runner.fork).mock.calls.filter(([input]) => input.metadata.role === "supervisor")).toHaveLength(1);
  f.complete(supervisor);
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.supervisor?.nextCheckAt).toBeDefined());
  await f.service.cancelWorkItem(f.workspaceId, item.workItemId);
  await reconcile(f.orchestrator, f.workspaceId);
  expect((await f.service.listWorkRequests(f.workspaceId))[0]?.supervisor?.nextCheckAt).toBeUndefined();
  expect(count()).toBe(2);
});

it("does not backfill supervisors for independent or historical work", async () => {
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  expect(vi.mocked(f.runner.fork).mock.calls.filter(([input]) => input.metadata.role === "supervisor")).toHaveLength(0);
});

it("does not interrupt ordinary follow-up chat merely because its task remains paused", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId });
  f.complete("worker", undefined, "interrupted");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined());
  vi.mocked(f.runner.interrupt).mockClear();
  f.startTurn("worker", "ordinary-question", "user-message");
  await reconcile(f.orchestrator, f.workspaceId);
  expect(f.runner.interrupt).not.toHaveBeenCalled();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.paused).toBe(true);
});

async function reconcile(orchestrator: Orchestrator, workspaceId: string) {
  const runtime = orchestrator as unknown as { enqueue(id: string, task: () => Promise<void>): Promise<void>; reconcile(id: string): Promise<void> };
  await runtime.enqueue(workspaceId, () => runtime.reconcile(workspaceId));
}
