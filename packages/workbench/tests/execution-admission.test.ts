import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async () => { const f = await setup(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

it("persists dependency-blocked messages in the execution aggregate, permits design chat, and flushes once after restart", async () => {
  const f = await fixture();
  const a = await f.service.createWorkItem(f.workspaceId, contract);
  const b = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker", dependsOn: [a.workItemId] });
  const deliver = vi.fn(async () => ({ accepted: true, turnId: "turn" }));
  const blocked = await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "continue", content: "continue" }, deliver);
  expect(blocked).toMatchObject({ accepted: false, queued: { messageId: "continue", workItemId: b.workItemId } });
  expect(deliver).not.toHaveBeenCalled();
  expect(await f.client.request("session.messages.pending", { sessionId: "worker" })).toMatchObject([{ blockerWorkItemIds: [a.workItemId] }]);
  await f.service.dispatchSessionMessage({ sessionId: "design", messageId: "discussion", content: "talk" }, deliver);
  expect(deliver).toHaveBeenCalledOnce();
  await f.service.updateWorkItem(f.workspaceId, b.workItemId, { dependsOn: [], note: "Dependency no longer required" });
  const restarted = new WorkbenchService(f.options);
  try {
    restarted.setMessageDeliveryPort(deliver);
    await restarted.flushSessionMessages(f.workspaceId);
    await restarted.flushSessionMessages(f.workspaceId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await restarted.listPendingSessionMessages("worker")).toEqual([]);
    expect((await restarted.getWorkItem(f.workspaceId, b.workItemId)).run).toMatchObject({ control: "manual", activeTurnId: "turn" });
  } finally { await restarted.dispose(); }
});

it("withdraws queued payloads and never delivers them after capacity returns", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId });
  const deliver = vi.fn(async () => ({ accepted: true }));
  f.service.setMessageDeliveryPort(deliver);
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "cancel", content: "continue" });
  expect(await f.client.request("session.messages.cancel", { sessionId: "worker", messageId: "cancel" })).toEqual({ cancelled: true });
  await f.service.resumeWorkItem(f.workspaceId, item.workItemId);
  await f.service.flushSessionMessages(f.workspaceId);
  expect(deliver).not.toHaveBeenCalled();
});

it("queues a new message while the preceding turn settles, then reserves a fresh attempt", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  let settling = true;
  f.service.setWorkerActiveChecker(() => false);
  f.service.setWorkerSettlingChecker(() => settling);
  const deliver = vi.fn(async () => ({ accepted: true, turnId: "next" }));
  f.service.setMessageDeliveryPort(deliver);
  expect(await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "next-message", content: "continue" })).toMatchObject({ accepted: false, queued: { reason: "等待上一轮结算完成" } });
  expect(deliver).not.toHaveBeenCalled();
  settling = false;
  await f.service.flushSessionMessages(f.workspaceId);
  expect(deliver).toHaveBeenCalledOnce();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ attemptId: "next-message", activeTurnId: "next", control: "manual" });
});

it("keeps a concurrent pause when a send acknowledgment arrives late", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  let accept!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { accept = resolve; });
  const sending = f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "late", content: "continue" }, async () => {
    entered(); await gate; return { accepted: true, turnId: "late-turn" };
  });
  await started;
  await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId });
  accept(); await sending;
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ control: "paused" });
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBe("late-turn");
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.pendingMessageId).toBeUndefined();
});

it("preserves preparation pause through explicit handoff and completion", async () => {
  const f = await fixture();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "prep" });
  await f.service.pauseWork(f.workspaceId, request.requestId);
  await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "prep", workItemIds: [] });
  await f.service.finishPreparation(f.workspaceId, "prep", "done");
  expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ control: "paused", status: "ready" });
});

it("records scheduler attribution before engine start and does not adopt an unsolicited event", async () => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "prep" });
  await f.service.dispatchSessionMessage({ sessionId: "prep", messageId: "scheduled", content: "prepare", origin: "scheduler" }, async () => {
    expect(await f.service.observeSessionTurn("prep", "turn", "scheduled")).toBe("scheduler");
    return { accepted: true, turnId: "turn" };
  });
  await f.service.observeSessionTurn("prep", "unexpected", "foreign");
  expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ control: "auto", activeTurnId: "turn" });
});

it("releases a definite refusal and preserves uncertain delivery without automatic resending", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const rejected = await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "rejected", content: "continue" }, async () => ({ accepted: false, error: { code: "denied", message: "denied" } }));
  expect(rejected.error?.code).toBe("denied");
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.pendingMessageId).toBeUndefined();
  await expect(f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "unknown", content: "continue" }, async () => { throw new Error("transport lost"); })).rejects.toThrow("transport lost");
  const deliver = vi.fn(async () => ({ accepted: true }));
  expect(await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "unknown", content: "continue" }, deliver)).toMatchObject({ accepted: false });
  expect(deliver).not.toHaveBeenCalled();
});

it("stops preparation before forking and delivers the preserved summary only with the first new message", async () => {
  const f = await fixture();
  const order: string[] = [];
  const service = new WorkbenchService({ ...f.options, executionTransfer: {
    interrupt: async () => { order.push("interrupt"); },
    fork: async () => { order.push("fork"); return { sessionId: "new-prep" }; }
  } });
  try {
    const request = await service.startWork(f.workspaceId, { sessionId: "design", turnId: "source", scope: "Prepare the feature" });
    await service.putWorkRequest(f.workspaceId, { ...request, workerSessionId: "old-prep", status: "preparing" });
    const moved = await service.continueWorkFrom(f.workspaceId, request.requestId, { sessionId: "old-prep", turnId: "history" });
    expect(order).toEqual(["interrupt", "fork"]);
    expect(moved).toMatchObject({ workerSessionId: "new-prep", control: "manual" });
    const deliver = vi.fn(async () => ({ accepted: true, turnId: "continued" }));
    await service.dispatchSessionMessage({ sessionId: "new-prep", messageId: "continue", content: "continue" }, deliver);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringContaining("Prepare the feature") });
    expect((await service.listWorkRequests(f.workspaceId))[0]?.continuationSummary).toBeUndefined();
    expect((await service.listWorkRequests(f.workspaceId))[0]?.deliveries?.[0]?.content).toBe("");
  } finally { await service.dispose(); }
});

it("rechecks pause after asynchronous execution-role preparation before entering the engine", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  f.service.setExecutionPreparer(async () => { await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId }); });
  const deliver = vi.fn(async () => ({ accepted: true }));
  expect(await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "role-pause", content: "continue" }, deliver)).toMatchObject({ accepted: false, queued: expect.any(Object) });
  expect(deliver).not.toHaveBeenCalled();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.control).toBe("paused");
});

it("preserves handoff registered while whole-work pause is waiting on a child item", async () => {
  const f = await fixture();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "prep" });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "prep" });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pause = f.service.pauseWorkItem.bind(f.service);
  vi.spyOn(f.service, "pauseWorkItem").mockImplementationOnce(async (...args) => { entered(); await gate; return pause(...args); });
  const pausing = f.service.pauseWork(f.workspaceId, request.requestId);
  await started;
  await f.service.completePreparation(f.workspaceId, { requestId: request.requestId, sessionId: "prep", workItemIds: [item.workItemId] });
  release(); await pausing;
  expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ control: "paused", handoff: { workItemIds: [item.workItemId] } });
});
