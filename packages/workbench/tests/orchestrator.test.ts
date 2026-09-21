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
  const f = await fixture();
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
  const f = await fixture();
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

async function fixture() {
  const f = await setup(); fixtures.push(f);
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

it("delivers a merge takeover once to the original worker and suppresses automatic integration", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { title: "Merge takeover", objective: "merge", risk: "R1",
    scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "merged" }], sessionId: "worker" });
  await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
  const action = await f.service.createAction(f.workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "pending", stage: "merge", message: "等待合入",
    integration: { operation: "merge", contractRevision: item.contractRevision, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  await f.service.failAction(f.workspaceId, action.actionId, "主工作区有未提交修改");
  f.orchestrator.start();

  await f.service.takeoverIntegration(f.workspaceId, item.workItemId, "保留主目录修改");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  const [sessionId, message] = vi.mocked(f.runner.send).mock.calls[0]!;
  expect(sessionId).toBe("worker");
  expect(message).toContain("workItem.integration.complete");
  expect(message).toContain(action.actionId);
  expect(message).toContain("保留主目录修改");
  expect(vi.mocked(f.runner.resume)).toHaveBeenCalledWith("worker", expect.objectContaining({ title: "Worker · Merge takeover" }));
  expect((await f.service.listActions(f.workspaceId)).find((entry) => entry.actionId === action.actionId)).toMatchObject({
    status: "pending", agent: { sessionId: "worker" }
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
});

it("holds an unconfirmed delegated merge after restart without replaying execution", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { title: "Merge recovery", objective: "recover", risk: "R1",
    scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "merged" }], sessionId: "worker" });
  await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
  const action = await f.service.createAction(f.workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "pending", stage: "merge", message: "等待合入",
    integration: { operation: "merge", contractRevision: item.contractRevision, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  await f.service.failAction(f.workspaceId, action.actionId, "主工作区阻塞");
  f.orchestrator.start();
  await f.service.takeoverIntegration(f.workspaceId, item.workItemId);
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));

  await f.orchestrator.dispose();
  f.active.clear();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.waitReason).toBe("原执行轮状态等待确认"));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
});


it("sends only continue with no notices when retrying the original worker", async () => {
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  let now = Date.now();
  const orchestrator = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner, now: () => new Date(now).toISOString() });
  orchestrators.push(orchestrator);
  orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  f.complete("worker", "turn-1", "failed");
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ status: "retry", attempts: 1 }));
  expect(f.runner.send).toHaveBeenCalledOnce();
  now += 120_000;
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  const [sessionId, message] = vi.mocked(f.runner.send).mock.calls[1]!;
  expect(sessionId).toBe("worker");
  expect(message).toBe("继续");
});

it.each([false, true])("retries a failed takeover turn through execution (user turn: %s)", async (userTurn) => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
  const integration = await f.service.createAction(f.workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "retry", stage: "merge", message: "Git blocked",
    integration: { operation: "merge", contractRevision: 0, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  await f.service.takeoverIntegration(f.workspaceId, item.workItemId, "keep evidence");
  let now = Date.now();
  const orchestrator = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner, now: () => new Date(now).toISOString() });
  orchestrators.push(orchestrator);
  if (userTurn) await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "manual-takeover", content: "continue" }, async () => {
    f.startTurn("worker", "user-turn", "manual-takeover");
    return { accepted: true, turnId: "user-turn" };
  });
  orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", integrationActionId: integration.actionId, deliveredAt: expect.any(String) }));
  f.complete("worker", userTurn ? "user-turn" : "turn-1", "failed");
  if (userTurn) {
    await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ control: "manual", attempts: 0 }));
    expect((await f.service.diagnoseWorkItem(f.workspaceId, item.workItemId)).nextRetryAt).toBeUndefined();
  } else {
    await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ attempts: 1, lastFailure: "turn failed: Runtime failed", retryAt: expect.any(String) }));
    expect((await f.service.diagnoseWorkItem(f.workspaceId, item.workItemId)).nextRetryAt).toBeDefined();
  }
  now += 120_000;
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(userTurn ? 0 : 2));
  if (!userTurn) {
    expect(vi.mocked(f.runner.send).mock.calls.at(-1)![1]).toContain("workItem.integration.complete");
    expect(vi.mocked(f.runner.send).mock.calls.at(-1)![1]).not.toContain("workItem.submit");
  }
  await expect(f.service.submitWorkItem(f.workspaceId, item.workItemId, submission)).rejects.toThrow("integration.complete");
  if (userTurn) {
    await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("decision"));
    await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "finish-manual", content: "complete merge" }, async () => {
      f.startTurn("worker", "finish-turn", "finish-manual");
      return { accepted: true, turnId: "finish-turn" };
    });
    await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running"));
  }
  await f.service.completeIntegration(f.workspaceId, item.workItemId, integration.actionId, "worker");
  f.complete("worker");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("closed"));
  expect((await f.service.listInbox()).filter((entry) => entry.kind === "merged")).toHaveLength(1);
});

it("admits takeover through the scheduler and retains user pause across restart", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
  await f.service.createAction(f.workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "retry", stage: "merge", message: "blocked",
    integration: { operation: "merge", contractRevision: 0, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 1 });
  await f.service.takeoverIntegration(f.workspaceId, item.workItemId);
  f.orchestrator.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).not.toHaveBeenCalled();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  await f.service.pauseWorkItem(f.workspaceId, "worker");
  f.complete("worker", "turn-1", "interrupted");
  await f.orchestrator.dispose();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ pauseReason: "user", attempts: 0 });
  await f.service.resumeWorkItem(f.workspaceId, item.workItemId);
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  await f.service.cancelWorkItem(f.workspaceId, item.workItemId);
  f.complete("worker", "turn-2", "interrupted");
  await vi.waitFor(() => expect(f.runner.interrupt).toHaveBeenCalledWith("worker"));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("cancelled");
});

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
  expect(options).toMatchObject({ attachments: message.attachments, execution: message.execution, messageId: expect.any(String) });
});

it("prepares a verified empty New Chat in place and preserves an unconfirmed delivery", async () => {
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
  expect(saved.pendingMessageId).toEqual(expect.any(String));
  await f.service.putWorkRequest(f.workspaceId, { ...saved, retryAt: undefined });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledOnce();
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
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).not.toHaveBeenCalled();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  expect(f.runner.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "design", sourceTurnId: "source-turn", metadata: expect.objectContaining({ role: "work-preparation" }) }));
  expect(vi.mocked(f.runner.send).mock.calls[0]![1]).toContain((await f.roles.resolve(f.root, "work-preparation")).content);
  const first = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "fork-1" });
  const sibling = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
  expect((await f.service.getWorkItem(f.workspaceId, first.workItemId)).status).toBe("preparing");
  await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "fork-1", workItemIds: [first.workItemId, sibling.workItemId] });
  f.complete("fork-1", "turn-1");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, sibling.workItemId)).status).toBe("running"));
  expect(f.runner.fork).toHaveBeenLastCalledWith(expect.objectContaining({ sourceSessionId: "fork-1", sourceTurnId: "turn-1" }));
  expect(f.runner.resume).toHaveBeenCalledWith("fork-1", expect.objectContaining({ cwd: f.root, metadata: expect.objectContaining({ role: "worker", workItemId: first.workItemId }) }));
  expect(vi.mocked(f.runner.fork).mock.calls.at(-1)![0].metadata).toEqual(expect.objectContaining({ role: "worker" }));
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

it("steers changed contracts into an active worker and records the current revision", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "New criterion", objective: "Updated result" });
  await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalled());
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).contractRevision).toBe(1));
});

it("accepts a submission from the active turn after the worker reads the updated contract", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "New criterion", objective: "Updated result" });
  await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalledOnce());

  const current = await f.service.getWorkItem(f.workspaceId, item.workItemId);
  const submitted = await f.service.submitWorkItem(f.workspaceId, item.workItemId, { ...submission, contractRevision: current.contractRevision });

  expect(submitted.status).toBe("closed");
  expect(submitted.contractRevision).toBe(1);
});

it("waits for an outdated submission's turn and its completion settlement before sending its continuation", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Updated contract", objective: "Updated result" });
  await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).contractRevision).toBe(1));
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
  expect(continuation).toContain("提交依据已过期");
  expect(continuation).not.toContain("尚未落实处置");
  expect(continuation).not.toContain("你负责工单");
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0 });
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(f.runner.send).toHaveBeenCalledTimes(2);
});

it("continues an updated contract with normal idle accounting when the turn ends without submitting", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", deliveredAt: expect.any(String) }));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Updated contract", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).contractRevision).toBe(1));
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", notices: [] }));
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls[1]![1]).toContain("尚未落实处置");
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
});

it("queues a user continuation until the preceding completion settles", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const completed = vi.spyOn(f.service, "workerTurnCompleted");
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", deliveredAt: expect.any(String) }));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "New contract", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).contractRevision).toBe(1));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  completed.mockImplementationOnce(async () => { await gate; });
  f.complete("original", "turn-1");
  try {
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const queued = await f.service.dispatchSessionMessage({ sessionId: "original", messageId: "user-next", content: "continue" }, async () => ({ accepted: true }));
    expect(queued).toMatchObject({ accepted: false, queued: { reason: "等待上一轮结算完成" } });
  } finally { release(); }
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.control).toBe("manual"));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ status: "running", stage: "execute", idleTurns: 0, attempts: 0 });
  expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 });
  expect(f.runner.interrupt).not.toHaveBeenCalled();
  expect(f.runner.send).toHaveBeenCalledTimes(2);
  f.complete("original");
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0, control: "manual" }));
  await f.orchestrator.dispose();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("decision");
  expect(f.runner.send).toHaveBeenCalledTimes(2);
});

it("serializes a queued user turn after completion persistence and ignores repeated completion", async () => {
  const f = await fixture();
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
    record("message.queued", "user-turn");
    expect(await f.service.dispatchSessionMessage({ sessionId: "original", messageId: "user-after-settle", content: "continue" }, async () => ({ accepted: true }))).toMatchObject({ accepted: false, queued: expect.any(Object) });
  } finally { release(); }
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 }));
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.control).toBe("manual"));
  record("run.counted", "turn-1", (await f.service.listRuns(f.workspaceId))[0]!.turns);
  record("completion.duplicate.emitted", "turn-1");
  f.complete("original", "turn-1");
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  await f.orchestrator.dispose();
  expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 });
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", idleTurns: 0, attempts: 0, control: "manual" });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(heartbeat).not.toHaveBeenCalled(); // Heartbeat and idle accounting now share the guarded record commit.
  expect(f.runner.send).toHaveBeenCalledTimes(2);
  expect(f.runner.resume).toHaveBeenCalledOnce();
  record("run.final", "turn-1", (await f.service.listRuns(f.workspaceId))[0]!.turns);
  expect(timeline.map(({ event }) => event)).toEqual([
    "completion.emitted", "settlement.waiting", "message.queued", "transaction.processing",
    "run.counted", "completion.duplicate.emitted", "run.final"
  ]);
  expect(timeline.every((entry, index) => index === 0 || entry.elapsedMs >= timeline[index - 1]!.elapsedMs)).toBe(true);
  expect(timeline.filter(({ turns }) => turns !== undefined).map(({ turns }) => turns)).toEqual([1, 1]);
  console.info("[controlled worker turn handoff]", JSON.stringify({ workItemId: item.workItemId, timeline }, null, 2));
});

it("does not recover a tracked turn across an asynchronous run reload during reconciliation", async () => {
  const f = await fixture();
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
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 0, attempts: 0, notices: [] });
});

it("counts a scheduled turn once when turn-started and completion notifications are repeated", async () => {
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  f.complete("original", "turn-1");
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
  expect((await f.service.listRuns(f.workspaceId)).filter((run) => run.status === "done")).toHaveLength(1);
});

it.each(["completed", "failed"] as const)("recovers scheduled %s accounting after reconstruction", async (finishReason) => {
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", scheduledTurnId: "turn-1" }));
  await f.orchestrator.dispose();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.resume).toHaveBeenCalledTimes(2);
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
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  await f.orchestrator.dispose();
  const action = (await f.service.listActions(f.workspaceId))[0]!;
  await f.service.updateAction(f.workspaceId, action, (latest) => ({ ...latest, scheduledTurnId: undefined }));
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.resume).toHaveBeenCalledTimes(2);
  f.complete("original", "turn-1");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
});

it("keeps a known user followup exempt after reconstruction", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", scheduledTurnId: "turn-1" }));
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 1 });
  f.complete("original", "turn-1");
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 }));
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined());
  await f.service.dispatchSessionMessage({ sessionId: "original", messageId: "manual-followup", content: "continue" }, async () => {
    f.startTurn("original", "user-followup", "manual-followup");
    return { accepted: true, turnId: "user-followup" };
  });
  await f.orchestrator.dispose();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.resume).toHaveBeenCalledTimes(1);
  f.complete("original", "user-followup");
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1 }));
  await restarted.dispose();
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", idleTurns: 0, attempts: 0, scheduledTurnId: "turn-1" });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("decision");
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.control).toBe("manual");
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.runner.interrupt).not.toHaveBeenCalled();
});

it("keeps a turn the scheduler never delivered into out of the item's accounting", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", scheduledTurnId: "turn-1" }));
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 1 });

  // The user asks the worker something in its own turn; nothing of the scheduler's is in flight.
  f.startTurn("original", "user-turn");
  f.complete("original", "user-turn");

  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))[0]).toMatchObject({ turns: 1, status: "running" }));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", idleTurns: 0, attempts: 0, scheduledTurnId: "turn-1" });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("running");
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.runner.steer).not.toHaveBeenCalled();
  expect(f.runner.interrupt).not.toHaveBeenCalled();
});

it("recognizes its own turn when the engine reports the start before the sender names the message", async () => {
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  vi.mocked(f.runner.send).mockImplementationOnce(async (sessionId, _content, options) => {
    f.startTurn(sessionId, "engine-turn");
    f.startTurn(sessionId, "engine-turn", options?.messageId);
    return { turnId: "engine-turn", messageId: options?.messageId };
  });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", scheduledTurnId: "engine-turn" }));
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 1 });

  f.complete("original", "engine-turn");

  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 }));
});

it("captures the started scheduled turn when send returns after its completion", async () => {
  const f = await fixture();
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  let completedTurnOrigin: unknown;
  vi.mocked(f.runner.send).mockImplementationOnce(async (sessionId, _content, options) => {
    f.startTurn(sessionId, "fast-turn", options?.messageId);
    f.complete(sessionId, "fast-turn");
    return { turnId: "fast-turn", messageId: options?.messageId };
  }).mockImplementationOnce(async (sessionId) => {
    completedTurnOrigin = (await f.service.listActions(f.workspaceId))[0];
    f.startTurn(sessionId, "next-turn");
    return { turnId: "next-turn" };
  });
  f.orchestrator.start();
  await vi.waitFor(() => expect(completedTurnOrigin).toMatchObject({ scheduledTurnId: "fast-turn" }));
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ idleTurns: 1, attempts: 0 });
});

it("tracks a new turn opened by steer fallback without invalidating its submission", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  vi.mocked(f.runner.steer).mockImplementationOnce(async (sessionId, _content, messageId) => {
    f.complete("original", "turn-1");
    f.startTurn(sessionId, "fallback-turn", messageId);
    return { turnId: "fallback-turn", delivery: "started" as const };
  });
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Updated", objective: "Updated result" });
  await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", notices: [] }));
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
      "【恢复执行】用户决策答复：Continue? -> Continue (" + note + ")；挂起期间工单调整：Adjustment for " + note,
      expect.objectContaining({ messageId: expect.any(String) })]);
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
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "【恢复执行】用户决策答复：Continue? -> Continue",
    expect.objectContaining({ messageId: expect.any(String) })]);
});

it("resumes a worker decision that also carries its preparation request id", async () => {
  const f = await fixture();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source-turn" });
  await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "original" });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "original" });
  await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "original", workItemIds: [item.workItemId] });
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
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "【恢复执行】用户决策答复：Continue? -> Continue",
    expect.objectContaining({ messageId: expect.any(String) })]);
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
      "【文档合入】引用文档已提交 " + committed.commit + "\n" + diff +
      "\n立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。",
      expect.any(String)]);
  }
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).contractRevision).toBe(2);
  await f.orchestrator.dispose();
  f.active.clear();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.waitReason).toBe("原执行轮状态等待确认"));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
});

it("hands every pending notice over at once and consumes them with that delivery", async () => {
  const f = await fixture();
  const path = ".vermillion/docs/Task/PRD.md";
  await f.service.writeDoc(f.workspaceId, path, "Baseline\n");
  const baseline = await f.service.commitDocs(f.workspaceId, { message: "baseline", paths: [path] });
  // Nothing is dispatched yet, so both notices stay pending on the record.
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original",
    refs: [{ path, commit: baseline.commit }] });
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Criterion moved", objective: "Updated result" });
  await f.service.writeDoc(f.workspaceId, path, "Second baseline\n");
  const committed = await f.service.commitDocs(f.workspaceId, { message: "second baseline", paths: [path] });

  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());

  const message = vi.mocked(f.runner.send).mock.calls[0]![1];
  expect(message).toContain("【合同调整】Criterion moved");
  expect(message).toContain("【文档合入】引用文档已提交 " + committed.commit);
  expect(message.split("【合同调整】")).toHaveLength(2);
  expect(message.split("【文档合入】")).toHaveLength(2);
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]?.notices).toEqual([]));
  const [action] = await f.service.listActions(f.workspaceId);
  expect(action).toMatchObject({ notices: [] });
  expect(action!.history.map((entry) => entry.event)).toEqual(expect.arrayContaining(["contract.updated", "docs.updated"]));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.resumeMessage).toBeUndefined();
});

it("leaves a worker's own contract edit out of its session while moving the revision", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute" }));
  const emitted: string[] = [];
  f.service.subscribe((event) => { if ("type" in event) emitted.push(event.type); });

  const updated = await f.service.updateWorkItem(f.workspaceId, item.workItemId, { sessionId: "original",
    note: "Narrow the criterion", acceptance: [...contract.acceptance, { text: "Second criterion" }] });

  expect(updated.contractRevision).toBe(1);
  expect(updated.decisions).toEqual(["工单调整：Narrow the criterion"]);
  expect(updated.run.resumeMessage).toBeUndefined();
  expect(emitted).not.toContain("workItem.updated");
  expect(f.runner.steer).not.toHaveBeenCalled();
  expect(f.runner.interrupt).not.toHaveBeenCalled();
  expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({ stage: "execute", notices: [] });
});

it("parks a worker on the dependency it declared itself without interrupting the turn", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const blocker = await f.service.createWorkItem(f.workspaceId, { ...contract, title: "Blocker", sessionId: "blocker-worker" });

  const updated = await f.service.updateWorkItem(f.workspaceId, item.workItemId, { sessionId: "original",
    note: "Wait for the blocker", dependsOn: [blocker.workItemId] });

  expect(updated.status).toBe("queued");
  expect(f.runner.interrupt).not.toHaveBeenCalled();
  f.complete("original", "turn-1");
  await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId))
    .some((run) => run.workItemId === item.workItemId && run.status === "running")).toBe(false));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("queued");
  expect(f.runner.interrupt).not.toHaveBeenCalled();
  const diagnosis = await f.service.diagnoseWorkItem(f.workspaceId, item.workItemId);
  expect(diagnosis.blockers.some((entry) => entry.reason.includes(blocker.workItemId))).toBe(true);
  expect(diagnosis.dependencies.map((entry) => entry.workItemId)).toEqual([blocker.workItemId]);
});
