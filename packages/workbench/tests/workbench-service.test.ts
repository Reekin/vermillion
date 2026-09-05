import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchEvent } from "../src/contracts.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { WorkbenchService } from "../src/workbench-service.js";

const dirs: string[] = [];
const services: WorkbenchService[] = [];

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-ws-"));
  dirs.push(root);
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource() });
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

const baseWorkItem = (missionId: string) => ({
  missionId,
  title: "W",
  objective: "do it",
  risk: "R2" as const,
  refs: [],
  scope: { inScope: [], outOfScope: [], allowedPaths: [] },
  acceptance: [{ given: "g", when: "w", then: "t" }]
});

describe("WorkbenchService", () => {
  it("registers a workspace, seeds instructions, and emits workspaces.changed", async () => {
    const { service, ws, events } = await setup();
    expect(ws.label).toBe("Demo");
    expect(await service.listDocs(ws.workspaceId)).toEqual([]);
    expect(events).toEqual([{ type: "workspaces.changed" }]);
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
    expect(mission.docCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await service.pendingDocChanges(ws.workspaceId)).toEqual([]);
    expect(events.map((e) => e.type)).toContain("missions.changed");
  });

  it("walks a work item through start, submit, reject with reason, resubmit, approve", async () => {
    const { service, ws } = await setup();
    const mission = await service.createMission(ws.workspaceId, { title: "M", summary: "" });
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
    const mission = await service.createMission(ws.workspaceId, { title: "M", summary: "" });
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
    const mission = await service.createMission(ws.workspaceId, { title: "M", summary: "" });
    const item = await service.createWorkItem(ws.workspaceId, baseWorkItem(mission.missionId));
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
});
