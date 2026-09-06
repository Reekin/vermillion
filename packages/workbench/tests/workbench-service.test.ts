import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchEvent } from "../src/contracts.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const defaultsDir = new URL("../roles/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const dirs: string[] = [];
const services: WorkbenchService[] = [];

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-ws-"));
  const globalDir = await mkdtemp(join(tmpdir(), "verm-roles-"));
  dirs.push(root, globalDir);
  const roles = new RoleService({ globalDir, defaultsDir });
  await roles.ensureGlobal();
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
  services.push(service);
  const events: WorkbenchEvent[] = [];
  service.subscribe((event) => events.push(event));
  const ws = await service.addWorkspace({ rootPath: root, label: "Demo" });
  return { service, ws, events };
};

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const seedMission = async (service: WorkbenchService, workspaceId: string, name = "M") => {
  await service.writeDoc(workspaceId, ".vermillion/docs/" + name + ".md", "# " + name + "\n");
  return service.createMission(workspaceId, { title: name, summary: "" });
};

const baseWorkItem = (missionId: string) => ({
  missionId,
  title: "W",
  objective: "do it",
  risk: "R2" as const,
  refs: [],
  scope: { inScope: [], outOfScope: [], allowedPaths: [] },
  acceptance: [{ text: "t" }]
});

describe("WorkbenchService", () => {
  it("registers a workspace and emits workspaces.changed", async () => {
    const { service, ws, events } = await setup();
    expect(ws.label).toBe("Demo");
    expect(await service.listDocs(ws.workspaceId)).toEqual([]);
    expect(events).toEqual([{ type: "workspaces.changed" }]);
  });

  it("resolves role prompts workspace override -> global and emits roles.changed", async () => {
    const { service, ws, events } = await setup();
    expect((await service.listRoles(ws.workspaceId)).map((r) => r.roleId)).toContain("design-partner");
    expect((await service.readRole(ws.workspaceId, "worker")).source).toBe("global");
    await service.writeRoleOverride(ws.workspaceId, "worker", "# W\ncustom\n");
    expect(await service.readRole(ws.workspaceId, "worker")).toEqual({ content: "# W\ncustom\n", source: "workspace" });
    expect((await service.listRoles(ws.workspaceId)).find((r) => r.roleId === "worker")).toEqual({ roleId: "worker", title: "W", source: "workspace" });
    await service.resetRoleOverride(ws.workspaceId, "worker");
    expect((await service.readRole(ws.workspaceId, "worker")).source).toBe("global");
    expect(events.filter((e) => e.type === "roles.changed")).toHaveLength(2);
  });

  it("creates a mission from already committed docs, pointing the revision at HEAD", async () => {
    const { service, ws } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/a.md", "# a\n");
    const committed = await service.commitDocs(ws.workspaceId, { message: "a" });
    const mission = await service.createMission(ws.workspaceId, { title: "A", summary: "", paths: [".vermillion/docs/a.md"] });
    expect(mission.revisions[0]).toMatchObject({ commit: committed.commit, paths: [".vermillion/docs/a.md"] });
    await expect(service.createMission(ws.workspaceId, { title: "B", summary: "", paths: [] })).rejects.toThrow("at least one");
  });

  it("approve merges the worker's worktree branch into the workspace and removes it", async () => {
    const { service, ws } = await setup();
    const root = await service.workspaceRoot(ws.workspaceId);
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/a.md", "# a\n");
    const mission = await service.createMission(ws.workspaceId, { title: "A", summary: "" });
    const item = await service.createWorkItem(ws.workspaceId, { ...baseWorkItem(mission.missionId), scope: { inScope: [], outOfScope: [], allowedPaths: ["out.txt"] } });
    const worktreePath = join(root, ".vermillion", "worktrees", item.workItemId);
    await mkdir(join(root, ".vermillion", "worktrees"), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", "vermillion/" + item.workItemId, worktreePath, "HEAD"], { cwd: root });
    await writeFile(join(worktreePath, "out.txt"), "done\n");
    await service.startWorkItem(ws.workspaceId, item.workItemId, { worktreePath, branch: "vermillion/" + item.workItemId });
    await service.submitWorkItem(ws.workspaceId, item.workItemId, { evidence: { summary: "", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { items: [], verdict: "pass" } });
    const approved = await service.approveWorkItem(ws.workspaceId, item.workItemId);
    expect(approved.status).toBe("closed");
    expect(approved.run.worktreePath).toBeUndefined();
    expect((await readFile(join(root, "out.txt"), "utf8")).trim()).toBe("done");
    expect((await execFileAsync("git", ["worktree", "list"], { cwd: root })).stdout.trim().split("\n")).toHaveLength(1);
    // state dirs stay out of git; only docs are tracked
    const status = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout;
    expect(status).not.toContain("workitems/");
  });

  it("parks an item on a decision card after the third failure; retry resets, cancel closes", async () => {
    const { service, ws } = await setup();
    const item = await service.createWorkItem(ws.workspaceId, { title: "Flaky", objective: "o", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "t" }] });
    await service.requeueWorkItem(ws.workspaceId, item.workItemId, "one");
    await service.requeueWorkItem(ws.workspaceId, item.workItemId, "two");
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("queued");
    const parked = await service.requeueWorkItem(ws.workspaceId, item.workItemId, "three");
    expect(parked.status).toBe("decision");
    const card = (await service.listDecisions(ws.workspaceId)).find((c) => c.workItemId === item.workItemId && !c.answer)!;
    expect(card.kind).toBe("attempts");
    expect(card.context).toContain("three");
    await service.answerDecision(ws.workspaceId, card.decisionId, { key: "retry" });
    const retried = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(retried.status).toBe("queued");
    expect(retried.run.attempts).toBe(0);
    for (const f of ["a", "b", "c"]) await service.requeueWorkItem(ws.workspaceId, item.workItemId, f);
    const card2 = (await service.listDecisions(ws.workspaceId)).find((c) => c.workItemId === item.workItemId && !c.answer)!;
    await service.answerDecision(ws.workspaceId, card2.decisionId, { key: "cancel" });
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("cancelled");
  });

  it("rejects doc paths outside .vermillion/docs", async () => {
    const { service, ws } = await setup();
    await expect(service.writeDoc(ws.workspaceId, "docs/x.md", "x")).rejects.toThrow(/\.vermillion\/docs/);
  });

  it("reports pending changes for CJK paths without touching the index", async () => {
    const { service, ws } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/规格/登录.md", "# 登录\n");
    const pending = await service.pendingDocChanges(ws.workspaceId);
    expect(pending).toEqual([{ path: ".vermillion/docs/规格/登录.md", status: "added" }]);
    expect(await service.pendingDocChanges(ws.workspaceId)).toEqual(pending);
  });

  it("creates a mission by committing pending docs and binds the commit", async () => {
    const { service, ws, events } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/specs/login.md", "# Login\n");
    const mission = await service.createMission(ws.workspaceId, { title: "Login", summary: "Add login" });
    expect(mission.revisions).toHaveLength(1);
    expect(mission.revisions[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(mission.revisions[0]!.paths).toEqual([".vermillion/docs/specs/login.md"]);
    expect(await service.pendingDocChanges(ws.workspaceId)).toEqual([]);
    expect(events.map((e) => e.type)).toContain("missions.changed");
  });

  it("commits only the selected paths and appends later changes as revisions", async () => {
    const { service, ws } = await setup();
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/a.md", "a\n");
    await service.writeDoc(ws.workspaceId, ".vermillion/docs/b.md", "b\n");
    const mission = await service.createMission(ws.workspaceId, { title: "A", summary: "", paths: [".vermillion/docs/a.md"] });
    expect(mission.revisions[0]!.paths).toEqual([".vermillion/docs/a.md"]);
    expect((await service.pendingDocChanges(ws.workspaceId)).map((c) => c.path)).toEqual([".vermillion/docs/b.md"]);
    const revised = await service.addMissionRevision(ws.workspaceId, { missionId: mission.missionId, message: "add b", sessionId: "s-2" });
    expect(revised.revisions).toHaveLength(2);
    expect(revised.revisions[1]).toMatchObject({ message: "add b", paths: [".vermillion/docs/b.md"], sessionId: "s-2" });
    expect(revised.revisions[1]!.commit).not.toBe(revised.revisions[0]!.commit);
    expect(await service.pendingDocChanges(ws.workspaceId)).toEqual([]);
  });

  it("walks a work item through start, submit, reject with reason, resubmit, approve", async () => {
    const { service, ws } = await setup();
    const mission = await seedMission(service, ws.workspaceId);
    const item = await service.createWorkItem(ws.workspaceId, baseWorkItem(mission.missionId));
    expect(item.status).toBe("queued");
    expect(item.autoClose).toBe(false);

    const started = await service.startWorkItem(ws.workspaceId, item.workItemId, { sessionId: "s-1", branch: "wi/1" });
    expect(started.status).toBe("running");
    expect(started.run.sessionId).toBe("s-1");

    await service.heartbeatWorkItem(ws.workspaceId, item.workItemId, "turn-9");
    const submitted = await service.submitWorkItem(ws.workspaceId, item.workItemId, {
      evidence: { summary: "done", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
      review: [{ comment: "add guard", decision: "rejected", reason: "out of scope" }],
      verify: { items: [{ index: 0, pass: true, evidence: "screenshot" }], verdict: "pass" }
    });
    expect(submitted.status).toBe("review");
    expect(submitted.run.sessionId).toBe("s-1");
    expect(submitted.run.lastTurnId).toBe("turn-9");
    expect((await service.listInbox()).map((i) => i.kind)).toEqual(["review"]);

    const rejected = await service.rejectWorkItem(ws.workspaceId, item.workItemId, "边界没处理");
    expect(rejected.status).toBe("queued");
    expect(rejected.rejections.map((r) => r.reason)).toEqual(["边界没处理"]);

    await service.submitWorkItem(ws.workspaceId, item.workItemId, {
      evidence: { summary: "fixed", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
      review: [],
      verify: { items: [{ index: 0, pass: true, evidence: "ok" }], verdict: "pass" }
    });
    const approved = await service.approveWorkItem(ws.workspaceId, item.workItemId);
    expect(approved.status).toBe("closed");
    expect(await service.listInbox()).toEqual([]);
  });

  it("auto-closes low-risk items on a passing verify and re-queues on rework", async () => {
    const { service, ws } = await setup();
    const mission = await seedMission(service, ws.workspaceId);
    const low = await service.createWorkItem(ws.workspaceId, { ...baseWorkItem(mission.missionId), risk: "R1" });
    const evidence = { summary: "", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] };
    const closed = await service.submitWorkItem(ws.workspaceId, low.workItemId, { evidence, review: [], verify: { items: [], verdict: "pass" } });
    expect(closed.status).toBe("closed");
    const high = await service.createWorkItem(ws.workspaceId, baseWorkItem(mission.missionId));
    const rework = await service.submitWorkItem(ws.workspaceId, high.workItemId, { evidence, review: [], verify: { items: [], verdict: "rework" } });
    expect(rework.status).toBe("queued");
  });

  it("parks a work item on a decision card and resumes it with the answer recorded", async () => {
    const { service, ws, events } = await setup();
    const mission = await seedMission(service, ws.workspaceId);
    const created = await service.createWorkItem(ws.workspaceId, baseWorkItem(mission.missionId));
    const item = await service.startWorkItem(ws.workspaceId, created.workItemId, { sessionId: "s1" });
    const card = await service.createDecision(ws.workspaceId, {
      question: "A or B?",
      context: "",
      options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      recommended: "a",
      workItemId: item.workItemId
    });
    expect((await service.getWorkItem(ws.workspaceId, item.workItemId)).status).toBe("decision");
    expect((await service.listInbox()).map((i) => i.kind)).toEqual(["decision"]);
    await service.answerDecision(ws.workspaceId, card.decisionId, { key: "a", note: "keep it simple" });
    const resumed = await service.getWorkItem(ws.workspaceId, item.workItemId);
    expect(resumed.status).toBe("queued");
    expect(resumed.decisions).toEqual(["A or B? -> A (keep it simple)"]);
    expect(events.filter((e) => e.type === "decisions.changed")).toHaveLength(2);
  });

  it("accepts a free answer (note only) and rejects an empty one", async () => {
    const { service, ws } = await setup();
    const mission = await seedMission(service, ws.workspaceId);
    const created = await service.createWorkItem(ws.workspaceId, baseWorkItem(mission.missionId));
    await service.startWorkItem(ws.workspaceId, created.workItemId, { sessionId: "s1" });
    const card = await service.createDecision(ws.workspaceId, { question: "A or B?", context: "", options: [{ key: "a", label: "A" }], workItemId: created.workItemId });
    await expect(service.answerDecision(ws.workspaceId, card.decisionId, { note: "  " })).rejects.toThrow(/option key or a note/);
    await expect(service.answerDecision(ws.workspaceId, card.decisionId, { key: "zzz" })).rejects.toThrow(/Unknown option/);
    const answered = await service.answerDecision(ws.workspaceId, card.decisionId, { note: "先做 A 的一半，B 不要" });
    expect(answered.answer?.key).toBeUndefined();
    const resumed = await service.getWorkItem(ws.workspaceId, created.workItemId);
    expect(resumed.status).toBe("queued");
    expect(resumed.decisions).toEqual(["A or B? -> 备注：先做 A 的一半，B 不要"]);
    expect((await service.listInbox()).length).toBe(0);
  });

  it("appends contract adjustments to the unanswered card of a parked item and delivers them with the answer", async () => {
    const { service, ws, events } = await setup();
    const mission = await seedMission(service, ws.workspaceId);
    const created = await service.createWorkItem(ws.workspaceId, baseWorkItem(mission.missionId));
    await service.startWorkItem(ws.workspaceId, created.workItemId, { sessionId: "s1" });
    const card = await service.createDecision(ws.workspaceId, { question: "A or B?", context: "", options: [{ key: "a", label: "A" }], workItemId: created.workItemId });
    const before = events.length;
    const updated = await service.updateWorkItem(ws.workspaceId, created.workItemId, { objective: "v2", note: "范围收窄到 A" });
    expect(updated.status).toBe("decision"); // still waiting for the answer
    expect(events.slice(before).map((e) => e.type)).toEqual(["workItems.changed", "decisions.changed"]);
    expect(events.slice(before).some((e) => e.type === "workItem.updated")).toBe(false); // no worker to steer while parked
    const parked = (await service.listDecisions(ws.workspaceId)).find((c) => c.decisionId === card.decisionId)!;
    expect(parked.adjustments?.map((a) => a.note)).toEqual(["范围收窄到 A"]);
    expect(parked.answer).toBeUndefined();
    await service.answerDecision(ws.workspaceId, card.decisionId, { key: "a", note: "ok" });
    const resumed = await service.getWorkItem(ws.workspaceId, created.workItemId);
    expect(resumed.status).toBe("queued");
    expect(resumed.decisions).toEqual(["A or B? -> A (ok)；挂起期间工单调整：范围收窄到 A"]); // recorded once, inside the answer
  });
});
