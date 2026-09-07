import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { DocsService } from "../src/docs.js";
import { RoleService } from "../src/roles.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const contract = { title: "result", objective: "write result", risk: "R2" as const, scope: { inScope: [], outOfScope: [], allowedPaths: ["result.txt"] }, acceptance: [{ text: "result exists" }] };
const submission = { evidence: { summary: "result", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { verdict: "pass" as const, items: [{ index: 0, pass: true, evidence: "result checked" }] } };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "verm-handoff-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles: new RoleService({ globalDir: join(root, "roles") }) });
  cleanup.push(async () => service.dispose());
  const { workspaceId: ws } = await service.addWorkspace({ rootPath: root });
  await git(root, "config", "user.name", "Acceptance");
  await git(root, "config", "user.email", "acceptance@local");
  await git(root, "commit", "--allow-empty", "-m", "base");
  return { root, service, ws };
}

async function result(t: Awaited<ReturnType<typeof setup>>) {
  const item = await t.service.createWorkItem(t.ws, contract);
  const branch = "vermillion/" + item.workItemId;
  const worktreePath = join(t.root, ".vermillion", "worktrees", item.workItemId);
  await git(t.root, "worktree", "add", "-b", branch, worktreePath);
  await writeFile(join(worktreePath, "result.txt"), "result\n");
  await git(worktreePath, "add", "result.txt");
  await git(worktreePath, "commit", "-m", "result");
  await t.service.startWorkItem(t.ws, item.workItemId, { branch, worktreePath, sessionId: "worker" });
  return { ...item, branch, worktreePath };
}

it("cancels an unmerged result without blocking unrelated integration", async () => {
  const t = await setup();
  const item = await result(t);
  await t.service.cancelWorkItem(t.ws, item.workItemId);
  expect(await git(t.root, "branch", "--list", item.branch)).toBe("");
  expect((await t.service.listActions(t.ws)).some((a) => a.kind === "repair")).toBe(false);
  expect((await t.service.getWorkItem(t.ws, item.workItemId)).status).toBe("cancelled");
});

it("retains the same repair and budget until its cleanup actually succeeds", async () => {
  const t = await setup();
  const item = await result(t);
  const drop = vi.spyOn(DocsService.prototype, "dropWorktree").mockRejectedValue(new Error("cleanup locked"));
  await t.service.submitWorkItem(t.ws, item.workItemId, submission);
  const merged = await git(t.root, "rev-parse", "HEAD");
  const repair = (await t.service.listActions(t.ws)).find((a) => a.kind === "repair")!;
  await t.service.putAction(t.ws, { ...repair, sessionId: "repair", attempts: 3, idleTurns: 2 });
  const check = await t.service.submitWorkspaceRepair(t.ws, repair.actionId, { sessionId: "repair", summary: "checked main workspace", evidence: ["git status clean"] });
  expect(check.pass).toBe(false);
  expect(check.action).toMatchObject({ actionId: repair.actionId, attempts: 3, idleTurns: 2 });
  expect((await t.service.listActions(t.ws)).filter((a) => a.kind === "repair")).toHaveLength(1);
  expect(await git(t.root, "rev-parse", "HEAD")).toBe(merged);
  drop.mockRestore();
  expect((await t.service.submitWorkspaceRepair(t.ws, repair.actionId, { sessionId: "repair", summary: "cleanup available", evidence: ["lock released"] })).pass).toBe(true);
  expect((await t.service.getWorkItem(t.ws, item.workItemId)).status).toBe("closed");
  expect(await git(t.root, "rev-parse", "HEAD")).toBe(merged);
});

it("returns a replaced cancelled dependency to workbench waiting", async () => {
  const t = await setup();
  const first = await t.service.createWorkItem(t.ws, contract);
  const replacement = await t.service.createWorkItem(t.ws, contract);
  const item = await t.service.createWorkItem(t.ws, { ...contract, dependsOn: [first.workItemId] });
  await t.service.cancelWorkItem(t.ws, first.workItemId);
  await t.service.refreshActions(t.ws);
  const action = (await t.service.listActions(t.ws)).find((a) => a.kind === "dependency" && a.workItemIds.includes(item.workItemId))!;
  expect(action.role).toBe("steward");
  await t.service.updateWorkItem(t.ws, item.workItemId, { dependsOn: [replacement.workItemId], note: "use replacement" });
  await t.service.refreshActions(t.ws);
  expect((await t.service.listActions(t.ws)).find((a) => a.actionId === action.actionId)).toMatchObject({ role: "workbench", status: "waiting", attempts: 0 });
  expect(await t.service.isWorkItemBlocked(t.ws, item.workItemId)).toBe(true);
});

it("recovers a verified merging item whose integration action was not written", async () => {
  const t = await setup();
  const item = await result(t);
  const create = vi.spyOn(t.service, "createAction").mockRejectedValueOnce(new Error("interrupted before action write"));
  await expect(t.service.submitWorkItem(t.ws, item.workItemId, submission)).rejects.toThrow("interrupted");
  create.mockRestore();
  expect((await t.service.getWorkItem(t.ws, item.workItemId)).status).toBe("merging");
  await t.service.refreshActions(t.ws);
  await t.service.continueIntegrations(t.ws);
  expect((await t.service.getWorkItem(t.ws, item.workItemId)).status).toBe("closed");
  expect((await t.service.listActions(t.ws)).filter((a) => a.kind === "integration")).toHaveLength(1);
});

it("replays answered and withdrawn decisions after interruption without duplicate delivery", async () => {
  const t = await setup();
  const item = await t.service.createWorkItem(t.ws, contract);
  for (const mode of ["answer", "withdraw"]) {
    const card = await t.service.createDecision(t.ws, { workItemId: item.workItemId, sessionId: "worker", question: mode, context: "choose", options: [{ key: "yes", label: "yes" }] });
    const write = vi.spyOn(t.service, "putAction").mockRejectedValueOnce(new Error("interrupted delivery"));
    await expect(mode === "answer" ? t.service.answerDecision(t.ws, card.decisionId, { key: "yes", note: "chosen" }) : t.service.withdrawDecision(t.ws, card.decisionId, "worker", "clarified")).rejects.toThrow("interrupted delivery");
    write.mockRestore();
    expect((await t.service.listDecisions(t.ws)).find((c) => c.decisionId === card.decisionId)?.deliveryPending).toBe(true);
    await t.service.refreshActions(t.ws);
    await t.service.refreshActions(t.ws);
    expect((await t.service.listDecisions(t.ws)).find((c) => c.decisionId === card.decisionId)?.deliveryPending).toBe(false);
    const action = (await t.service.listActions(t.ws)).find((a) => a.actionId === card.actionId)!;
    expect(action.history.filter((h) => h.decisionId === card.decisionId)).toHaveLength(1);
    expect(action.status).toBe("pending");
  }
});

it("keeps the steward responsible for a decision after the contract itself was updated", async () => {
  const t = await setup();
  const item = await t.service.createWorkItem(t.ws, contract);
  await t.service.escalateWorkItem(t.ws, item.workItemId, "clarify objective", { requiredChanges: ["objective"] });
  const action = (await t.service.listActions(t.ws)).find((a) => a.kind === "contract")!;
  await t.service.putAction(t.ws, { ...action, sessionId: "steward" });
  const card = await t.service.createDecision(t.ws, { actionId: action.actionId, workItemId: item.workItemId, sessionId: "steward", question: "which wording?", context: "choose", options: [] });
  await t.service.updateWorkItem(t.ws, item.workItemId, { objective: "concrete output", note: "objective clarified", resolution: { actionId: action.actionId, disposition: "updated", reason: "objective changed" } });
  expect((await t.service.listActions(t.ws)).find((a) => a.actionId === action.actionId)?.status).toBe("decision");
  await t.service.answerDecision(t.ws, card.decisionId, { note: "use the concrete output" });
  expect((await t.service.listActions(t.ws)).find((a) => a.actionId === action.actionId)).toMatchObject({ role: "steward", sessionId: "steward", status: "pending", stage: "deliver" });
  expect(await t.service.isWorkItemBlocked(t.ws, item.workItemId)).toBe(true);
});
