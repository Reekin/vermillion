import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { actionIsOpen, type WorkflowAction } from "../src/contracts.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout;
const roots: string[] = [];
const services: WorkbenchService[] = [];
const now = "2026-09-08T01:00:00.000Z";
const contract = {
  title: "Work", objective: "Deliver result", risk: "R2" as const,
  scope: { inScope: [], outOfScope: [], allowedPaths: [] as string[] },
  acceptance: [{ text: "Result is available" }]
};
const submission = {
  evidence: { summary: "Result available", commands: [{ command: "git diff --check", output: "" }], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
  review: [{ comment: "Scope checked", decision: "accepted" as const, reason: "Within contract" }],
  verify: { items: [{ index: 0, pass: true, evidence: "Inspected result" }], verdict: "pass" as const }
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "verm-workflow-"));
  roots.push(root);
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(),
    roles: new RoleService({ globalDir: join(root, ".vermillion", "roles") }), now: () => now });
  services.push(service);
  const { workspaceId: ws } = await service.addWorkspace({ rootPath: root });
  await git(root, "config", "user.name", "Workflow test");
  await git(root, "config", "user.email", "workflow@local");
  await git(root, "config", "core.autocrlf", "false");
  return { root, service, ws };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

async function mission(service: WorkbenchService, ws: string, title: string) {
  await service.writeDoc(ws, `.vermillion/docs/${title}.md`, `# ${title}\n`);
  return service.createMission(ws, { title, summary: title });
}

describe("workflow service persisted transitions", { timeout: 30000 }, () => {
  it("requires an explicit resolution and a changed required field; titles, notes and answers keep the contract blocked", async () => {
    const { service, ws } = await setup();
    const item = await service.createWorkItem(ws, contract);
    await service.startWorkItem(ws, item.workItemId, { sessionId: "worker" });
    await service.escalateWorkItem(ws, item.workItemId, "Acceptance needs a concrete result", { requiredChanges: ["acceptance"] });
    const action = (await service.listActions(ws)).find((a) => a.kind === "contract")!;
    const resolution = { actionId: action.actionId, disposition: "updated" as const, reason: "Contract adjusted" };
    await service.updateWorkItem(ws, item.workItemId, { title: "Renamed", note: "Additional explanation" });
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
    for (const changes of [{ title: "Another title" }, {}, { objective: "Different objective" }, { acceptance: contract.acceptance }]) {
      await expect(service.updateWorkItem(ws, item.workItemId, { ...changes, note: "Claim fixed", resolution })).rejects.toThrow();
      expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
    }
    const card = await service.createDecision(ws, { actionId: action.actionId, workItemId: item.workItemId,
      sessionId: "steward", question: "Which result?", context: "Acceptance unclear", options: [{ key: "chosen", label: "Concrete result", detail: "Specify output" }] });
    await service.answerDecision(ws, card.decisionId, { key: "chosen", note: "Use the concrete output" });
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
    await expect(service.startWorkItem(ws, item.workItemId, { sessionId: "worker" })).rejects.toThrow();
    await service.updateWorkItem(ws, item.workItemId, { acceptance: [{ text: "Output contains chosen result" }], note: "Changed without resolution" });
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
    await service.updateWorkItem(ws, item.workItemId, { acceptance: [{ text: "Open output and see the chosen result" }], note: "Implemented choice", resolution });
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(false);
    expect((await service.listActions(ws)).find((a) => a.actionId === action.actionId)?.status).toBe("done");
    expect((await service.startWorkItem(ws, item.workItemId, { sessionId: "worker" })).status).toBe("running");
  });

  it("creates, updates and defers across missions, rejects missing targets and reports a complete cycle chain", async () => {
    const { service, ws } = await setup();
    const m1 = await mission(service, ws, "one");
    const m2 = await mission(service, ws, "two");
    const a = await service.createWorkItem(ws, { ...contract, missionId: m1.missionId });
    const b = await service.createWorkItem(ws, { ...contract, missionId: m2.missionId, dependsOn: [a.workItemId] });
    expect(b.dependsOn).toEqual([a.workItemId]);
    const c = await service.createWorkItem(ws, { ...contract, missionId: m1.missionId });
    expect((await service.updateWorkItem(ws, c.workItemId, { dependsOn: [b.workItemId], note: "Cross mission prerequisite" })).dependsOn).toEqual([b.workItemId]);
    const d = await service.createWorkItem(ws, { ...contract, missionId: m2.missionId });
    await service.startWorkItem(ws, d.workItemId, { sessionId: "original", attempts: 2 });
    expect(await service.deferWorkItem(ws, d.workItemId, c.workItemId, "Need upstream result")).toMatchObject({ status: "queued", dependsOn: [c.workItemId], run: { sessionId: "original", attempts: 2 } });
    const chain = [a.workItemId, d.workItemId, c.workItemId, b.workItemId, a.workItemId].join(" → ");
    await expect(service.updateWorkItem(ws, a.workItemId, { dependsOn: [d.workItemId], note: "Would cycle" })).rejects.toThrow(chain);
    await service.startWorkItem(ws, a.workItemId, { sessionId: "a" });
    await expect(service.deferWorkItem(ws, a.workItemId, d.workItemId, "Would cycle")).rejects.toThrow(chain);
    await expect(service.createWorkItem(ws, { ...contract, dependsOn: ["missing"] })).rejects.toThrow("missing");
    await expect(service.updateWorkItem(ws, a.workItemId, { dependsOn: ["missing"], note: "Unknown" })).rejects.toThrow("missing");
    await expect(service.deferWorkItem(ws, a.workItemId, "missing", "Unknown")).rejects.toThrow("missing");
    expect((await service.getWorkItem(ws, a.workItemId)).dependsOn).toEqual([]);
  });

  it("hands a cancelled prerequisite to the standalone dependent's steward without creating a mission", async () => {
    const { service, ws } = await setup();
    const parent = await service.createWorkItem(ws, contract);
    const item = await service.createWorkItem(ws, { ...contract, dependsOn: [parent.workItemId] });
    await service.refreshActions(ws);
    const waiting = (await service.listActions(ws)).find((a) => a.kind === "dependency" && a.workItemIds.includes(item.workItemId))!;
    expect(waiting).toMatchObject({ role: "workbench", status: "waiting" });
    await service.cancelWorkItem(ws, parent.workItemId);
    await service.refreshActions(ws);
    await service.refreshActions(ws);
    const actions = (await service.listActions(ws)).filter((a) => a.kind === "dependency" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ actionId: waiting.actionId, role: "steward", status: "pending", ownerKey: `steward:${item.workItemId}` });
    expect(actions[0]!.missionId).toBeUndefined();
    expect((await service.getWorkItem(ws, item.workItemId)).missionId).toBeUndefined();
    expect(await service.listMissions(ws)).toEqual([]);
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
    await service.updateWorkItem(ws, item.workItemId, { dependsOn: [], note: "Prerequisite no longer required" });
    await service.refreshActions(ws);
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(false);
  });

  it.each<[WorkflowAction["role"], WorkflowAction["kind"]]>([["worker", "execute"], ["steward", "contract"], ["workspace-repair", "repair"], ["workbench", "integration"]])(
    "%s retries the same action after 1/5/30/300 minutes, emits one fifth-failure card and resets on retry", async (role, kind) => {
      const { service, ws } = await setup();
      const item = await service.createWorkItem(ws, contract);
      const other = await service.createWorkItem(ws, contract);
      const action = await service.createAction(ws, { kind, role, ownerKey: role, workItemIds: [item.workItemId, other.workItemId], status: "running", stage: "execute", sessionId: "original", message: "Current process" });
      for (const [index, delay] of [1, 5, 30, 300].entries()) {
        const failed = await service.failAction(ws, action.actionId, `failure ${index + 1}`);
        expect(failed).toMatchObject({ actionId: action.actionId, status: "retry", attempts: index + 1, sessionId: "original", stage: "execute", retryAt: new Date(Date.parse(now) + delay * 60000).toISOString() });
        expect(await service.listDecisions(ws)).toEqual([]);
      }
      expect(await service.failAction(ws, action.actionId, "failure 5")).toMatchObject({ status: "decision", attempts: 5 });
      await service.failAction(ws, action.actionId, "duplicate failure notification");
      const cards = await service.listDecisions(ws);
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card).toMatchObject({ actionId: action.actionId, kind: "attempts", sessionId: "original" });
      expect(card.context).toContain("failure 5");
      expect(card.details).toContain(other.workItemId);
      await service.answerDecision(ws, card.decisionId, { key: "retry" });
      const resumed = (await service.listActions(ws)).find((a) => a.actionId === action.actionId)!;
      expect(resumed).toMatchObject({ attempts: 0, idleTurns: 0, status: "pending", sessionId: "original", stage: "deliver" });
      expect(resumed.retryAt).toBeUndefined();
      expect(resumed.failure).toBeUndefined();
      expect((await service.failAction(ws, action.actionId, "new attempt")).retryAt).toBe(new Date(Date.parse(now) + 60000).toISOString());
      if (role !== "worker") expect((await service.getWorkItem(ws, item.workItemId)).run.attempts).toBeUndefined();
    }
  );

  it("withdraws only the originator's card without inventing an answer or clearing another card or contract", async () => {
    const { service, ws } = await setup();
    const item = await service.createWorkItem(ws, contract);
    await service.escalateWorkItem(ws, item.workItemId, "Contract unclear", { requiredChanges: ["objective"] });
    const action = (await service.listActions(ws)).find((a) => a.kind === "contract")!;
    await service.putAction(ws, { ...action, sessionId: "steward" });
    const input = { actionId: action.actionId, workItemId: item.workItemId, sessionId: "steward", question: "Choose", context: "Need choice", options: [{ key: "yes", label: "Yes", detail: "Accept" }] };
    const first = await service.createDecision(ws, input);
    const second = await service.createDecision(ws, input);
    await expect(service.withdrawDecision(ws, first.decisionId, "someone-else", "Obsolete")).rejects.toThrow();
    const withdrawn = await service.withdrawDecision(ws, first.decisionId, "steward", "Already clarified");
    expect(withdrawn.answer).toBeUndefined();
    expect(withdrawn.withdrawn).toMatchObject({ sessionId: "steward", reason: "Already clarified" });
    expect((await service.listDecisions(ws)).find((c) => c.decisionId === second.decisionId)).toEqual(second);
    expect((await service.listActions(ws)).find((a) => a.actionId === action.actionId)?.status).toBe("decision");
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
    await service.withdrawDecision(ws, second.decisionId, "steward", "Clarified too");
    const resumed = (await service.listActions(ws)).find((a) => a.actionId === action.actionId)!;
    expect(resumed).toMatchObject({ status: "pending", sessionId: "steward", stage: "deliver" });
    expect(resumed.history.filter((h) => h.event === "decision.answered")).toEqual([]);
    expect(await service.isWorkItemBlocked(ws, item.workItemId)).toBe(true);
  });

  it("retains two verified results during one dirty-workspace repair, checks reality, merges and cleans up", async () => {
    const { root, service, ws } = await setup();
    await writeFile(join(root, "owned-dirty.txt"), "base\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "base");
    const mainHead = await git(root, "rev-parse", "HEAD");
    const items = [];
    for (const filename of ["first.txt", "second.txt"]) {
      const item = await service.createWorkItem(ws, { ...contract, scope: { ...contract.scope, allowedPaths: [filename] } });
      const branch = `vermillion/${item.workItemId}`;
      const worktreePath = join(root, ".vermillion", "worktrees", item.workItemId);
      await git(root, "worktree", "add", "-b", branch, worktreePath, "HEAD");
      await writeFile(join(worktreePath, filename), `${filename} result\n`);
      await git(worktreePath, "add", filename);
      await git(worktreePath, "commit", "-qm", filename);
      await service.startWorkItem(ws, item.workItemId, { branch, worktreePath, sessionId: filename });
      items.push({ ...item, branch, worktreePath, filename, head: (await git(worktreePath, "rev-parse", "HEAD")).trim() });
    }
    await writeFile(join(root, "owned-dirty.txt"), "test-owned uncommitted edit\n");
    for (const item of items) {
      expect(await service.submitWorkItem(ws, item.workItemId, submission)).toMatchObject({ status: "merging", ...submission });
    }
    const repairs = (await service.listActions(ws)).filter((a) => a.kind === "repair" && actionIsOpen(a));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.workItemIds.sort()).toEqual(items.map((i) => i.workItemId).sort());
    const repair = await service.putAction(ws, { ...repairs[0]!, sessionId: "repair", status: "running" });
    const report = { sessionId: "repair", summary: "Workspace repaired", evidence: ["Checked main workspace"] };
    const failed = await service.submitWorkspaceRepair(ws, repair.actionId, report);
    expect(failed.pass).toBe(false);
    expect(failed.action.actionId).toBe(repair.actionId);
    expect(failed.action.history.some((h) => h.event === "repair.check.failed")).toBe(true);
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainHead);
    expect(await readFile(join(root, "owned-dirty.txt"), "utf8")).toBe("test-owned uncommitted edit\n");
    for (const item of items) {
      expect(await service.getWorkItem(ws, item.workItemId)).toMatchObject({ status: "merging", ...submission, rejections: [], run: { branch: item.branch, worktreePath: item.worktreePath } });
      expect((await git(item.worktreePath, "rev-parse", "HEAD")).trim()).toBe(item.head);
    }
    // This file and its uncommitted edit were created solely by this test.
    await writeFile(join(root, "owned-dirty.txt"), "base\n");
    expect((await service.submitWorkspaceRepair(ws, repair.actionId, report)).pass).toBe(true);
    for (const item of items) {
      const closed = await service.getWorkItem(ws, item.workItemId);
      expect(closed).toMatchObject({ status: "closed", ...submission, rejections: [] });
      expect(closed.run.worktreePath).toBeUndefined();
      expect(closed.run.branch).toBeUndefined();
      expect(await readFile(join(root, item.filename), "utf8")).toBe(`${item.filename} result\n`);
      await git(root, "merge-base", "--is-ancestor", item.head, "HEAD");
      await expect(access(item.worktreePath)).rejects.toThrow();
      expect(await git(root, "branch", "--list", item.branch)).toBe("");
    }
    expect((await service.listActions(ws)).filter((a) => ["repair", "integration"].includes(a.kind) && actionIsOpen(a))).toEqual([]);
    expect((await git(root, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await service.listDecisions(ws)).toEqual([]);
  });
});
