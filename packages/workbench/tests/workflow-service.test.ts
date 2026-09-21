import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace-store.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { workbenchRpc } from "../src/rpc.js";
import { contract, git, setup, submission } from "./workflow-fixture.js";

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
    await restarted.completePreparation(workspaceId, { requestId: request.requestId, sessionId: "prep", workItemIds: [first.workItemId, next.workItemId] });
    await restarted.finishPreparation(workspaceId, "prep", "prep-end");
    expect(await restarted.getWorkItem(workspaceId, first.workItemId)).toMatchObject({ status: "queued", sourceSessionId: "design", treeId: "tree", run: { sessionId: "prep" } });
    expect(await restarted.getWorkItem(workspaceId, next.workItemId)).toMatchObject({ status: "queued", run: { forkSessionId: "prep", forkTurnId: "prep-end" } });
  } finally { await restarted.dispose(); }
});

it("cancels a preparation request and its unfinished items through the CLI/RPC contract", async () => {
  const { client, service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "design-turn" });
  await service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: "prep" });
  const first = await service.createWorkItem(workspaceId, { ...contract, requestId: request.requestId, sessionId: "prep" });
  const sibling = await service.createWorkItem(workspaceId, { ...contract, requestId: request.requestId });

  const result = await client.request("work.cancel", { workspaceId, requestId: request.requestId });

  expect(result).toMatchObject({ cancelled: true, request: { requestId: request.requestId, status: "cancelled" } });
  expect((await service.getWorkItem(workspaceId, first.workItemId)).status).toBe("cancelled");
  expect((await service.getWorkItem(workspaceId, sibling.workItemId)).status).toBe("cancelled");
  expect(await service.listDecisions(workspaceId)).toEqual([]);
  expect(await client.request("work.cancel", { workspaceId, sessionId: "prep" })).toMatchObject({ cancelled: true, request: { status: "cancelled" } });
  await service.finishPreparation(workspaceId, "prep", "prep-end");
  expect((await service.listWorkRequests(workspaceId))[0]?.status).toBe("cancelled");
  expect((await service.getWorkItem(workspaceId, first.workItemId)).status).toBe("cancelled");
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

it("retains the preparation session through failure backoff and exposes exhausted recovery as work state", async () => {
  const { service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "source", turnId: "turn" });
  await service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: "preparing-worker" });
  for (let attempt = 0; attempt < 5; attempt++) await service.failWorkRequest(workspaceId, request.requestId, "preparation failed");
  expect((await service.listWorkRequests(workspaceId))[0]).toMatchObject({ status: "failed", attempts: 5, workerSessionId: "preparing-worker" });
  expect(await service.listDecisions(workspaceId)).toEqual([]);
  expect(await service.listInbox()).toEqual([]);
  await service.retryWork(workspaceId, request.requestId);
  expect((await service.listWorkRequests(workspaceId))[0]).toMatchObject({ status: "preparing", attempts: 0, workerSessionId: "preparing-worker" });
});

it("delivers worker decisions that also carry a preparation request id", async () => {
  const { client, service, workspaceId } = await fixture();
  const request = await service.startWork(workspaceId, { sessionId: "design", turnId: "source-turn" });
  await service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: "worker" });
  const item = await service.createWorkItem(workspaceId, { ...contract, requestId: request.requestId, sessionId: "worker" });
  await service.completePreparation(workspaceId, { requestId: request.requestId, sessionId: "worker", workItemIds: [item.workItemId] });
  await service.finishPreparation(workspaceId, "worker", "prep-end");
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const action = (await service.listActions(workspaceId))[0]!;
  const card = await service.createDecision(workspaceId, {
    requestId: request.requestId, workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker", kind: "worker",
    question: "Continue?", context: "The worker needs a choice.", options: [{ key: "go", label: "Continue" }]
  });

  await client.request("decision.answer", { workspaceId, decisionId: card.decisionId, key: "go" });

  expect((await service.listActions(workspaceId))[0]).toMatchObject({
    actionId: action.actionId, status: "pending", stage: "deliver",
    history: [expect.objectContaining({ event: "decision.created" }), expect.objectContaining({ event: "decision.answered", decisionId: card.decisionId })]
  });
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("queued");
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
  expect((await service.listDecisions(workspaceId))).toEqual([]);
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ status: "decision", control: "manual", waitReason: "自动恢复次数已用尽", failure: "failure five" });
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("decision");
  await service.retryWorkItem(workspaceId, item.workItemId);
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ attempts: 0, sessionId: "original", status: "pending" });
});

it("persists a user pause separately from failure decisions and resumes the same work item", async () => {
  const { client, options, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });

  const paused = await client.request("workItem.pause", { workspaceId, sessionId: "worker" });
  expect(paused).toMatchObject({ paused: true, workItem: { status: "running", run: { sessionId: "worker", control: "paused", pauseReason: "user", attempts: 0 } } });
  expect(await service.listDecisions(workspaceId)).toEqual([]);
  expect(await service.diagnoseWorkItem(workspaceId, item.workItemId)).toMatchObject({
    waiting: expect.arrayContaining(["用户已暂停 Worker"]),
    availableActions: expect.arrayContaining([expect.objectContaining({ method: "workItem.resume" })])
  });

  const restarted = new WorkbenchService(options);
  try {
    expect(await restarted.getWorkItem(workspaceId, item.workItemId)).toMatchObject({ status: "running", run: { control: "paused", pauseReason: "user" } });
    const resumed = await restarted.resumeWorkItem(workspaceId, item.workItemId);
    expect(resumed).toMatchObject({ status: "running", run: { sessionId: "worker", control: "auto" } });
    expect(resumed.run.pauseReason).toBeUndefined();
    expect((await restarted.listActions(workspaceId))[0]).toMatchObject({ status: "pending", stage: "deliver" });
  } finally { await restarted.dispose(); }
});

it("preserves verification outcomes and keeps incomplete validation out of user decisions", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const returned = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission,
    verify: { verdict: "pass", items: [{ index: 0, status: "blocked", evidence: "验收实例尚未就绪" }] } });
  expect(returned).toMatchObject({ status: "queued", verify: { verdict: "rework", items: [{ status: "blocked" }] } });
  expect(await service.listDecisions(workspaceId)).toEqual([]);

  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const incomplete = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission,
    verify: { verdict: "rework", items: [{ index: 0, status: "incomplete", evidence: "右侧路径尚未操作" }] } });
  expect(incomplete).toMatchObject({ status: "queued", verify: { items: [{ status: "incomplete" }] } });
  expect(await service.listDecisions(workspaceId)).toEqual([]);
});

it("merges partial verification with existing results before deciding whether to merge", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker",
    acceptance: [{ text: "First result" }, { text: "Second result" }] });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const waiting = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission,
    verify: { verdict: "rework", items: [
      { index: 0, status: "pass", evidence: "First result checked" },
      { index: 1, status: "blocked", evidence: "Second result needs a fixture" }
    ] } });
  expect(waiting).toMatchObject({ status: "queued", verify: { verdict: "rework", items: [{ index: 0, status: "pass" }, { index: 1, status: "blocked" }] } });

  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission,
    evidence: { ...submission.evidence, summary: "Second result completed", commands: [{ command: "check", output: "pass" }] },
    verify: { verdict: "pass", items: [{ index: 1, status: "pass", evidence: "Second result checked" }] } });

  expect(closed.status).toBe("closed");
  expect(closed.verify).toMatchObject({ verdict: "pass", items: [{ index: 0, status: "pass" }, { index: 1, status: "pass" }] });
  expect(closed.evidence?.commands).toContainEqual({ command: "check", output: "pass" });
});

it("invalidates replaced acceptance results and retains their original meaning in history", async () => {
  const { service, client, workspaceId, options } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract,
    acceptance: [{ text: "A" }, { text: "B" }] });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, verify: { verdict: "rework", items: [
    { index: 0, status: "pass", evidence: "Only A verified" },
    { index: 1, status: "incomplete", evidence: "B pending" }
  ] } });
  const updated = await client.request("workItem.update", { workspaceId, workItemId: item.workItemId,
    acceptance: [{ text: "C" }, { text: "B" }], note: "Replace A with C" });
  expect(updated.verify?.items).toMatchObject([{ index: 0, status: "incomplete" }, { index: 1, evidence: "B pending" }]);
  const restarted = new WorkbenchService(options);
  try {
    expect((await restarted.getWorkItem(workspaceId, item.workItemId)).verify).toEqual(updated.verify);
    const history = (await restarted.listActions(workspaceId))[0]!.history.find((entry) => entry.event === "acceptance.updated")!;
    expect(history.message).toContain('"text":"A"');
    expect(history.message).toContain("Only A verified");
  } finally { await restarted.dispose(); }
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const stale = await service.submitWorkItem(workspaceId, item.workItemId, submission);
  expect(stale.rejections.at(-1)?.reason).toContain("提交依据已过期");
  expect(stale.verify).toEqual(updated.verify);
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const pending = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, contractRevision: updated.contractRevision,
    verify: { verdict: "pass", items: [{ index: 1, status: "pass", evidence: "B verified" }] } });
  expect(pending.status).toBe("queued");
  expect(pending.verify?.items[0]?.status).toBe("incomplete");
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, contractRevision: updated.contractRevision,
    verify: { verdict: "pass", items: [{ index: 0, status: "pass", evidence: "C verified" }] } });
  expect(closed.status).toBe("closed");
  expect(closed.verify?.items.map((entry) => entry.evidence)).toEqual(["C verified", "B verified"]);
  const inbox = (await service.listInbox()).find((entry) => entry.kind === "merged" && entry.workItem.workItemId === item.workItemId);
  expect(inbox).toMatchObject({ kind: "merged", workItem: { acceptance: closed.acceptance, verify: closed.verify } });
});

it("removes deleted results and remaps retained results when acceptance is reordered", async () => {
  const { service, workspaceId } = await fixture();
  const acceptance = [{ text: "A", source: "Requirement A" }, { text: "B" }, { text: "C" }];
  const item = await service.createWorkItem(workspaceId, { ...contract, acceptance });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const waiting = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, verify: { verdict: "rework", items: [
    { index: 0, status: "pass", evidence: "A checked" },
    { index: 1, status: "blocked", evidence: "B blocked" },
    { index: 2, status: "pass", evidence: "C checked" }
  ] } });
  const renamed = await service.updateWorkItem(workspaceId, item.workItemId, { title: "Renamed", note: "Title only" });
  expect(renamed.verify).toEqual(waiting.verify);
  const updated = await service.updateWorkItem(workspaceId, item.workItemId, { acceptance: [acceptance[2]!, acceptance[0]!], note: "Remove B and reorder" });
  expect(updated.verify?.items).toEqual([
    { index: 0, status: "pass", evidence: "C checked" }, { index: 1, status: "pass", evidence: "A checked" }
  ]);
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, contractRevision: updated.contractRevision,
    verify: { verdict: "pass", items: [] } });
  expect(closed.status).toBe("closed");
  expect(closed.verify?.items).toEqual(updated.verify?.items);
});

it("does not transfer evidence to a different source or ambiguous duplicate acceptance", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, acceptance: [{ text: "A", source: "original" }] });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, verify: { ...submission.verify, verdict: "rework" } });
  const updated = await service.updateWorkItem(workspaceId, item.workItemId, { note: "Change source and add duplicate requirements",
    acceptance: [{ text: "A", source: "different" }, { text: "A", source: "original" }, { text: "A", source: "original" }] });
  expect(updated.verify?.items.map((entry) => entry.status)).toEqual(["incomplete", "incomplete", "incomplete"]);
});

it("rejects a submission based on an old contract revision while preserving prior evidence", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.updateWorkItem(workspaceId, item.workItemId, { objective: "Updated result", note: "Updated contract" });

  const returned = await service.submitWorkItem(workspaceId, item.workItemId, submission);

  expect(returned).toMatchObject({ status: "queued", contractRevision: 1 });
  expect(returned.evidence).toBeUndefined();
  expect(returned.verify).toBeUndefined();
  expect(returned.rejections.at(-1)?.reason).toContain("提交依据已过期");
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

it("refuses a record that still carries the pre-notice execution message", async () => {
  const { root, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  const path = join(root, ".vermillion", "workitems", item.workItemId + ".json");
  const record = JSON.parse(await readFile(path, "utf8"));
  delete record.execution.notices;
  record.execution.message = "旧的待送达消息";
  const raw = JSON.stringify(record, null, 2) + "\n";
  await writeFile(path, raw);

  await expect(new WorkspaceStore(root).listRecords()).rejects.toThrow("Unsupported or invalid workbench record");
  await expect(service.refreshActions(workspaceId)).rejects.toThrow("Convert stored data explicitly");
  expect(await readFile(path, "utf8")).toBe(raw);
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
  expect(stored.execution.notices).toEqual([expect.objectContaining({ kind: "contract", text: expect.stringContaining("Read updated contract") })]);
  expect(stored.execution).not.toHaveProperty("resumeMessage");
  expect(stored.execution).not.toHaveProperty("lastFailure");
  const restarted = new WorkbenchService(options);
  try {
    const projected = await restarted.getWorkItem(workspaceId, item.workItemId);
    expect(projected.run).toMatchObject({ sessionId: "original", lastTurnId: "latest-turn", attempts: 1, lastFailure: "model unavailable", retryAt: stored.execution.retryAt });
    expect(projected.run.resumeMessage).toContain("Read updated contract");
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
    integration: { operation: "merge" as const, contractRevision: item.contractRevision, diffStat: "" } };
  try {
    const results = await Promise.all([service, secondService].map((owner) => owner.createAction(
      workspaceId, integration, (current) => ({ ...current, status: "merging" }))));
    expect(results[0]!.actionId).toBe(results[1]!.actionId);
    expect((await service.listActions(workspaceId)).filter((action) => action.kind === "integration")).toHaveLength(1);
    expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("merging");
  } finally { await secondService.dispose(); }
});

it("surfaces a failed merge in Inbox, supports immediate retry, and closes it without waiting for backoff", async () => {
  const { client, root, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker",
    scope: { ...contract.scope, allowedPaths: [join(root, "..", "external-artifact")] } });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const action = await service.createAction(workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "pending", stage: "merge", message: "等待合入",
    integration: { operation: "merge", contractRevision: item.contractRevision, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  await service.failAction(workspaceId, action.actionId, "主工作区有未提交修改");

  expect(await service.listInbox()).toMatchObject([{
    kind: "integration", workItem: { workItemId: item.workItemId, status: "merging" },
    action: { actionId: action.actionId, status: "retry", attempts: 1 }
  }]);
  const closed = await client.request("workItem.integration.retry", { workspaceId, workItemId: item.workItemId });
  expect(closed).toMatchObject({ status: "closed", merge: { diffStat: "" } });
  expect((await service.listActions(workspaceId)).find((entry) => entry.actionId === action.actionId)).toMatchObject({ status: "done", attempts: 0 });
});

it("transfers a failed merge to the original worker and completes it through the controlled integration entry", async () => {
  const { client, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const action = await service.createAction(workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "pending", stage: "merge", message: "等待合入",
    integration: { operation: "merge", contractRevision: item.contractRevision, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  for (let attempt = 0; attempt < 5; attempt++) await service.failAction(workspaceId, action.actionId, "主工作区阻塞");

  const delegated = await client.request("workItem.integration.takeover", { workspaceId, workItemId: item.workItemId, note: "请保留主目录修改，处理分支后合入" });
  const owned = (await service.listActions(workspaceId)).find((entry) => entry.actionId === action.actionId)!;
  expect(delegated.status).toBe("queued");
  expect(owned).toMatchObject({ status: "pending", agent: { sessionId: "worker", note: "请保留主目录修改，处理分支后合入" } });
  expect(owned?.retryAt).toBeUndefined();
  expect((await service.listInbox()).some((entry) => entry.kind === "integration")).toBe(false);

  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const completed = await client.request("workItem.integration.complete", { workspaceId, workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker" });
  expect(completed).toMatchObject({ status: "closed", merge: { diffStat: "" } });
  expect((await service.listActions(workspaceId)).find((entry) => entry.actionId === action.actionId)).toMatchObject({ status: "done" });
});

it("pauses and resumes a delegated merge without returning it to automatic execution", async () => {
  const { client, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const action = await service.createAction(workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "pending", stage: "merge", message: "等待合入",
    integration: { operation: "merge", contractRevision: item.contractRevision, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  await service.failAction(workspaceId, action.actionId, "主工作区阻塞");
  await service.takeoverIntegration(workspaceId, item.workItemId, "先暂停");
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });

  const paused = await client.request("workItem.pause", { workspaceId, sessionId: "worker" });
  expect(paused).toMatchObject({ paused: true, workItem: { status: "running", run: { control: "paused", pauseReason: "user" } } });
  await expect(client.request("workItem.integration.complete", { workspaceId, workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker" })).rejects.toThrow("先恢复工单");

  const resumed = await client.request("workItem.resume", { workspaceId, workItemId: item.workItemId });
  expect(resumed).toMatchObject({ status: "running", run: { control: "auto" } });
  expect(resumed.run.pauseReason).toBeUndefined();
  expect((await service.listActions(workspaceId)).find((entry) => entry.actionId === action.actionId)).toMatchObject({ status: "pending", agent: { sessionId: "worker" } });
});

it("keeps exhausted merge failures in the integration Inbox instead of creating a duplicate generic decision card", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const action = await service.createAction(workspaceId, {
    kind: "integration", workItemId: item.workItemId, status: "pending", stage: "merge", message: "等待合入",
    integration: { operation: "merge", contractRevision: item.contractRevision, diffStat: "" }
  }, (current) => ({ ...current, status: "merging" }));
  for (let attempt = 0; attempt < 5; attempt++) await service.failAction(workspaceId, action.actionId, "持续阻塞");

  expect(await service.listDecisions(workspaceId)).toEqual([]);
  expect(await service.listInbox()).toMatchObject([{ kind: "integration", action: { status: "decision", attempts: 5 } }]);
});

it("handles a real dirty-workspace merge through Worker takeover without losing the worker branch", async () => {
  const { client, root, service, workspaceId } = await fixture();
  await writeFile(join(root, "result.txt"), "base\n");
  await git(root, "add", "result.txt");
  await git(root, "commit", "-qm", "base result");
  const worktreePath = join(root, "merge-worker");
  const branch = "work/merge-takeover";
  await git(root, "worktree", "add", "-b", branch, worktreePath);
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker", worktreePath, branch,
    scope: { ...contract.scope, allowedPaths: ["result.txt"] } });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await writeFile(join(worktreePath, "result.txt"), "worker result\n");
  await git(worktreePath, "add", "result.txt");
  await git(worktreePath, "commit", "-qm", "worker result");
  await writeFile(join(root, "result.txt"), "user edit\n");

  const blocked = await service.submitWorkItem(workspaceId, item.workItemId, submission);
  const action = (await service.listActions(workspaceId)).find((entry) => entry.workItemId === item.workItemId && entry.kind === "integration")!;
  expect(blocked.status).toBe("merging");
  expect(action).toMatchObject({ status: "retry", attempts: 1 });
  expect(action.failure).toContain("Your local changes");
  expect(await service.listInbox()).toMatchObject([{ kind: "integration", workItem: { workItemId: item.workItemId }, action: { status: "retry" } }]);

  await client.request("workItem.integration.takeover", { workspaceId, workItemId: item.workItemId, note: "保留用户改动并合入 Worker 成果" });
  await writeFile(join(worktreePath, "result.txt"), "worker rebased\n");
  await git(worktreePath, "add", "result.txt");
  await git(worktreePath, "commit", "-qm", "worker rebase result");
  await writeFile(join(root, "result.txt"), "base\n");
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  const completed = await client.request("workItem.integration.complete", { workspaceId, workItemId: item.workItemId, actionId: action.actionId, sessionId: "worker" });
  expect(completed).toMatchObject({ status: "closed", merge: { commit: expect.any(String) } });
  expect(completed.run.worktreePath).toBeUndefined();
  expect(completed.run.branch).toBeUndefined();
  expect((await readFile(join(root, "result.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("worker rebased\n");
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
    expect(await service.listDecisions(workspaceId)).toEqual([]);
    await service.retryWorkItem(workspaceId, item.workItemId);
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

it("keeps the contract revision while only scheduling fields change", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });

  const updated = await service.updateWorkItem(workspaceId, item.workItemId, { title: "Renamed", needs: ["shared-instance"], note: "Scheduling only" });

  expect(updated.contractRevision).toBe(0);
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, submission);
  expect(closed).toMatchObject({ status: "closed", contractRevision: 0 });
});

it("asks the worker to re-read an externally edited contract and leaves its own edits undelivered", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });

  const external = await service.updateWorkItem(workspaceId, item.workItemId, { objective: "Updated result", note: "Requirement moved" });
  expect(external.run.resumeMessage).toContain("【合同调整】Requirement moved");
  expect(external.run.resumeMessage).toContain("workItem.get");

  const own = await service.updateWorkItem(workspaceId, item.workItemId, { sessionId: "worker", note: "Own adjustment", scope: { ...contract.scope, allowedPaths: ["src"] } });
  expect(own.contractRevision).toBe(2);
  expect(own.decisions).toContain("工单调整：Own adjustment");
  expect(own.run.resumeMessage).toBe("【合同调整】Requirement moved\n立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。");
});
