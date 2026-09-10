import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace-store.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { workbenchRpc } from "../src/rpc.js";
import { contract, setup, submission } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async (now?: () => string) => { const f = await setup(now); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

it("keeps requests and every prepared item durable without dispatch until the preparation turn ends", async () => {
  const { service, options, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "design-turn", scope: "ABC" });
  await service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: "prep", treeId: "tree" });
  const first = await service.createWorkItem(workspaceId, { ...contract, requestId: request.requestId, sessionId: "prep" });
  const next = await service.createWorkItem(workspaceId, { ...contract, requestId: request.requestId, dependsOn: [first.workItemId] });
  await service.refreshActions(workspaceId);
  expect(await service.listActions(workspaceId)).toMatchObject([
    { kind: "execute", workItemId: first.workItemId, stage: "open" },
    { kind: "execute", workItemId: next.workItemId, stage: "open" }
  ]);
  await expect(service.startWorkItem(workspaceId, first.workItemId, { sessionId: "prep" })).rejects.toThrow();
  const restarted = new WorkbenchService(options);
  try {
    expect(await restarted.listWorkRequests(workspaceId)).toMatchObject([{ sourceTurnId: "design-turn", scope: "ABC" }]);
    await restarted.finishPreparation(workspaceId, "prep", "prep-end");
    expect(await restarted.getWorkItem(workspaceId, first.workItemId)).toMatchObject({ status: "queued", sourceSessionId: "design", treeId: "tree", run: { sessionId: "prep" } });
    expect(await restarted.getWorkItem(workspaceId, next.workItemId)).toMatchObject({ status: "queued", run: { forkSessionId: "prep", forkTurnId: "prep-end" } });
  } finally { await restarted.dispose(); }
});

it("registers optional isolation separately from allowedPaths and rejects generic resource pools", async () => {
  const { service, client, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, scope: { ...contract.scope, allowedPaths: ["src/"] } });
  expect(item.run.worktreePath).toBeUndefined();
  const updated = await client.request("workItem.update", { workspaceId, workItemId: item.workItemId, note: "Isolated execution", worktreePath: "C:/qa/work", branch: "work/result" });
  expect(updated.run).toMatchObject({ worktreePath: "C:/qa/work", branch: "work/result" });
  await expect(service.createWorkItem(workspaceId, { ...contract, needs: ["browser"] })).rejects.toThrow("具体");
  await expect(service.updateWorkItem(workspaceId, item.workItemId, { note: "invalid", needs: ["desktop"] })).rejects.toThrow("具体");
});

it("retains the preparation session through failure backoff and exposes exhausted recovery in Inbox", async () => {
  const { service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "source", turnId: "turn" });
  await service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: "preparing-worker" });
  for (let attempt = 0; attempt < 5; attempt++) await service.failWorkRequest(workspaceId, request.requestId, "preparation failed");
  expect((await service.listWorkRequests(workspaceId))[0]).toMatchObject({ status: "failed", attempts: 5, workerSessionId: "preparing-worker" });
  const card = (await service.listDecisions(workspaceId))[0]!;
  expect(card.requestId).toBe(request.requestId);
  await expect(service.answerDecision(workspaceId, card.decisionId, { note: "继续" })).rejects.toThrow("请选择重试或取消");
  await expect(service.answerDecision(workspaceId, card.decisionId, { key: "retry", note: "继续" })).rejects.toThrow("不接受备注答复");
  expect((await service.listDecisions(workspaceId))[0]!.answer).toBeUndefined();
  expect(await service.listInbox()).toMatchObject([{ kind: "decision", card: { requestId: request.requestId } }]);
  await service.answerDecision(workspaceId, card.decisionId, { key: "retry" });
  expect((await service.listWorkRequests(workspaceId))[0]).toMatchObject({ status: "preparing", attempts: 0, workerSessionId: "preparing-worker" });
});

it("enforces dependency cycles, concrete shared resource slots, and cancellation decisions", async () => {
  const { service, workspaceId } = await fixture();
  const first = await service.createWorkItem(workspaceId, { ...contract, needs: ["browser:qa"] });
  const second = await service.createWorkItem(workspaceId, { ...contract, needs: ["browser:qa"] });
  await service.startWorkItem(workspaceId, first.workItemId, { sessionId: "one" });
  await expect(service.startWorkItem(workspaceId, second.workItemId, { sessionId: "two" })).rejects.toThrow("资源");
  await service.updateWorkItem(workspaceId, second.workItemId, { note: "depends", dependsOn: [first.workItemId] });
  await expect(service.updateWorkItem(workspaceId, first.workItemId, { note: "cycle", dependsOn: [second.workItemId] })).rejects.toThrow();
  await service.cancelWorkItem(workspaceId, first.workItemId);
  await service.refreshActions(workspaceId);
  expect(await service.getWorkItem(workspaceId, second.workItemId)).toMatchObject({ status: "decision" });
  const card = (await service.listDecisions(workspaceId))[0]!;
  await service.answerDecision(workspaceId, card.decisionId, { key: "cancel" });
  expect((await service.getWorkItem(workspaceId, second.workItemId)).status).toBe("cancelled");
});

it("persists 1/5/30/300 minute retry deadlines and the fifth-failure decision in the original session", async () => {
  let now = Date.parse("2026-09-09T00:00:00Z");
  const { service, workspaceId } = await fixture(() => new Date(now).toISOString());
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "original" });
  await service.refreshActions(workspaceId);
  const action = (await service.listActions(workspaceId))[0]!;
  for (const [index, minutes] of [1, 5, 30, 300].entries()) {
    const failed = await service.failAction(workspaceId, action.actionId, "failure " + index);
    expect(failed).toMatchObject({ attempts: index + 1, status: "retry", sessionId: "original", retryAt: new Date(now + minutes * 60_000).toISOString() });
    now += minutes * 60_000;
  }
  await service.failAction(workspaceId, action.actionId, "failure five");
  const card = (await service.listDecisions(workspaceId))[0]!;
  expect(card.details).toContain("failure five");
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("decision");
  await service.answerDecision(workspaceId, card.decisionId, { key: "retry" });
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ attempts: 0, sessionId: "original", status: "pending" });
});

it("persists a user pause separately from failure decisions and resumes the same work item", async () => {
  const { client, options, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });

  const paused = await client.request("workItem.pause", { workspaceId, sessionId: "worker" });
  expect(paused).toMatchObject({ paused: true, workItem: { status: "decision", run: { sessionId: "worker", pauseReason: "user", attempts: 0 } } });
  expect(await service.listDecisions(workspaceId)).toEqual([]);
  expect(await service.diagnoseWorkItem(workspaceId, item.workItemId)).toMatchObject({
    waiting: expect.arrayContaining(["用户已暂停 Worker"]),
    availableActions: expect.arrayContaining([expect.objectContaining({ method: "workItem.resume" })])
  });

  const restarted = new WorkbenchService(options);
  try {
    expect(await restarted.getWorkItem(workspaceId, item.workItemId)).toMatchObject({ status: "decision", run: { pauseReason: "user" } });
    const resumed = await restarted.resumeWorkItem(workspaceId, item.workItemId);
    expect(resumed).toMatchObject({ status: "queued", run: { sessionId: "worker" } });
    expect(resumed.run.pauseReason).toBeUndefined();
    expect((await restarted.listActions(workspaceId))[0]).toMatchObject({ status: "pending", stage: "deliver" });
  } finally { await restarted.dispose(); }
});

it("bounds verifier rejection independently of runtime failures and resumes after user retry", async () => {
  const { service, options, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  for (let index = 0; index < 2; index++) {
    await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
    await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, verify: { verdict: "rework", items: [{ index: 0, pass: false, evidence: "Result absent" }] } });
  }
  const restarted = new WorkbenchService(options);
  try {
    expect(await restarted.getWorkItem(workspaceId, item.workItemId)).toMatchObject({ status: "decision", verificationFailures: 2, run: { sessionId: "worker" } });
    const card = (await restarted.listDecisions(workspaceId))[0]!;
    await restarted.answerDecision(workspaceId, card.decisionId, { key: "retry" });
    expect(await restarted.getWorkItem(workspaceId, item.workItemId)).toMatchObject({ status: "queued", verificationFailures: 0 });
  } finally { await restarted.dispose(); }
});

it("rejects unsupported historical state before dispatch and leaves every historical file unchanged", async () => {
  const { root, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, contract);
  const path = join(root, ".vermillion", "workitems", item.workItemId + ".json");
  const raw = JSON.stringify({ ...item, missionId: "historical", contractIssue: { message: "old", at: "then" } });
  await writeFile(path, raw);
  await mkdir(join(root, ".vermillion", "missions"));
  const missionPath = join(root, ".vermillion", "missions", "old.json");
  await writeFile(missionPath, '{"historical":true}');
  await expect(new WorkspaceStore(root).listRecords()).rejects.toThrow("Unsupported or invalid workbench record");
  await expect(service.refreshActions(workspaceId)).rejects.toThrow("Convert stored data explicitly");
  expect(await readFile(path, "utf8")).toBe(raw);
  expect(await readFile(missionPath, "utf8")).toBe('{"historical":true}');
});

it("blocks preparation at workspace load when separate action history requires conversion", async () => {
  const { root, service, options, workspaceId } = await fixture();
  await service.startWork(workspaceId, { sessionId: "design", turnId: "source" });
  const actionsDir = join(root, ".vermillion", "actions");
  await mkdir(actionsDir);
  const path = join(actionsDir, "historical.json");
  const raw = JSON.stringify({ actionId: "historical", status: "running", sessionId: "original" });
  await writeFile(path, raw);
  const restarted = new WorkbenchService(options);
  try {
    await expect(restarted.listWorkRequests(workspaceId)).rejects.toThrow("Unsupported separate action records");
    expect(await readFile(path, "utf8")).toBe(raw);
  } finally { await restarted.dispose(); }
});

it("persists runtime only in Execution and preserves concurrent contract, heartbeat and delivery changes", async () => {
  const { root, service, options, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "original" });
  const execution = (await service.listActions(workspaceId))[0]!;
  if (execution.kind !== "execute") throw new Error("Expected execution");
  await Promise.all([
    service.updateWorkItem(workspaceId, item.workItemId, { title: "Adjusted", note: "Read updated contract" }),
    service.heartbeatWorkItem(workspaceId, item.workItemId, "latest-turn"),
    service.updateAction(workspaceId, execution, (current) => ({ ...current, stage: "deliver" }))
  ]);
  await service.failAction(workspaceId, execution.actionId, "model unavailable");
  const path = join(root, ".vermillion", "workitems", item.workItemId + ".json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  expect(stored.item).toMatchObject({ title: "Adjusted", status: "queued" });
  expect(stored.item).not.toHaveProperty("run");
  expect(stored.execution).toMatchObject({ sessionId: "original", lastTurnId: "latest-turn", attempts: 1, failure: "model unavailable", stage: "deliver" });
  expect(stored.execution.message).toContain("Read updated contract");
  expect(stored.execution).not.toHaveProperty("resumeMessage");
  expect(stored.execution).not.toHaveProperty("lastFailure");
  const restarted = new WorkbenchService(options);
  try {
    const projected = await restarted.getWorkItem(workspaceId, item.workItemId);
    expect(projected.run).toMatchObject({ sessionId: "original", lastTurnId: "latest-turn", attempts: 1, lastFailure: "model unavailable", retryAt: stored.execution.retryAt });
    expect(projected.run.resumeMessage).toBe(stored.execution.message);
    const decision = await restarted.createDecision(workspaceId, { workItemId: item.workItemId, question: "Continue?", context: "Retry", options: [{ key: "retry", label: "Retry" }] });
    await restarted.answerDecision(workspaceId, decision.decisionId, { key: "retry" });
    expect((await restarted.getWorkItem(workspaceId, item.workItemId)).run).toMatchObject({ attempts: 0 });
    expect((await restarted.getWorkItem(workspaceId, item.workItemId)).run.lastFailure).toBeUndefined();
    expect((await restarted.listActions(workspaceId))[0]!.actionId).toBe(execution.actionId);
  } finally { await restarted.dispose(); }
});

it("publishes merging and its sole integration atomically while event-driven refresh runs", async () => {
  const { root, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  service.setWorkerActiveChecker(() => true);
  const pending: Promise<void>[] = [];
  const observed: Array<{ status: string; integrations: number }> = [];
  const unsubscribe = service.subscribe((event) => {
    if (event.type !== "workItems.changed") return;
    pending.push((async () => {
      const stored = JSON.parse(await readFile(join(root, ".vermillion", "workitems", item.workItemId + ".json"), "utf8"));
      observed.push({ status: stored.item.status, integrations: stored.integrations.length });
      await service.refreshActions(workspaceId);
    })());
  });
  try {
    expect((await service.submitWorkItem(workspaceId, item.workItemId, submission)).status).toBe("closed");
    while (pending.length) await Promise.all(pending.splice(0));
    expect(observed.some((entry) => entry.status === "merging")).toBe(true);
    expect(observed.filter((entry) => entry.status === "merging").every((entry) => entry.integrations === 1)).toBe(true);
    expect((await service.listActions(workspaceId)).filter((action) => action.kind === "integration")).toHaveLength(1);
  } finally { unsubscribe(); while (pending.length) await Promise.all(pending.splice(0)); }
});

it("claims only one active integration under the shared record lock", async () => {
  const { service, options, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, contract);
  const secondService = new WorkbenchService(options);
  const integration = { kind: "integration" as const, workItemId: item.workItemId, status: "pending" as const,
    stage: "merge" as const, message: "Merge", attempts: 0, history: [], createdAt: item.createdAt, updatedAt: item.updatedAt,
    integration: { operation: "merge" as const, diffStat: "" } };
  try {
    const results = await Promise.all([service, secondService].map((owner) => owner.createAction(
      workspaceId, integration, (current) => ({ ...current, status: "merging" }))));
    expect(results[0]!.actionId).toBe(results[1]!.actionId);
    expect((await service.listActions(workspaceId)).filter((action) => action.kind === "integration")).toHaveLength(1);
    expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("merging");
  } finally { await secondService.dispose(); }
});

it("publishes coherent execution and business states for failure, decision, answer and cancellation", async () => {
  const { root, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const action = (await service.listActions(workspaceId))[0]!;
  const observations: Promise<void>[] = [];
  const unsubscribe = service.subscribe((event) => {
    if (event.type !== "actions.changed" && event.type !== "workItems.changed") return;
    observations.push((async () => {
      const stored = JSON.parse(await readFile(join(root, ".vermillion", "workitems", item.workItemId + ".json"), "utf8"));
      expect(stored.item.status === "decision").toBe(stored.execution.status === "decision");
      expect(stored.item.status === "cancelled").toBe(stored.execution.status === "cancelled");
      if (stored.execution.status === "retry") expect(stored.item.status).toBe("queued");
    })());
  });
  try {
    for (let index = 0; index < 5; index++) await service.failAction(workspaceId, action.actionId, "temporarily unavailable");
    const exhausted = (await service.listDecisions(workspaceId))[0]!;
    await service.answerDecision(workspaceId, exhausted.decisionId, { key: "retry" });
    const question = await service.createDecision(workspaceId, { workItemId: item.workItemId, question: "Continue?", context: "User choice", options: [{ key: "cancel", label: "Cancel" }] });
    await service.answerDecision(workspaceId, question.decisionId, { key: "cancel" });
    await Promise.all(observations);
  } finally { unsubscribe(); }
});

it("serializes root code writers on the actual shared directory while allowing a read-only operation", async () => {
  const { service, workspaceId } = await fixture();
  const scope = { ...contract.scope, allowedPaths: ["src/"] };
  const first = await service.createWorkItem(workspaceId, { ...contract, scope });
  const second = await service.createWorkItem(workspaceId, { ...contract, scope, needs: ["different-name"] });
  const readOnly = await service.createWorkItem(workspaceId, contract);
  await service.startWorkItem(workspaceId, first.workItemId, { sessionId: "writer" });
  expect((await service.diagnoseWorkItem(workspaceId, first.workItemId)).scheduler.running).toBe(1);
  await expect(service.startWorkItem(workspaceId, second.workItemId, { sessionId: "other-writer" })).rejects.toThrow("资源");
  expect((await service.diagnoseWorkItem(workspaceId, second.workItemId)).resources).toMatchObject([{ name: "workspace:root", workItemId: first.workItemId }]);
  expect((await service.startWorkItem(workspaceId, readOnly.workItemId, { sessionId: "reader" })).status).toBe("running");
});

it("exposes the work-item workflow without retired handoff commands", () => {
  expect(workbenchRpc["workItem.start"].params.safeParse({ workspaceId: "workspace", workItemId: "item", run: { sessionId: "worker", attempts: 99 } }).success).toBe(false);
  for (const method of ["mission.create", "workItem.defer", "workItem.recover", "decision.withdraw", "workspace.repair.submit", "session.ask"])
    expect(Object.hasOwn(workbenchRpc, method)).toBe(false);
});

it("hides retired built-in roles while preserving their files and custom roles", async () => {
  const { root, roles } = await fixture();
  const global = join(root, ".vermillion", "roles");
  for (const role of ["steward", "supervisor", "workspace-repair", "my-role"]) await writeFile(join(global, role + ".md"), "# " + role);
  const ids = (await roles.list(root)).map((role) => role.roleId);
  expect(ids).toContain("my-role");
  expect(ids).not.toContain("steward"); expect(ids).not.toContain("supervisor"); expect(ids).not.toContain("workspace-repair");
  expect(await readFile(join(global, "steward.md"), "utf8")).toBe("# steward");
});
