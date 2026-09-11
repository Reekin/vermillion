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

it("detaches a completed worker after its turn ends without waiting for release ACK", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  let ack!: () => void;
  vi.mocked(f.runner.release).mockImplementation(() => new Promise<void>((resolve) => { ack = resolve; }));
  try {
    expect((await f.service.submitWorkItem(f.workspaceId, item.workItemId, submission)).status).toBe("closed");
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
  await f.service.submitWorkItem(f.workspaceId, item.workItemId, submission);
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
  vi.mocked(f.runner.interrupt).mockImplementation(async (id) => {
    order.push("interrupt:" + id);
    f.active.delete(id);
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

it("does not retry a manually stopped worker until the work item is explicitly resumed", async () => {
  const f = await fixture(true);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());

  const paused = await f.service.pauseWorkItem(f.workspaceId, "original");
  expect(paused.paused).toBe(true);
  f.complete("original", "turn-1", "interrupted");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.pauseReason).toBe("user"));
  const stopped = await f.service.getWorkItem(f.workspaceId, item.workItemId);
  expect(stopped).toMatchObject({ status: "decision", run: { attempts: 0, pauseReason: "user" } });
  expect(stopped.run.retryAt).toBeUndefined();
  expect(f.runner.send).toHaveBeenCalledOnce();

  await f.service.resumeWorkItem(f.workspaceId, item.workItemId);
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
});

it("interrupts cancelled preparation and does not retry it after the turn settles", async () => {
  const f = await fixture(true);
  f.orchestrator.start();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source-turn" });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());

  const preparationSession = (await f.service.listWorkRequests(f.workspaceId))[0]!.workerSessionId!;
  await f.service.cancelWorkRequest(f.workspaceId, { requestId: request.requestId });
  await vi.waitFor(() => expect(f.runner.interrupt).toHaveBeenCalledWith(preparationSession));
  f.complete(preparationSession, "preparation-turn", "interrupted");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const cancelled = (await f.service.listWorkRequests(f.workspaceId))[0]!;
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.attempts).toBeUndefined();
  expect(cancelled.retryAt).toBeUndefined();
  expect(f.runner.send).toHaveBeenCalledOnce();
});

async function fixture(trackTurns = false) {
  const f = await setup(); fixtures.push(f);
  const active = new Set<string>();
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  const started = new Set<Parameters<NonNullable<AgentRunner["onTurnStarted"]>>[0]>();
  const activeTurns = new Map<string, string>();
  let turnSequence = 0;
  const startTurn = (sessionId: string, turnId: string) => {
    active.add(sessionId);
    activeTurns.set(sessionId, turnId);
    for (const listener of started) listener({ sessionId, turnId });
  };
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
    send: vi.fn(async (id) => {
      if (!trackTurns) { active.add(id); return; }
      const turnId = "turn-" + ++turnSequence;
      startTurn(id, turnId);
      return { turnId };
    }),
    steer: vi.fn(async (id) => ({ turnId: activeTurns.get(id) ?? "active-turn" })),
    interrupt: vi.fn(async (id) => { active.delete(id); }),
    isActive: (id) => active.has(id),
    ...(trackTurns ? {
      getActiveTurnId: (id: string) => activeTurns.get(id),
      onTurnStarted: (listener: Parameters<NonNullable<AgentRunner["onTurnStarted"]>>[0]) => {
        started.add(listener); return () => { started.delete(listener); };
      }
    } : {}),
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const orchestrator = new Orchestrator({ service: f.service, roles: f.roles, runner });
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

it("sends composed input and configured preparation together after the selected source finishes", async () => {
  const f = await fixture();
  f.active.add("design");
  f.orchestrator.start();
  const message = { content: "[$review](/skills/review)\n\nImplement ABC", attachments: [
    { attachmentId: "image", mimeType: "image/png", uri: "file:///example.png" }
  ], execution: { modelId: "chosen-model", reasoningOptionId: "high", serviceTierId: null } };
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "viewed-turn", message });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).not.toHaveBeenCalled();
  expect(f.runner.fork).not.toHaveBeenCalled();
  expect((await f.service.listWorkRequests(f.workspaceId))[0]?.message).toEqual(message);
  f.complete("design");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  expect(f.runner.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "design", sourceTurnId: "viewed-turn" }));
  const [target, content, options] = vi.mocked(f.runner.send).mock.calls[0]!;
  expect(target).toBe("fork-1");
  expect(content.startsWith(message.content + "\n\n" + (await f.roles.resolve(f.root, "work-preparation")).content)).toBe(true);
  expect(content).toContain(request.requestId);
  expect(options).toEqual({ attachments: message.attachments, execution: message.execution });
});

it("prepares a verified empty New Chat in place and preserves its message for retry", async () => {
  const f = await fixture();
  vi.mocked(f.runner.resolveSourceTurn!).mockResolvedValue(undefined);
  vi.mocked(f.runner.send).mockRejectedValueOnce(new Error("provider unavailable"));
  f.orchestrator.start();
  const message = { content: "New task", attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png" }] };
  const request = await f.service.startWork(f.workspaceId, { sessionId: "new", message });
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.failure).toBe("provider unavailable"));
  expect(f.runner.fork).not.toHaveBeenCalled();
  expect(f.runner.open).not.toHaveBeenCalled();
  expect(f.runner.resume).not.toHaveBeenCalled();
  const saved = (await f.service.listWorkRequests(f.workspaceId))[0]!;
  expect(saved.sourceTurnId).toBeUndefined();
  expect(saved.workerSessionId).toBe("new");
  await f.service.putWorkRequest(f.workspaceId, { ...saved, retryAt: undefined });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(f.runner.send).toHaveBeenLastCalledWith("new", expect.stringContaining("New task"), { attachments: message.attachments, execution: undefined });
  expect(f.runner.fork).not.toHaveBeenCalled();
});

it("requires a source resolver to verify empty sessions and rejects contentless empty work", async () => {
  const f = await fixture();
  await expect(f.service.startWork(f.workspaceId, { sessionId: "unknown", message: { content: "task" } })).rejects.toThrow("turnId");
  f.orchestrator.start();
  vi.mocked(f.runner.resolveSourceTurn!).mockResolvedValue(undefined);
  await expect(f.service.startWork(f.workspaceId, { sessionId: "empty" })).rejects.toThrow("空会话");
});

it("waits for the source turn, prepares while execution is disabled, then resumes and forks queued siblings", async () => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  f.active.add("design"); f.orchestrator.start();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", scope: "ABC" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.fork).not.toHaveBeenCalled();
  f.complete("design", "source-turn");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  expect(f.runner.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "design", sourceTurnId: "source-turn", metadata: expect.objectContaining({ role: "work-preparation" }) }));
  expect(vi.mocked(f.runner.fork).mock.calls[0]![0].developerInstructions).toBeUndefined();
  expect(vi.mocked(f.runner.send).mock.calls[0]![1]).toContain((await f.roles.resolve(f.root, "work-preparation")).content);
  expect(f.runner.resume).not.toHaveBeenCalledWith("fork-1", expect.objectContaining({ developerInstructions: expect.any(String) }));
  const first = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "fork-1" });
  const sibling = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
  expect((await f.service.getWorkItem(f.workspaceId, first.workItemId)).status).toBe("preparing");
  f.complete("fork-1", "prep-end");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, sibling.workItemId)).status).toBe("running"));
  expect(f.runner.fork).toHaveBeenLastCalledWith(expect.objectContaining({ sourceSessionId: "fork-1", sourceTurnId: "prep-end" }));
  expect(f.runner.resume).toHaveBeenCalledWith("fork-1", expect.objectContaining({ cwd: f.root, developerInstructions: expect.stringContaining("reviewer subagent prompt"), metadata: expect.objectContaining({ role: "worker", workItemId: first.workItemId }) }));
  expect(vi.mocked(f.runner.fork).mock.calls.at(-1)![0].developerInstructions).toContain("verifier subagent prompt");
  expect(f.runner.open).not.toHaveBeenCalled();
});

it("fails an explicit missing source turn visibly instead of forking the latest turn", async () => {
  const f = await fixture(); f.orchestrator.start();
  await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "missing" });
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ status: "pending", attempts: 1, failure: "Unknown source turn" }));
  expect(f.runner.send).not.toHaveBeenCalled();
});

it("records resume failure and preserves the original execution session without opening a replacement", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  vi.mocked(f.runner.resume).mockResolvedValue(false);
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ sessionId: "original", attempts: 1 }));
  expect(f.runner.open).not.toHaveBeenCalled();
  expect(f.runner.fork).not.toHaveBeenCalled();
  expect((await f.service.diagnoseWorkItem(f.workspaceId, item.workItemId)).nextRetryAt).toBeTruthy();
});

it("steers changed contracts into an active worker and voids the old turn's submission", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "New criterion", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("active-turn"));
  expect(f.runner.steer).toHaveBeenCalled();
});

it("waits for a returned submission's turn and its completion settlement before sending its continuation", async () => {
  const f = await fixture(true);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Updated contract", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("turn-1"));
  expect((await f.service.submitWorkItem(f.workspaceId, item.workItemId, submission)).status).toBe("queued");
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  const settled = vi.spyOn(f.service, "workerTurnCompleted");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  settled.mockImplementationOnce(async () => { await gate; });
  f.complete("original", "turn-1");
  try {
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("queued");
    expect(f.runner.send).toHaveBeenCalledOnce();
    expect(f.runner.steer).toHaveBeenCalledOnce();
  } finally { release(); }
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  const continuation = vi.mocked(f.runner.send).mock.calls[1]![1];
  expect(continuation).toContain("提交作废");
  expect(continuation).not.toContain("尚未落实处置");
  expect(continuation).not.toContain("你负责工单");
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0 });
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(f.runner.send).toHaveBeenCalledTimes(2);
});

it("continues an updated contract without idle accounting when the stale turn ends without submitting", async () => {
  const f = await fixture(true);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", deliveredAt: expect.any(String) }));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Updated contract", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("turn-1"));
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", message: "" }));
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls[1]).toEqual(["original", "本轮已结束。重新执行 vermillion workItem.get 读取最新合同，按新合同继续。"]);
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0 });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBeUndefined();
});

it("keeps a user-started turn when the previous completion is delayed, without idle-failure accounting", async () => {
  const f = await fixture(true);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const completed = vi.spyOn(f.service, "workerTurnCompleted");
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", deliveredAt: expect.any(String) }));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "New contract", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("turn-1"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  completed.mockImplementationOnce(async () => { await gate; });
  f.complete("original", "turn-1");
  try {
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    f.startTurn("original", "user-turn");
  } finally { release(); }
  const cleanup = vi.spyOn(f.service, "releaseIdleWorkers");
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ status: "running", stage: "execute", idleTurns: 0, attempts: 0 });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBeUndefined();
  expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1, status: "running" });
  expect(f.runner.interrupt).not.toHaveBeenCalled();
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.runner.resume).toHaveBeenCalledOnce();
  cleanup.mockClear();
  f.complete("original", "user-turn");
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
  await f.orchestrator.dispose();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0 });
  expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 2, status: "running" });
  expect(f.runner.send).toHaveBeenCalledOnce();
});

it("atomically drops old idle accounting when a user starts while completion persistence is waiting", async () => {
  const f = await fixture(true);
  const timeline: Array<{ event: string; at: string; elapsedMs: number; sessionId: string; turnId: string; turns?: number }> = [];
  const startedAt = performance.now();
  const record = (event: string, turnId: string, turns?: number) => timeline.push({
    event, at: new Date().toISOString(), elapsedMs: performance.now() - startedAt, sessionId: "original", turnId,
    ...(turns === undefined ? {} : { turns })
  });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  const settle = f.service.settleWorkerTurn.bind(f.service);
  const waiting = vi.spyOn(f.service, "settleWorkerTurn");
  const heartbeat = vi.spyOn(f.service, "heartbeatWorkItem");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  waiting.mockImplementationOnce(async (workspaceId, workItemId, input) => {
    record("settlement.waiting", input.turnId!);
    await gate;
    return settle(workspaceId, workItemId, { ...input, ownsExecution: () => {
      record("transaction.processing", input.turnId!);
      return input.ownsExecution();
    } });
  });
  record("completion.emitted", "turn-1");
  f.complete("original", "turn-1");
  try {
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
    record("turn.started", "user-turn");
    f.startTurn("original", "user-turn");
  } finally { release(); }
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 }));
  record("run.counted", "turn-1", (await f.service.listRuns(f.workspaceId))[0]!.turns);
  record("completion.duplicate.emitted", "turn-1");
  f.complete("original", "turn-1");
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  await f.orchestrator.dispose();
  expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1, status: "running" });
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", idleTurns: 0, attempts: 0, message: "" });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(heartbeat).not.toHaveBeenCalled(); // Heartbeat and idle accounting now share the guarded record commit.
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.runner.resume).toHaveBeenCalledOnce();
  record("run.final", "turn-1", (await f.service.listRuns(f.workspaceId))[0]!.turns);
  expect(timeline.map(({ event }) => event)).toEqual([
    "completion.emitted", "settlement.waiting", "turn.started", "transaction.processing",
    "run.counted", "completion.duplicate.emitted", "run.final"
  ]);
  expect(timeline.every((entry, index) => index === 0 || entry.elapsedMs >= timeline[index - 1]!.elapsedMs)).toBe(true);
  expect(timeline.filter(({ turns }) => turns !== undefined).map(({ turns }) => turns)).toEqual([1, 1]);
  console.info("[controlled worker turn handoff]", JSON.stringify({ workItemId: item.workItemId, timeline }, null, 2));
});

it("does not recover a tracked turn across an asynchronous run reload during reconciliation", async () => {
  const f = await fixture(true);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", deliveredAt: expect.any(String) }));
  const listRuns = f.service.listRuns.bind(f.service);
  vi.spyOn(f.service, "listRuns").mockImplementationOnce(async (...args) => {
    const runs = await listRuns(...args);
    f.complete("original", "turn-1");
    return runs;
  });
  const dispatch = vi.spyOn(f.service, "workspaceRoot");
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
  await f.orchestrator.dispose();
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0, message: "" });
});

it("counts a scheduled turn once when turn-started and completion notifications are repeated", async () => {
  const f = await fixture(true);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  f.startTurn("original", "turn-1");
  f.complete("original", "turn-1");
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
  expect((await f.service.listRuns(f.workspaceId)).filter((run) => run.status === "done")).toHaveLength(1);
});

it.each(["completed", "failed"] as const)("recovers scheduled %s accounting after reconstruction", async (finishReason) => {
  const f = await fixture(true);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", scheduledTurnId: "turn-1" }));
  await f.orchestrator.dispose();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(() => expect(f.runner.resume).toHaveBeenCalledTimes(2));
  expect(f.runner.send).toHaveBeenCalledOnce();
  f.complete("original", "turn-1", finishReason);
  if (finishReason === "failed") {
    await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ status: "retry", attempts: 1, failure: "turn failed: Runtime failed", retryAt: expect.any(String) }));
    expect(f.runner.send).toHaveBeenCalledOnce();
  } else {
    await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
    expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
  }
});

it("does not exempt an active turn of unknown origin after reconstruction", async () => {
  const f = await fixture(true);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  await f.orchestrator.dispose();
  const action = (await f.service.listActions(f.workspaceId))[0]!;
  await f.service.updateAction(f.workspaceId, action, (latest) => ({ ...latest, scheduledTurnId: undefined }));
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(() => expect(f.runner.resume).toHaveBeenCalledTimes(2));
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
});

it("keeps a known user followup exempt after reconstruction", async () => {
  const f = await fixture(true);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", scheduledTurnId: "turn-1" }));
  f.startTurn("original", "user-followup");
  f.complete("original", "turn-1");
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 }));
  await f.orchestrator.dispose();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(() => expect(f.runner.resume).toHaveBeenCalledTimes(2));
  f.complete("original", "user-followup");
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 2 }));
  await restarted.dispose();
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", idleTurns: 0, attempts: 0, scheduledTurnId: "turn-1" });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.runner.interrupt).not.toHaveBeenCalled();
});

it("captures the started scheduled turn when send returns after its completion", async () => {
  const f = await fixture(true);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  let completedTurnOrigin: unknown;
  vi.mocked(f.runner.send).mockImplementationOnce(async (sessionId) => {
    f.startTurn(sessionId, "fast-turn");
    f.complete(sessionId, "fast-turn");
  }).mockImplementationOnce(async (sessionId) => {
    completedTurnOrigin = (await f.service.listActions(f.workspaceId))[0];
    f.startTurn(sessionId, "next-turn");
    return { turnId: "next-turn" };
  });
  f.orchestrator.start();
  await vi.waitFor(() => expect(completedTurnOrigin).toMatchObject({ scheduledTurnId: "fast-turn" }));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
});

it("tracks a new turn opened by steer fallback without marking its submission stale", async () => {
  const f = await fixture(true);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  vi.mocked(f.runner.steer).mockImplementationOnce(async () => {
    f.complete("original", "turn-1");
    f.startTurn("original", "fallback-turn");
    return {};
  });
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Updated", objective: "Updated result" });
  await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", message: "" }));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBeUndefined();
  f.complete("original", "fallback-turn");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
});

it("delivers decision answers and parked adjustments once without replaying worker instructions", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const initial = vi.mocked(f.runner.send).mock.calls[0]![1];
  expect(initial).toContain("你负责工单");
  expect(initial).toContain("workItem.get");
  expect(initial).toContain("完成后必须调用");
  for (const note of ["First answer", "Second answer"]) {
    const card = await f.service.createDecision(f.workspaceId, { workItemId: item.workItemId,
      sessionId: "original", question: "Continue?", context: "Choice", options: [{ key: "yes", label: "Continue" }] });
    f.complete("original");
    await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId)).some((run) => run.status === "running")).toBe(false));
    await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Adjustment for " + note });
    const count = vi.mocked(f.runner.send).mock.calls.length;
    await f.service.answerDecision(f.workspaceId, card.decisionId, { key: "yes", note });
    await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(count + 1));
    expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original",
      "用户决策答复：Continue? -> Continue (" + note + ")；挂起期间工单调整：Adjustment for " + note]);
  }
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).decisions).toHaveLength(2);
});

it("records the opening delivery even when the worker creates a decision before send returns", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  vi.mocked(f.runner.send).mockImplementationOnce(async () => {
    await f.service.createDecision(f.workspaceId, { workItemId: item.workItemId, sessionId: "original",
      question: "Continue?", context: "Choice", options: [{ key: "yes", label: "Continue" }] });
  });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({
    status: "decision", deliveredAt: expect.any(String)
  }));
  const [card] = await f.service.listDecisions(f.workspaceId);
  await f.service.answerDecision(f.workspaceId, card!.decisionId, { key: "yes" });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "用户决策答复：Continue? -> Continue"]);
});

it("resumes a worker decision that also carries its preparation request id", async () => {
  const f = await fixture();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source-turn" });
  await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "original" });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "original" });
  await f.service.finishPreparation(f.workspaceId, "original", "prep-end");
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());

  const action = (await f.service.listActions(f.workspaceId))[0]!;
  const card = await f.service.createDecision(f.workspaceId, {
    requestId: request.requestId, workItemId: item.workItemId, actionId: action.actionId, sessionId: "original", kind: "worker",
    question: "Continue?", context: "Choice", options: [{ key: "yes", label: "Continue" }]
  });
  f.complete("original");
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId)).some((run) => run.status === "running")).toBe(false));

  await f.service.answerDecision(f.workspaceId, card.decisionId, { key: "yes" });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "用户决策答复：Continue? -> Continue"]);
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
});

it("steers only the latest committed document diff and resumes without the opening message", async () => {
  const f = await fixture();
  const path = ".vermillion/docs/Task/PRD.md";
  await f.service.writeDoc(f.workspaceId, path, "Baseline\n");
  const baseline = await f.service.commitDocs(f.workspaceId, { message: "baseline", paths: [path] });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original",
    refs: [{ path, commit: baseline.commit }] });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  for (const content of ["First change\n", "Second change\n"]) {
    await f.service.writeDoc(f.workspaceId, path, content);
    const diff = await f.service.docDiff(f.workspaceId, path);
    const count = vi.mocked(f.runner.steer).mock.calls.length;
    const committed = await f.service.commitDocs(f.workspaceId, { message: content.trim(), paths: [path] });
    await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalledTimes(count + 1));
    expect(vi.mocked(f.runner.steer).mock.calls.at(-1)).toEqual(["original",
      "工单已调整：引用文档已提交 " + committed.commit + "\n" + diff +
      "\n立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。"]);
  }
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("active-turn");
  await f.orchestrator.dispose();
  f.active.clear();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "会话已恢复。核对当前成果与持久化处置结果，继续尚未完成的动作。"]);
});
