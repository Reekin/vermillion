import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { RoleService } from "../src/roles.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";

let root: string;
let service: WorkbenchService;
afterEach(async () => { service?.dispose(); if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
async function setup() {
  root = await mkdtemp(join(tmpdir(), "verm-diagnosis-"));
  service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles: new RoleService({ globalDir: join(root, "roles") }) });
  const { workspaceId } = await service.addWorkspace({ rootPath: root });
  const create = (needs: string[] = [], dependsOn: string[] = []) => service.createWorkItem(workspaceId, { title: "CLI diagnosis", objective: "Explain waiting", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "Current waiting visible" }], needs, dependsOn });
  return { workspaceId, create };
}

it("explains scheduler, concurrency and concrete resource waits without creating actions", async () => {
  const { workspaceId: ws, create } = await setup();
  const running = await create(["shared:database"]);
  const waiting = await create(["shared:database"]);
  await service.setScheduler(ws, { enabled: true, maxWorkers: 1 });
  await service.startWorkItem(ws, running.workItemId, { sessionId: "owner" });
  const offline = await service.diagnoseWorkItem(ws, waiting.workItemId);
  expect(offline.blockers).toEqual([]);
  expect(offline.waiting.join(" ")).toContain("不在线");
  expect(offline.waiting.join(" ")).toContain("并发");
  expect(offline.resources).toEqual([{ name: "shared:database", workItemId: running.workItemId, sessionId: "owner" }]);
  expect(await service.listActions(ws)).toEqual([]);
  service.setRecoveryHandler(async () => {});
  await service.setScheduler(ws, { enabled: false, maxWorkers: 2 });
  expect((await service.diagnoseWorkItem(ws, waiting.workItemId)).waiting.join(" ")).toContain("开关关闭");
  const free = await create();
  await service.setScheduler(ws, { enabled: true, maxWorkers: 2 });
  expect((await service.diagnoseWorkItem(ws, free.workItemId)).waiting).toEqual(["等待调度器接手排队动作。"]);
});

it("retains every responsibility and dependency when recovering a blocked item", async () => {
  const { workspaceId: ws, create } = await setup();
  const parent = await create();
  const item = await create([], [parent.workItemId]);
  await service.escalateWorkItem(ws, item.workItemId, "Need contract change");
  const contract = (await service.listActions(ws))[0]!;
  await service.putAction(ws, { ...contract, sessionId: "steward" });
  await service.failAction(ws, contract.actionId, "delivery failed");
  const card = await service.createDecision(ws, { actionId: contract.actionId, workItemId: item.workItemId, sessionId: "steward", question: "Choose scope", context: "Scope unclear", options: [{ key: "a", label: "A", detail: "Scope A" }] });
  const result = await service.recoverWorkItem(ws, item.workItemId);
  expect(result.dispatched).toBe(false);
  expect(result.diagnosis.dependencies[0]!.status).toBe("queued");
  expect(result.diagnosis.actions.some((a) => a.sessionId === "steward")).toBe(true);
  expect(result.diagnosis.decisions[0]!.decisionId).toBe(card.decisionId);
  expect(result.diagnosis.lastFailure?.failure).toBe("delivery failed");
  expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
  const rpc = createWorkbenchRpcHandler(service);
  const withdrawn = await rpc({ method: "decision.withdraw", params: { workspaceId: ws, decisionId: card.decisionId, sessionId: "steward", reason: "Clarified" } });
  expect(withdrawn).toMatchObject({ ok: true, result: { feedback: { dispatch: "offline" }, withdrawn: { reason: "Clarified" } } });
  expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
});

it("reports the actual delivery transition and no delivery for an unchanged active action", async () => {
  const { workspaceId: ws, create } = await setup();
  const item = await create();
  await service.refreshActions(ws);
  const action = (await service.listActions(ws))[0]!;
  await service.failAction(ws, action.actionId, "send failed");
  expect((await service.diagnoseWorkItem(ws, item.workItemId)).nextRetryAt).toBeDefined();
  service.setRecoveryHandler(async () => {
    const current = (await service.listActions(ws)).find((a) => a.actionId === action.actionId)!;
    if (!current.deliveredAt) await service.putAction(ws, { ...current, stage: "execute", status: "running", sessionId: "original", deliveredAt: "2026-09-08T00:00:00Z", retryAt: undefined });
  });
  expect(await service.recoverWorkItem(ws, item.workItemId)).toMatchObject({ dispatched: true, changes: [{ actionId: action.actionId, after: "running/execute" }] });
  expect(await service.recoverWorkItem(ws, item.workItemId)).toMatchObject({ dispatched: false, changes: [] });
});
