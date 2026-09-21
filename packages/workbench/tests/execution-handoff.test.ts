import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { contract, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async () => { const f = await setup(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

it("keeps a registered decision deliverable when the ordinary-message withdrawal API is used", async () => {
  const f = await fixture();
  const deliver = vi.fn(async () => ({ accepted: true, turnId: "answer-turn", delivery: "started" as const }));
  f.service.setMessageDeliveryPort(deliver);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
  const action = (await f.service.listActions(f.workspaceId)).find((entry) => entry.workItemId === item.workItemId)!;
  const decision = await f.service.createDecision(f.workspaceId, {
    workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker", kind: "worker",
    question: "Continue?", context: "Registered business choice", options: [{ key: "go", label: "Continue" }]
  });
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  await f.service.answerDecision(f.workspaceId, decision.decisionId, { key: "go" });
  const [pending] = await f.service.listPendingSessionMessages("worker");
  expect(pending).toMatchObject({ state: "queued", canWithdraw: false });
  expect(await f.service.cancelPendingSessionMessage("worker", pending!.messageId)).toEqual({ cancelled: false });
  expect(deliver).not.toHaveBeenCalled();
  expect((await f.service.listDecisions(f.workspaceId))[0]).toMatchObject({ deliveryPending: true, answer: { key: "go" } });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await f.service.flushSessionMessages(f.workspaceId);
  expect(deliver).toHaveBeenCalledOnce();
  expect((await f.service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(false);
});

it("moves preregistered preparation ownership and opens Workers only after handoff", async () => {
  const f = await fixture();
  const service = new WorkbenchService({ ...f.options, executionTransfer: { interrupt: async () => {}, fork: async () => ({ sessionId: "new-prep" }) } });
  try {
    const request = await service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
    await service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "old-prep" });
    const first = await service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "old-prep" });
    const sibling = await service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId });
    await service.continueWorkFrom(f.workspaceId, request.requestId, { sessionId: "old-prep", turnId: "history" });
    expect((await service.getWorkItem(f.workspaceId, first.workItemId)).run.sessionId).toBe("new-prep");
    const deliver = vi.fn(async () => ({ accepted: true }));
    expect(await service.dispatchSessionMessage({ sessionId: "old-prep", messageId: "old", content: "continue" }, deliver)).toMatchObject({ accepted: false, error: { code: "execution_moved" } });
    await expect(service.startWorkItem(f.workspaceId, sibling.workItemId, { sessionId: "sibling" })).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
    await service.pauseWork(f.workspaceId, request.requestId);
    await service.resumeWork(f.workspaceId, request.requestId);
    expect((await service.getWorkItem(f.workspaceId, first.workItemId)).status).toBe("preparing");
    expect((await service.getWorkItem(f.workspaceId, sibling.workItemId)).status).toBe("preparing");
    expect(await service.isWorkItemBlocked(f.workspaceId, sibling.workItemId)).toBe(true);
    await service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "new-prep", workItemIds: [first.workItemId, sibling.workItemId] });
    await service.finishPreparation(f.workspaceId, "new-prep", "ready");
    expect((await service.getWorkItem(f.workspaceId, first.workItemId)).status).toBe("queued");
    expect(await service.isWorkItemBlocked(f.workspaceId, sibling.workItemId)).toBe(false);
  } finally { await service.dispose(); }
});

it.each(["manual", "auto"] as const)("keeps a %s decision pending when delivery is queued by a later pause", async (control) => {
  const f = await fixture();
  let itemId = "";
  const service = new WorkbenchService({ ...f.options, sessionSteerer: async (message) => {
    await service.pauseWorkItem(f.workspaceId, { workItemId: itemId });
    return { sessionId: message.sessionId, accepted: false, queued: { messageId: message.messageId!, reason: "当前工作已暂停" } };
  } });
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" }); itemId = item.workItemId;
    const action = (await service.listActions(f.workspaceId))[0]!;
    await service.updateAction(f.workspaceId, action, (current) => ({ ...current, control }));
    const card = await service.createDecision(f.workspaceId, { workItemId: itemId, actionId: action.actionId, sessionId: "worker", kind: "worker", question: "Go?", context: "Choice", options: [{ key: "go", label: "Go" }] });
    const result = await service.answerDecision(f.workspaceId, card.decisionId, { key: "go" });
    expect(result.deliveryPending).toBe(true);
    expect((await service.getWorkItem(f.workspaceId, itemId)).run.control).toBe("paused");
    expect((await service.listPendingSessionMessages("worker"))[0]?.state).toBe("queued");
    const deliver = vi.fn(async () => ({ accepted: true, turnId: "answer-turn" }));
    service.setMessageDeliveryPort(deliver);
    await service.resumeWorkItem(f.workspaceId, itemId);
    await service.flushSessionMessages(f.workspaceId);
    await service.flushSessionMessages(f.workspaceId);
    expect(deliver).toHaveBeenCalledOnce();
    expect((await service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(false);
  } finally { await service.dispose(); }
});

it("confirms an uncertain active supplement without changing the running turn control", async () => {
  const f = await fixture();
  const service = new WorkbenchService({ ...f.options, deliveryConfirmer: async () => ({ accepted: true, active: true, turnId: "active" }) });
  try {
    await service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    await service.dispatchSessionMessage({ sessionId: "worker", messageId: "start", content: "work", origin: "scheduler" }, async () => ({ accepted: true, turnId: "active" }));
    service.setWorkerActiveChecker(() => true);
    await expect(service.dispatchSessionMessage({ sessionId: "worker", messageId: "supplement", content: "extra" }, async () => { throw new Error("lost"); })).rejects.toThrow("lost");
    expect(await service.listPendingSessionMessages("worker")).toMatchObject([{ messageId: "supplement", state: "unknown" }]);
    const confirmed = await service.confirmWorkItemDelivery(f.workspaceId, item.workItemId);
    expect(confirmed.run).toMatchObject({ control: "auto", activeTurnId: "active" });
    expect(confirmed.run.pendingMessageId).toBeUndefined();
    expect(await service.listPendingSessionMessages("worker")).toEqual([]);
    const deliver = vi.fn(async () => ({ accepted: true }));
    expect(await service.dispatchSessionMessage({ sessionId: "worker", messageId: "supplement", content: "extra" }, deliver)).toMatchObject({ accepted: true });
    expect(deliver).not.toHaveBeenCalled();
  } finally { await service.dispose(); }
});

it("settles a manual preparation with no automatic preparation map entry", async () => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "prep", control: "manual" });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "prep" });
  let completed!: Parameters<AgentRunner["onTurnCompleted"]>[0];
  const runner = { isActive: () => false, onTurnCompleted: (listener: typeof completed) => { completed = listener; return () => {}; }, release: async () => {}, interrupt: async () => {} } as AgentRunner;
  const orchestrator = new Orchestrator({ service: f.service, roles: f.roles, runner }); orchestrator.start();
  try {
    await f.service.dispatchSessionMessage({ sessionId: "prep", messageId: "manual", content: "prepare" }, async () => ({ accepted: true, turnId: "prep-end" }));
    await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "prep", workItemIds: [item.workItemId] });
    completed({ sessionId: "prep", turnId: "prep-end", finishReason: "completed" });
    await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.status).toBe("ready"));
    expect((await f.service.listWorkRequests(f.workspaceId))[0]?.control).toBe("manual");
    expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("queued");
  } finally { await orchestrator.dispose(); }
});

it.each(["completed", "failed"] as const)("reconciles a %s offline Worker with automatic dispatch disabled exactly once", async (finishReason) => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "start", content: "work", origin: "scheduler" }, async () => ({ accepted: true, turnId: "offline" }));
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  const restarted = new WorkbenchService(f.options);
  restarted.setTurnInspector(async () => ({ status: "completed", finishReason, failure: finishReason === "failed" ? "network lost" : undefined }));
  try {
    await restarted.confirmWorkItemDelivery(f.workspaceId, item.workItemId);
    await restarted.confirmWorkItemDelivery(f.workspaceId, item.workItemId);
    const action = (await restarted.listActions(f.workspaceId))[0]!;
    expect(action.history.filter((entry) => entry.event === "turn." + finishReason)).toHaveLength(1);
    expect(action).toMatchObject(finishReason === "completed" ? { control: "auto", idleTurns: 1 } : { control: "auto", attempts: 1, retryAt: expect.any(String) });
    expect((await restarted.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined();
  } finally { await restarted.dispose(); }
});

it("keeps the original paused owner while a send is in flight and only transfers after its outcome is known", async () => {
  const f = await fixture();
  const fork = vi.fn(async () => ({ sessionId: "new-worker" }));
  const service = new WorkbenchService({ ...f.options, executionTransfer: { interrupt: async () => {}, fork } });
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    let accept!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => { accept = resolve; });
    const started = new Promise<void>((resolve) => { enter = resolve; });
    const sending = service.dispatchSessionMessage({ sessionId: "worker", messageId: "pending", content: "work" }, async () => {
      enter(); await gate; return { accepted: true, turnId: "old-turn" };
    });
    await started;
    await expect(service.continueWorkItemFrom(f.workspaceId, item.workItemId, { sessionId: "worker", turnId: "history" })).rejects.toThrow("尚未确认的发送");
    expect(fork).not.toHaveBeenCalled();
    accept(); await sending;
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ sessionId: "worker", control: "paused", activeTurnId: "old-turn" });
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run.pendingMessageId).toBeUndefined();
    service.setTurnInspector(async () => ({ status: "completed", finishReason: "interrupted" }));
    await service.confirmWorkItemDelivery(f.workspaceId, item.workItemId);
    await service.continueWorkItemFrom(f.workspaceId, item.workItemId, { sessionId: "worker", turnId: "history" });
    expect(fork).toHaveBeenCalledOnce();
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run.sessionId).toBe("new-worker");
  } finally { await service.dispose(); }
});

it("moves a queued formal answer to the current owner and acknowledges it exactly once", async () => {
  const f = await fixture();
  const service = new WorkbenchService({ ...f.options, executionTransfer: { interrupt: async () => {}, fork: async () => ({ sessionId: "new-worker" }) } });
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    const action = (await service.listActions(f.workspaceId))[0]!;
    const card = await service.createDecision(f.workspaceId, { workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker", question: "Continue?", context: "Choose", options: [{ key: "go", label: "Go" }] });
    await service.answerDecision(f.workspaceId, card.decisionId, { key: "go" });
    expect((await service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(true);
    await service.continueWorkItemFrom(f.workspaceId, item.workItemId, { sessionId: "worker", turnId: "history" });
    expect(await service.listPendingSessionMessages("worker")).toEqual([]);
    expect(await service.listPendingSessionMessages("new-worker")).toMatchObject([{ messageId: "decision-" + card.decisionId, state: "queued" }]);
    const deliver = vi.fn(async () => ({ accepted: true, turnId: "new-answer" })); service.setMessageDeliveryPort(deliver);
    await service.flushSessionMessages(f.workspaceId); await service.flushSessionMessages(f.workspaceId);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ sessionId: "new-worker", messageId: "decision-" + card.decisionId, content: expect.stringContaining("用户决策答复") });
    expect((await service.listDecisions(f.workspaceId))[0]).toMatchObject({ sessionId: "new-worker", deliveryPending: false });
  } finally { await service.dispose(); }
});

it.each(["paused", "manual"] as const)("reconciles completed facts while preserving %s ownership and allows an unknown result to be checked again", async (control) => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "turn", content: "work" }, async () => ({ accepted: true, turnId: "offline" }));
  if (control === "paused") await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId });
  let known = false;
  f.service.setTurnInspector(async () => known ? { status: "completed", finishReason: "completed" } : { status: "unknown" });
  await f.service.confirmWorkItemDelivery(f.workspaceId, item.workItemId);
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ activeTurnId: "offline", control });
  known = true;
  await f.service.confirmWorkItemDelivery(f.workspaceId, item.workItemId);
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.control).toBe(control);
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined();
});

it.each([false, true])("readmits an expired supplement before a new turn (formal answer: %s)", async (formal) => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "auto", content: "work", origin: "scheduler" }, async () => ({ accepted: true, turnId: "old" }));
  let active = true;
  f.service.setWorkerActiveChecker(() => active);
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "fallback", content: "continue", ...(formal ? { decisionId: "formal-answer" } : {}) },
    async (message) => {
      expect(message.allowStart).toBe(false);
      active = false;
      await f.service.settleExecutionTurn(f.workspaceId, "worker", "old", "completed");
      return { accepted: false, error: { code: "execution_readmission_required", message: "Original turn ended" } };
    });
  f.service.setMessageDeliveryPort(async (message) => {
    expect(message.allowStart).toBe(true);
    return { accepted: true, turnId: "new", delivery: "started" };
  });
  await f.service.flushSessionMessages(f.workspaceId);
  const current = await f.service.getWorkItem(f.workspaceId, item.workItemId);
  expect(current.run).toMatchObject({ activeTurnId: "new", control: formal ? "auto" : "manual" });
  expect(current.run.pendingMessageId).toBeUndefined();
});

it.each(["queued", "running", "merging"] as const)("keeps %s business phase through pause and resume", async (phase) => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  if (phase === "running") await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
  let integrationId: string | undefined;
  if (phase === "merging") integrationId = (await f.service.createAction(f.workspaceId, {
    kind: "integration", workItemId: item.workItemId, stage: "merge", status: "pending", message: "merge", integration: { operation: "merge", contractRevision: 0, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }))).actionId;
  await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe(phase);
  expect(await f.service.listOccupiedWorkItems(f.workspaceId)).toEqual([]);
  if (integrationId) {
    await f.service.continueIntegrations(f.workspaceId);
    expect((await f.service.listActions(f.workspaceId)).find((action) => action.actionId === integrationId)?.status).toBe("pending");
  }
  await f.service.resumeWorkItem(f.workspaceId, item.workItemId);
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe(phase);
  if (integrationId) expect((await f.service.listActions(f.workspaceId)).find((action) => action.actionId === integrationId)?.stage).toBe("merge");
});

it("delivers complete Worker context on the first accepted manual message and only increments afterward", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const messages: string[] = [];
  const deliver = async (message: { content: string }) => { messages.push(message.content); return { accepted: true, turnId: "turn-" + messages.length }; };
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "first-manual", content: "continue" }, deliver);
  expect(messages[0]).toContain("workItemId: " + item.workItemId);
  expect(messages[0]).toContain("contractRevision: 0");
  expect(messages[0]).toContain("工作目录: " + f.root);
  await f.service.settleExecutionTurn(f.workspaceId, "worker", "turn-1", "completed");
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "second-manual", content: "next" }, deliver);
  expect(messages[1]).toBe("next");
  await f.service.dispatchSessionMessage({ sessionId: "design", messageId: "discussion", content: "discuss" }, deliver);
  expect(messages[2]).toBe("discuss");
});

it("retains a rejected formal answer until an explicit retry and then records actual acceptance", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const action = (await f.service.listActions(f.workspaceId))[0]!;
  const card = await f.service.createDecision(f.workspaceId, { workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker", question: "Continue?", context: "Choose", options: [{ key: "go", label: "Go" }] });
  const reject = vi.fn(async () => ({ accepted: false, error: { code: "unavailable", message: "Provider unavailable" } }));
  f.service.setMessageDeliveryPort(reject);
  await f.service.answerDecision(f.workspaceId, card.decisionId, { key: "go" });
  await f.service.flushSessionMessages(f.workspaceId);
  expect(reject).toHaveBeenCalledOnce();
  expect((await f.service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(true);
  expect(await f.service.listPendingSessionMessages("worker")).toMatchObject([{ state: "queued", reason: "Provider unavailable" }]);
  const accept = vi.fn(async () => ({ accepted: true, turnId: "answer" })); f.service.setMessageDeliveryPort(accept);
  await f.service.retryWorkItem(f.workspaceId, item.workItemId);
  await f.service.flushSessionMessages(f.workspaceId);
  expect(accept).toHaveBeenCalledOnce();
  expect((await f.service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(false);
});
