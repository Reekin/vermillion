import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async () => { const f = await setup(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

it("carries an append-only grant through nested shell dispatch and rechecks dependency before any new turn", async () => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  const dependency = await f.service.createWorkItem(f.workspaceId, contract);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "initial", content: "work", origin: "scheduler" }, async () => ({ accepted: true, turnId: "old" }));
  let active = true;
  f.service.setWorkerActiveChecker(() => active);
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker", dependsOn: [dependency.workItemId], note: "Wait after this turn" });
  const input = { sessionId: "worker", messageId: "append", content: "continue", allowStart: true };
  const receipt = await f.service.dispatchSessionMessage(input, async (outer) => {
    expect(outer.allowStart).toBe(false);
    return f.service.dispatchSessionMessage(input, async (inner) => {
      expect(inner.allowStart).toBe(false);
      active = false;
      await f.service.settleExecutionTurn(f.workspaceId, "worker", "old", "completed");
      return { accepted: false, error: { code: "execution_readmission_required", message: "Original turn ended" } };
    });
  });
  expect(receipt).toMatchObject({ accepted: false, queued: { messageId: "append" } });
  const deliver = vi.fn(async (message) => {
    expect(message.allowStart).toBe(true);
    expect(message.messageId).toBe("append");
    return { accepted: true, turnId: "new" };
  });
  f.service.setMessageDeliveryPort(deliver);
  await f.service.flushSessionMessages(f.workspaceId);
  expect(deliver).not.toHaveBeenCalled();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ control: "auto", attempts: 0 });
  expect(await f.service.listPendingSessionMessages("worker")).toMatchObject([{ messageId: "append", state: "queued", blockerWorkItemIds: [dependency.workItemId] }]);
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { dependsOn: [], note: "Dependency resolved" });
  await f.service.flushSessionMessages(f.workspaceId);
  expect(deliver).toHaveBeenCalledOnce();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ control: "manual", activeTurnId: "new" });
});

it.each(["worker", "preparation"] as const)("confirms a %s message after a send-window restart without requiring the catch flag", async (target) => {
  const f = await fixture();
  let targetId: string;
  if (target === "worker") targetId = (await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "session" })).workItemId;
  else {
    const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" }); targetId = request.requestId;
    await f.service.putWorkRequest(f.workspaceId, { ...request, status: "preparing", workerSessionId: "session" });
  }
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const flight = f.service.dispatchSessionMessage({ sessionId: "session", messageId: "crash-window", content: "work" }, async () => {
    enter(); await gate; return { accepted: true, turnId: "engine-turn" };
  });
  await entered;
  const restarted = new WorkbenchService({ ...f.options, deliveryConfirmer: async () => ({ accepted: true, active: true, turnId: "engine-turn" }) });
  try {
    expect(await restarted.listPendingSessionMessages("session")).toMatchObject([{ state: "unknown", messageId: "crash-window" }]);
    const confirm = async () => target === "worker" ? (await restarted.confirmWorkItemDelivery(f.workspaceId, targetId)).run : restarted.confirmWorkRequestDelivery(f.workspaceId, targetId);
    const confirmed = await confirm(); await confirm();
    expect(confirmed.pendingMessageId).toBeUndefined();
    expect(confirmed.activeTurnId).toBe("engine-turn");
    expect(await restarted.listPendingSessionMessages("session")).toEqual([]);
    restarted.setWorkerActiveChecker(() => true);
    const delivered = vi.fn(async () => ({ accepted: true, turnId: "engine-turn", delivery: "steered" as const }));
    expect(await restarted.dispatchSessionMessage({ sessionId: "session", messageId: "next", content: "extra" }, delivered)).toMatchObject({ accepted: true });
    expect(delivered).toHaveBeenCalledOnce();
  } finally { release(); await flight; await restarted.dispose(); }
});

it.each(["auto", "manual"] as const)("respects the global switch for a formal %s decision", async (control) => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  await f.service.dispatchSessionMessage({ sessionId: "worker", messageId: "initial", content: "work", origin: control === "auto" ? "scheduler" : "user" }, async () => ({ accepted: true, turnId: "original" }));
  const action = (await f.service.listActions(f.workspaceId))[0]!;
  const card = await f.service.createDecision(f.workspaceId, { workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker", question: "Proceed?", context: "Choose", options: [{ key: "go", label: "Go" }] });
  await f.service.settleExecutionTurn(f.workspaceId, "worker", "original", "completed");
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  const deliver = vi.fn(async () => ({ accepted: true, turnId: "answer-turn" })); f.service.setMessageDeliveryPort(deliver);
  const result = await f.service.answerDecision(f.workspaceId, card.decisionId, { key: "go" });
  expect(result.deliveryPending).toBe(control === "auto");
  expect(deliver).toHaveBeenCalledTimes(control === "auto" ? 0 : 1);
  if (control === "auto") {
    await f.service.flushSessionMessages(f.workspaceId); expect(deliver).not.toHaveBeenCalled();
    await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
    await f.service.flushSessionMessages(f.workspaceId); expect(deliver).toHaveBeenCalledOnce();
  }
  expect((await f.service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(false);
});

it("settles a late accepted cancelled send and stops only its exact turn before releasing the old execution", async () => {
  const f = await fixture();
  let currentSessionTurn: string | undefined;
  const interrupt = vi.fn(async (sessionId: string, turnId?: string) => {
    expect(sessionId).toBe("worker");
    expect(turnId).toBe("cancelled-turn");
    if (currentSessionTurn === turnId) currentSessionTurn = undefined;
  });
  const service = new WorkbenchService({ ...f.options, executionTransfer: { interrupt, fork: async () => ({ sessionId: "unused" }) } });
  service.setWorkerActiveChecker(() => !!currentSessionTurn);
  const releaseEnvironment = vi.fn(async () => {}); service.setWorkerEnvironmentReleaser(releaseEnvironment);
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    let enter!: () => void; let accept!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { accept = resolve; });
    const sending = service.dispatchSessionMessage({ sessionId: "worker", messageId: "late-cancel", content: "work" }, async () => {
      enter(); await gate; return { accepted: true, turnId: "cancelled-turn" };
    });
    await entered;
    await service.cancelWorkItem(f.workspaceId, item.workItemId);
    await service.releaseIdleWorkers(f.workspaceId);
    expect(releaseEnvironment).not.toHaveBeenCalled();
    currentSessionTurn = "later-discussion";
    accept(); await sending;
    expect(interrupt).toHaveBeenCalledExactlyOnceWith("worker", "cancelled-turn");
    expect(currentSessionTurn).toBe("later-discussion");
    expect(await service.getWorkItem(f.workspaceId, item.workItemId)).toMatchObject({ status: "cancelled", run: { activeTurnId: "cancelled-turn" } });
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run.pendingMessageId).toBeUndefined();
    expect((await service.listActions(f.workspaceId))[0]).toMatchObject({ deliveries: [expect.objectContaining({ messageId: "late-cancel", state: "accepted", turnId: "cancelled-turn" })] });
    await service.releaseIdleWorkers(f.workspaceId);
    expect(releaseEnvironment).not.toHaveBeenCalled();
    await service.settleExecutionTurn(f.workspaceId, "worker", "cancelled-turn", "interrupted");
    expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined();
    expect((await service.getExecutionOccupancy(f.workspaceId)).sessionIds).toEqual([]);
    expect(currentSessionTurn).toBe("later-discussion");
    currentSessionTurn = undefined;
    await service.releaseIdleWorkers(f.workspaceId);
    expect(releaseEnvironment).toHaveBeenCalledExactlyOnceWith("worker");
  } finally { await service.dispose(); }
});

it("expires a delivery grant before an inherited asynchronous callback can reuse it", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const nestedDeliver = vi.fn(async () => ({ accepted: true, turnId: "unauthorized" }));
  let deferred!: Promise<unknown>;
  const input = { sessionId: "worker", messageId: "one-shot", content: "work" };
  await f.service.dispatchSessionMessage(input, async () => {
    deferred = (async () => {
      await gate;
      return f.service.dispatchSessionMessage(input, nestedDeliver);
    })();
    return { accepted: true, turnId: "original" };
  });
  await f.service.pauseWorkItem(f.workspaceId, { workItemId: item.workItemId });
  release();
  expect(await deferred).toMatchObject({ accepted: true, turnId: "original" });
  expect(nestedDeliver).not.toHaveBeenCalled();
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ control: "paused", activeTurnId: "original" });
});
