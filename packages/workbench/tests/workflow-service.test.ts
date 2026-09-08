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
  expect(await service.listActions(workspaceId)).toEqual([]);
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

it("reads historical work items without retired fields and leaves every historical file unchanged", async () => {
  const { root, service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, contract);
  const path = join(root, ".vermillion", "workitems", item.workItemId + ".json");
  const raw = JSON.stringify({ ...item, missionId: "historical", contractIssue: { message: "old", at: "then" } });
  await writeFile(path, raw);
  await mkdir(join(root, ".vermillion", "missions"));
  const missionPath = join(root, ".vermillion", "missions", "old.json");
  await writeFile(missionPath, '{"historical":true}');
  expect(await new WorkspaceStore(root).workItems.list()).toEqual([item]);
  expect(await readFile(path, "utf8")).toBe(raw);
  expect(await readFile(missionPath, "utf8")).toBe('{"historical":true}');
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
