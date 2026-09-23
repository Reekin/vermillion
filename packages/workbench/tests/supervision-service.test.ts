import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup, submission } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const services: WorkbenchService[] = [];
const fixture = async () => { const f = await setup(); fixtures.push(f); return f; };
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

it("ordinary messages and turn facts do not move business phases or erase unrelated dispatch receipts", async () => {
  const f = await fixture();
  const send = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ sessionId, accepted: true, turnId: "chat" }));
  const service = new WorkbenchService({ ...f.options, sessionSteerer: send });
  services.push(service);
  const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
  const action = (await service.listActions(f.workspaceId))[0]!;
  await service.updateAction(f.workspaceId, action, (current) => ({ ...current, pendingMessageId: "dispatch" }));
  await service.steerSession("worker", "What is the current plan?");
  await service.observeSessionTurn("worker", "chat", "ordinary");
  expect(await service.getWorkItem(f.workspaceId, item.workItemId)).toMatchObject({ status: "queued", run: { activeTurnId: "chat", pendingMessageId: "dispatch" } });
  await service.settleExecutionTurn(f.workspaceId, "worker", "chat", "interrupted");
  expect(await service.getWorkItem(f.workspaceId, item.workItemId)).toMatchObject({ status: "queued", run: { userStopped: true, pendingMessageId: "dispatch" } });
  await service.observeSessionTurn("worker", "next", "dispatch");
  expect((await service.getWorkItem(f.workspaceId, item.workItemId)).run.pendingMessageId).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});

it("turn completion records failure without requeueing, notices, or retry scheduling", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.observeSessionTurn("worker", "turn");
  await service.settleExecutionTurn(workspaceId, "worker", "turn", "failed", "engine unavailable");
  await service.refreshActions(workspaceId);
  expect(await service.getWorkItem(workspaceId, item.workItemId)).toMatchObject({ status: "running", run: { lastFailure: "engine unavailable" } });
  expect((await service.getWorkItem(workspaceId, item.workItemId)).run.activeTurnId).toBeUndefined();
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ status: "decision", notices: [] });
  expect(await service.listDecisions(workspaceId)).toEqual([]);
});

it("complete preparation hands off the actual ending turn and eligibility for one supervisor", async () => {
  const { service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "source" });
  await service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, status: "preparing", workerSessionId: "prep", activeTurnId: "preparation" }));
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "prep", requestId: request.requestId });
  await service.completePreparation(workspaceId, { requestId: request.requestId, sessionId: "prep", workItemIds: [item.workItemId] });
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("preparing");
  await service.settleExecutionTurn(workspaceId, "prep", "preparation", "completed");
  expect((await service.listWorkRequests(workspaceId))[0]).toMatchObject({ formatVersion: 2, status: "ready", handoff: { turnId: "preparation" }, supervisor: {} });
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("queued");
});

it("cancelled preparation retains capacity until its real turn ends", async () => {
  const { service, workspaceId } = await fixture();
  await service.setScheduler(workspaceId, { enabled: true, maxWorkers: 1 });
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "source" });
  await service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, status: "preparing", workerSessionId: "prep", activeTurnId: "preparation" }));
  await service.cancelWorkRequest(workspaceId, { requestId: request.requestId });
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await expect(service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" })).rejects.toThrow("并发");
  await service.settleExecutionTurn(workspaceId, "prep", "preparation", "interrupted");
  await expect(service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" })).resolves.toMatchObject({ status: "running" });
});

it("a supervisor cannot undo a user stop, while user retry dispatches outside the integration lock", async () => {
  const { service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "source" });
  await service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, status: "ready", handoff: { sessionId: "prep", turnId: "prep-end", workItemIds: [], refs: [], at: current.createdAt }, supervisor: { sessionId: "supervisor" } }));
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.observeSessionTurn("worker", "first");
  await service.settleExecutionTurn(workspaceId, "worker", "first", "interrupted");
  const starter = vi.fn(async () => {
    await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
    await service.observeSessionTurn("worker", "second");
  });
  service.setExecutionStarter(starter);
  await expect(service.retryWorkItem(workspaceId, item.workItemId, "supervisor")).rejects.toThrow("监工");
  await expect(service.retryWorkItem(workspaceId, item.workItemId, "user")).resolves.toMatchObject({ run: { activeTurnId: "second", userStopped: false } });
  await service.retryWorkItem(workspaceId, item.workItemId, "user");
  expect(starter).toHaveBeenCalledTimes(1);
});

it("an unrelated fork cannot claim or submit another Worker's task", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await expect(service.startWorkItem(workspaceId, item.workItemId, { sessionId: "fork" })).rejects.toThrow("固定");
});

it.each(["runtime", "observed"] as const)("claims queued work in an already active fixed session (%s) without starting another turn", async (activity) => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  const starter = vi.fn(async () => {});
  service.setExecutionStarter(starter);
  if (activity === "runtime") service.setWorkerActiveChecker((sessionId) => sessionId === "worker");
  else await service.observeSessionTurn("worker", "existing-turn");
  const claimed = await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  expect(claimed.status).toBe("running");
  expect(claimed.run.activeTurnId).toBe(activity === "observed" ? "existing-turn" : undefined);
  expect(await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" })).toMatchObject({ status: "running", updatedAt: claimed.updatedAt });
  expect(starter).not.toHaveBeenCalled();
  await expect(service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: "worker" })).resolves.toMatchObject({ status: "closed" });
});

it("preparation decisions actually reach preparation and ambiguous delivery is reconciled without resending", async () => {
  const f = await fixture();
  let accepted = false;
  const send = vi.fn(async () => { throw new Error("connection lost"); });
  const service = new WorkbenchService({ ...f.options, sessionSteerer: send,
    deliveryConfirmer: async () => ({ accepted, turnId: "answer-turn", active: true }) });
  services.push(service);
  const request = await service.startWork(f.workspaceId, { sessionId: "design", turnId: "source" });
  await service.updateWorkRequest(f.workspaceId, request.requestId, (current) => ({ ...current, status: "preparing", workerSessionId: "prep" }));
  const card = await service.createDecision(f.workspaceId, { requestId: request.requestId, sessionId: "prep", question: "Which scope?", context: "Need a choice", options: [] });
  const first = await service.answerDecision(f.workspaceId, card.decisionId, { note: "Use the narrow scope" });
  expect(first).toMatchObject({ deliveryPending: true, deliveryFailure: "connection lost", messageId: "decision-" + card.decisionId });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "prep", content: expect.stringContaining("Use the narrow scope") }));
  accepted = true;
  const confirmed = await service.answerDecision(f.workspaceId, card.decisionId, { note: "Use the narrow scope" });
  expect(confirmed.deliveryPending).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await service.listWorkRequests(f.workspaceId))[0]?.activeTurnId).toBe("answer-turn");
});

it("failed explicit dispatch returns the actual failure and does not leave an automatic retry", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  service.setExecutionStarter(async () => { throw new Error("host disconnected"); });
  await expect(service.retryWorkItem(workspaceId, item.workItemId)).rejects.toThrow("host disconnected");
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ status: "decision", failure: "host disconnected" });
});

it("handoff is required before preparation completion opens any task", async () => {
  const { service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "source" });
  expect(request.dispatchRequested).toBeUndefined();
  await service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, status: "preparing", workerSessionId: "prep", activeTurnId: "prep-turn" }));
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "prep", requestId: request.requestId });
  await service.settleExecutionTurn(workspaceId, "prep", "prep-turn", "completed");
  expect((await service.listWorkRequests(workspaceId))[0]).toMatchObject({ status: "preparing", dispatchRequested: false });
  expect((await service.listWorkRequests(workspaceId))[0]?.supervisor).toBeUndefined();
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("preparing");
});

it("integration takeover delivers while the original Worker is still active and preserves the merge phase", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.observeSessionTurn("worker", "turn");
  await service.createAction(workspaceId, { kind: "integration", workItemId: item.workItemId, status: "decision", stage: "merge", message: "Integrate result", failure: "conflict", integration: { operation: "merge", contractRevision: 0, diffStat: "" } }, (current) => ({ ...current, status: "merging" }));
  const starter = vi.fn(async () => {
    const action = (await service.listActions(workspaceId)).find((entry) => entry.kind === "execute")!;
    expect(action.kind === "execute" && action.notices.some((notice) => notice.text.includes("conflict"))).toBe(true);
    await service.updateAction(workspaceId, action, (current) => current.kind === "execute" ? { ...current, notices: [] } : current);
  });
  service.setExecutionStarter(starter);
  expect(await service.takeoverIntegration(workspaceId, item.workItemId, "Resolve the conflict")).toMatchObject({ status: "merging", run: { activeTurnId: "turn" } });
  expect(starter).toHaveBeenCalledTimes(1);
});

it("session reading is a read-only port with an explicit offline failure", async () => {
  const f = await fixture();
  await expect(f.service.readSession({ sessionId: "worker" })).rejects.toThrow("桌面");
  const reader = vi.fn(async () => ({ messages: [], activity: { state: "unknown" } }));
  const service = new WorkbenchService({ ...f.options, sessionReader: reader });
  services.push(service);
  expect(await service.readSession({ sessionId: "worker", limit: 10, maxChars: 500 })).toMatchObject({ activity: { state: "unknown" } });
  expect(reader).toHaveBeenCalledWith({ sessionId: "worker", limit: 10, maxChars: 500 });
});
