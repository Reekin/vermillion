import { expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

it("exposes a work immediately and pauses preparation without losing the request", async () => {
  const f = await setup();
  try {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "turn" });
    expect(request).toMatchObject({ status: "pending", formatVersion: 2 });
    const paused = await f.service.pauseWork(f.workspaceId, request.requestId);
    expect(paused).toMatchObject({ requestId: request.requestId, paused: true, waitReason: "用户已暂停当前工作" });
    expect((await f.service.diagnoseWork(f.workspaceId, request.requestId)).waiting).toContain("用户已暂停当前工作");
    expect(await f.service.resumeWork(f.workspaceId, request.requestId)).toMatchObject({
      requestId: request.requestId, paused: false, status: "pending", dispatchRequested: true
    });
  } finally { await f.cleanup(); }
});

it("explicit preparation retry preserves uncertain delivery until the original receipt is confirmed", async () => {
  const f = await setup();
  try {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "turn" });
    await f.service.failWorkRequest(f.workspaceId, request.requestId, "network timeout");
    expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ status: "failed", failure: "network timeout" });
    const resumed = await f.service.retryWork(f.workspaceId, request.requestId);
    expect(resumed).toMatchObject({ status: "pending", dispatchRequested: true });
    await f.service.updateWorkRequest(f.workspaceId, request.requestId, (current) => ({ ...current, pendingMessageId: "unknown" }));
    await expect(f.service.retryWork(f.workspaceId, request.requestId)).rejects.toThrow("未确认");
  } finally { await f.cleanup(); }
});

it("retains handoff registered concurrently with a whole-work pause", async () => {
  const f = await setup();
  try {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
    await f.service.updateWorkRequest(f.workspaceId, request.requestId, (current) => ({ ...current, status: "preparing", workerSessionId: "prep" }));
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
    release();
    await pausing;
    await f.service.finishPreparation(f.workspaceId, "prep", "end");
    expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ paused: true, status: "ready", handoff: { workItemIds: [item.workItemId], turnId: "end" } });
    await expect(f.service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "prep" })).rejects.toThrow("暂停");
  } finally { await f.cleanup(); }
});

it("keeps a late accepted cancelled business turn occupied until it actually exits", async () => {
  const f = await setup();
  try {
    const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    const action = (await f.service.listActions(f.workspaceId))[0]!;
    await f.service.updateAction(f.workspaceId, action, (current) => ({ ...current, pendingMessageId: "dispatch" }));
    const interrupt = vi.fn(async () => {});
    f.service.setTurnInterrupter(interrupt);
    const release = vi.fn(async () => {});
    f.service.setWorkerEnvironmentReleaser(release);
    await f.service.cancelWorkItem(f.workspaceId, item.workItemId);
    await f.service.releaseIdleWorkers(f.workspaceId);
    expect(release).not.toHaveBeenCalled();
    await f.service.observeSessionTurn("worker", "cancelled-turn", "dispatch");
    expect(interrupt).toHaveBeenCalledWith("worker", "cancelled-turn");
    expect((await f.service.getExecutionOccupancy(f.workspaceId)).sessionIds).toContain("worker");
    await f.service.settleExecutionTurn(f.workspaceId, "worker", "cancelled-turn", "interrupted");
    expect((await f.service.getExecutionOccupancy(f.workspaceId)).sessionIds).toEqual([]);
    await f.service.releaseIdleWorkers(f.workspaceId);
    expect(release).toHaveBeenCalledWith("worker");
  } finally { await f.cleanup(); }
});

it("retains a rejected business answer and delivers it once on explicit resubmission", async () => {
  const f = await setup();
  let available = false;
  const send = vi.fn(async (input: { sessionId: string }) => available
    ? { sessionId: input.sessionId, accepted: true, turnId: "answer" }
    : { sessionId: input.sessionId, accepted: false, error: { code: "unavailable", message: "Provider unavailable" } });
  const service = new WorkbenchService({ ...f.options, sessionSteerer: send });
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    const card = await service.createDecision(f.workspaceId, { workItemId: item.workItemId, sessionId: "worker",
      question: "Continue?", context: "Choose", options: [{ key: "go", label: "Go" }] });
    expect(await service.answerDecision(f.workspaceId, card.decisionId, { key: "go" })).toMatchObject({
      deliveryPending: true, deliveryFailure: "Provider unavailable"
    });
    available = true;
    expect(await service.answerDecision(f.workspaceId, card.decisionId, { key: "go" })).toMatchObject({ deliveryPending: false });
    await service.answerDecision(f.workspaceId, card.decisionId, { key: "go" });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("queued");
  } finally { await service.dispose(); await f.cleanup(); }
});
