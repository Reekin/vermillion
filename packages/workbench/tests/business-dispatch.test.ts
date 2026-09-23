import { afterEach, expect, it, vi } from "vitest";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async () => { const f = await setup(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const delivery = (sessionId: string) => ({
  prepare: vi.fn(async () => ({ sessionId, content: "Continue" })),
  send: vi.fn(async () => ({ accepted: true, turnId: "turn-" + sessionId }))
});

it.each(["capacity", "resource"])("reserves a Worker decision against competing preparation/Worker delivery: %s", async reason => {
  const f = await fixture();
  const entered = deferred(), gate = deferred();
  const service = new WorkbenchService({ ...f.options, sessionSteerer: async ({ sessionId }) => {
    entered.resolve(); await gate.promise; return { sessionId, accepted: true, turnId: "answer-turn" };
  } });
  let answering: Promise<unknown> | undefined;
  try {
    await service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: reason === "capacity" ? 1 : 2 });
    const needs = reason === "resource" ? ["shared:test-project"] : [];
    const a = await service.createWorkItem(f.workspaceId, { ...contract, needs, sessionId: "a" });
    await service.startWorkItem(f.workspaceId, a.workItemId, { sessionId: "a" });
    const card = await service.createDecision(f.workspaceId, { workItemId: a.workItemId, sessionId: "a", question: "Proceed?", context: "Choose", options: [] });
    const b = await service.createWorkItem(f.workspaceId, { ...contract, needs, sessionId: "b" });
    answering = service.answerDecision(f.workspaceId, card.decisionId, { note: "Proceed" });
    await entered.promise;
    const port = delivery("b");
    expect(await service.dispatchBusiness(f.workspaceId, { workItemId: b.workItemId }, port)).toMatchObject({ status: "blocked" });
    expect(port.prepare).not.toHaveBeenCalled();
    if (reason === "capacity") {
      const request = await service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
      expect(await service.dispatchBusiness(f.workspaceId, { requestId: request.requestId }, delivery("prep"))).toMatchObject({ status: "blocked" });
    }
    gate.resolve(); await answering;
    expect((await service.getExecutionOccupancy(f.workspaceId)).sessionIds).toEqual(["a"]);
    await service.settleExecutionTurn(f.workspaceId, "a", "answer-turn", "completed");
    expect(await service.dispatchBusiness(f.workspaceId, { workItemId: b.workItemId }, port)).toMatchObject({ status: "delivered" });
  } finally { gate.resolve(); await answering; await service.dispose(); }
});

it("reserves a cold preparation before a session exists and releases a definite setup failure", async () => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  const b = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "b" });
  const entered = deferred(), gate = deferred();
  const first = f.service.dispatchBusiness(f.workspaceId, { requestId: request.requestId }, {
    prepare: async () => { entered.resolve(); await gate.promise; throw new Error("open failed"); },
    send: vi.fn()
  });
  try {
    await entered.promise;
    expect(await f.service.dispatchBusiness(f.workspaceId, { workItemId: b.workItemId }, delivery("b"))).toMatchObject({ status: "blocked" });
  } finally { gate.resolve(); }
  expect(await first).toMatchObject({ status: "failed", reason: "open failed" });
  expect(await f.service.dispatchBusiness(f.workspaceId, { workItemId: b.workItemId }, delivery("b"))).toMatchObject({ status: "delivered" });
});

it.each(["resume", "rejected"])("does not reinterpret failed notices as another automatic request: %s", async mode => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const action = (await f.service.listActions(f.workspaceId))[0]!;
  await f.service.updateAction(f.workspaceId, action, current => current.kind === "execute" ? { ...current,
    notices: [{ kind: "contract", at: new Date().toISOString(), text: "Changed contract" }] } : current);
  const resume = vi.fn(async () => mode !== "resume");
  const send = vi.fn(async () => ({ accepted: false, error: { code: "denied", message: "denied" } }));
  const runner = { resume, send, isActive: () => false } as unknown as AgentRunner;
  const controller = new Orchestrator({ service: f.service, roles: f.roles, runner });
  const dispatch = controller as unknown as { dispatchItem(workspaceId: string, workItemId: string, explicit?: boolean): Promise<void> };
  try {
    await dispatch.dispatchItem(f.workspaceId, item.workItemId);
    for (let i = 0; i < 3; i++) await dispatch.dispatchItem(f.workspaceId, item.workItemId);
    expect(resume).toHaveBeenCalledTimes(1);
    const reopened = new WorkbenchService(f.options);
    try {
      const port = delivery("worker");
      expect(await reopened.dispatchBusiness(f.workspaceId, { workItemId: item.workItemId }, { ...port, automatic: true })).toMatchObject({ status: "failed" });
      expect(port.prepare).not.toHaveBeenCalled();
      expect(await reopened.dispatchBusiness(f.workspaceId, { workItemId: item.workItemId }, port)).toMatchObject({ status: "delivered" });
      expect(port.send).toHaveBeenCalledOnce();
      expect((await reopened.listActions(f.workspaceId))[0]).toMatchObject({ notices: [] });
    } finally { await reopened.dispose(); }
  } finally { await controller.dispose(); }
});

it("keeps an ambiguous receipt reserved across restart and confirms without replay", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const result = await f.service.dispatchBusiness(f.workspaceId, { workItemId: item.workItemId }, {
    ...delivery("worker"), send: async () => { throw new Error("connection lost"); }
  });
  expect(result.status).toBe("unconfirmed");
  const messageId = (await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.pendingMessageId!;
  const restarted = new WorkbenchService({ ...f.options, deliveryConfirmer: async () => ({ accepted: true, turnId: "accepted-turn" }) });
  try {
    const port = delivery("worker");
    expect(await restarted.dispatchBusiness(f.workspaceId, { workItemId: item.workItemId }, port)).toMatchObject({ status: "delivered" });
    expect(port.send).not.toHaveBeenCalled();
    expect(messageId).toBeTruthy();
    expect((await restarted.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ activeTurnId: "accepted-turn" });
  } finally { await restarted.dispose(); }
});

it("confirmation of an older dispatch cannot acknowledge a new decision answer", async () => {
  const f = await fixture();
  const send = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ sessionId, accepted: true, turnId: "answer-turn" }));
  const service = new WorkbenchService({ ...f.options, sessionSteerer: send,
    deliveryConfirmer: async () => ({ accepted: true, turnId: "old-turn" }) });
  try {
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    const action = (await service.listActions(f.workspaceId))[0]!;
    await service.updateAction(f.workspaceId, action, current => current.kind === "execute" ? { ...current, pendingMessageId: "old-dispatch" } : current);
    const card = await service.createDecision(f.workspaceId, { workItemId: item.workItemId, sessionId: "worker", question: "Proceed?", context: "Choice", options: [] });
    expect(await service.answerDecision(f.workspaceId, card.decisionId, { note: "Proceed" })).toMatchObject({ deliveryPending: true });
    expect(send).not.toHaveBeenCalled();
    await service.refreshActions(f.workspaceId);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ messageId: "decision-" + card.decisionId, content: expect.stringContaining("Proceed") }));
    expect((await service.listDecisions(f.workspaceId))[0]?.deliveryPending).toBe(false);
  } finally { await service.dispose(); }
});

it("an active supervisor cannot bypass a disabled automatic-progression switch through explicit retry", async () => {
  const f = await fixture();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  await f.service.updateWorkRequest(f.workspaceId, request.requestId, current => ({ ...current, supervisor: { sessionId: "supervisor" } }));
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const starter = vi.fn(async () => {});
  f.service.setExecutionStarter(starter);
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  await expect(f.service.retryWorkItem(f.workspaceId, item.workItemId, "supervisor")).rejects.toThrow("自动推进未启用");
  expect(starter).not.toHaveBeenCalled();
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  starter.mockImplementation(async (...args: unknown[]) => {
    expect(args[2]).toBe(true);
    await f.service.observeSessionTurn("worker", "resumed");
  });
  await f.service.retryWorkItem(f.workspaceId, item.workItemId, "supervisor");
  expect(starter).toHaveBeenCalledOnce();
});

it("rechecks automatic eligibility after preparation while leaving explicit user delivery available", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const port = delivery("worker");
  const prepare = async () => {
    await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
    return { sessionId: "worker", content: "Continue" };
  };
  expect(await f.service.dispatchBusiness(f.workspaceId, { workItemId: item.workItemId }, { ...port, prepare, automatic: true })).toMatchObject({ status: "failed" });
  expect(port.send).not.toHaveBeenCalled();
  expect(await f.service.dispatchBusiness(f.workspaceId, { workItemId: item.workItemId }, port)).toMatchObject({ status: "delivered" });
  expect(port.send).toHaveBeenCalledOnce();
});
