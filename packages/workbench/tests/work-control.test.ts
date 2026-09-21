import { expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

it("exposes a work immediately and pauses preparation without losing the request", async () => {
  const f = await setup();
  try {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "turn" });
    expect(request).toMatchObject({ status: "pending", control: "auto" });
    const paused = await f.service.pauseWork(f.workspaceId, request.requestId);
    expect(paused).toMatchObject({ requestId: request.requestId, control: "paused", waitReason: "用户已暂停当前工作" });
    const diagnosed = await f.service.diagnoseWork(f.workspaceId, request.requestId);
    expect(diagnosed.waiting).toContain("用户已暂停当前工作");
    const resumed = await f.service.resumeWork(f.workspaceId, request.requestId);
    expect(resumed).toMatchObject({ requestId: request.requestId, control: "auto", status: "pending" });
  } finally { await f.cleanup(); }
});

it("requires explicit preparation handoff before releasing prepared items", async () => {
  const f = await setup();
  try {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "turn" });
    await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "prep", treeId: "tree" });
    const item = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "prep" });
    await f.service.finishPreparation(f.workspaceId, "prep", "prep-turn");
    expect(await f.service.getWorkItem(f.workspaceId, item.workItemId)).toMatchObject({ status: "preparing" });
    await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "prep", workItemIds: [item.workItemId] });
    await f.service.finishPreparation(f.workspaceId, "prep", "prep-turn");
    expect(await f.service.getWorkItem(f.workspaceId, item.workItemId)).toMatchObject({ status: "queued" });
    expect(await f.service.listWorkRequests(f.workspaceId)).toEqual([expect.objectContaining({ status: "ready", handoff: expect.any(Object) })]);
  } finally { await f.cleanup(); }
});

it("allows an explicit retry during preparation backoff without accepting unknown delivery", async () => {
  const f = await setup();
  try {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "turn" });
    await f.service.failWorkRequest(f.workspaceId, request.requestId, "network timeout");
    expect((await f.service.listWorkRequests(f.workspaceId))[0]?.retryAt).toBeDefined();
    const resumed = await f.service.retryWork(f.workspaceId, request.requestId);
    expect(resumed).toMatchObject({ status: "pending", control: "auto", attempts: 0 });
    expect(resumed.retryAt).toBeUndefined();
    await f.service.putWorkRequest(f.workspaceId, { ...resumed, retryAt: new Date().toISOString(), pendingMessageId: "unknown" });
    await expect(f.service.retryWork(f.workspaceId, request.requestId)).rejects.toThrow("work.confirm");
  } finally { await f.cleanup(); }
});

it("turns a queued retry into manual execution and clears the old retry deadline", async () => {
  const f = await setup();
  try {
    const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    await f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
    const action = (await f.service.listActions(f.workspaceId))[0]!;
    await f.service.failAction(f.workspaceId, action.actionId, "temporary runtime failure");
    expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.retryAt).toEqual(expect.any(String));
    await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "manual", content: "continue" }, async () => ({ accepted: true, turnId: "user-turn" }));
    const current = await f.service.getWorkItem(f.workspaceId, item.workItemId);
    expect(current).toMatchObject({ status: "running", run: { control: "manual", activeTurnId: "user-turn" } });
    expect(current.run.retryAt).toBeUndefined();
  } finally { await f.cleanup(); }
});

it("keeps operational failures out of business decision cards after recovery is exhausted", async () => {
  const f = await setup();
  try {
    const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    await f.service.refreshActions(f.workspaceId);
    const action = (await f.service.listActions(f.workspaceId))[0]!;
    for (let attempt = 0; attempt < 5; attempt++) await f.service.failAction(f.workspaceId, action.actionId, "429 Too Many Requests");
    expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.waitReason).toContain("次数");
    expect(await f.service.listDecisions(f.workspaceId)).toEqual([]);
  } finally { await f.cleanup(); }
});

it("transfers a work item through the execution port and leaves the old session revoked", async () => {
  const f = await setup();
  try {
    const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "old-worker" });
    const interrupt = vi.fn(async () => {});
    const fork = vi.fn(async () => ({ sessionId: "new-worker", treeId: "tree" }));
    const service = new WorkbenchService({ ...f.options, executionTransfer: { interrupt, fork } });
    const moved = await service.continueWorkItemFrom(f.workspaceId, item.workItemId, { sessionId: "history-session", turnId: "history-turn" });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "history-session", sourceTurnId: "history-turn" }));
    expect(interrupt).toHaveBeenCalledWith("old-worker");
    expect(moved).toMatchObject({ status: "queued", run: { sessionId: "new-worker", control: "manual", migratedFromSessionId: "old-worker" } });
    await service.dispose();
  } finally { await f.cleanup(); }
});

it("delivers a business decision directly through a manually owned session", async () => {
  const f = await setup();
  const delivered: Array<{ sessionId: string; content: string; messageId?: string }> = [];
  const service = new WorkbenchService({ ...f.options, sessionSteerer: async (input) => {
    delivered.push(input);
    return { sessionId: input.sessionId, turnId: "manual-decision-turn", delivery: "started" };
  } });
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    await service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
    await service.dispatchSessionMessage({ sessionId: "worker", messageId: "manual", content: "continue" }, async () => ({ accepted: true, turnId: "manual-turn" }));
    const action = (await service.listActions(f.workspaceId))[0]!;
    const card = await service.createDecision(f.workspaceId, { workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker", kind: "worker",
      question: "Continue?", context: "A business choice is required.", options: [{ key: "go", label: "Continue" }] });
    await service.answerDecision(f.workspaceId, card.decisionId, { key: "go" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sessionId: "worker", messageId: "decision-" + card.decisionId });
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run.control).toBe("manual");
  } finally { await service.dispose(); await f.cleanup(); }
});
