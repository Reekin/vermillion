import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";

const dirs: string[] = [];
const scratch = async (name: string) => {
  const dir = await mkdtemp(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorkbenchService", () => {
  it("registers a workspace and initializes the docs repo", async () => {
    const source = createMemoryWorkspaceSource();
    const wsRoot = await scratch("verm-ws-");
    const service = new WorkbenchService({ workspaces: source });
    const ws = await service.addWorkspace({ rootPath: wsRoot, label: "Demo" });
    expect(ws.label).toBe("Demo");
    expect((await service.listWorkspaces()).map((w) => w.workspaceId)).toEqual([ws.workspaceId]);
    expect((await service.listDocs(ws.workspaceId)).map((d) => d.path)).toEqual(["docs/AGENTS.md"]);
  });

  it("rejects doc paths outside docs/", async () => {
    const source = createMemoryWorkspaceSource();
    const wsRoot = await scratch("verm-ws-");
    const service = new WorkbenchService({ workspaces: source });
    const ws = await service.addWorkspace({ rootPath: wsRoot });
    await expect(service.writeDoc(ws.workspaceId, "src/x.md", "x")).rejects.toThrow(/docs\//);
  });

  it("creates a mission by committing pending doc changes and binds the commit", async () => {
    const source = createMemoryWorkspaceSource();
    const wsRoot = await scratch("verm-ws-");
    const service = new WorkbenchService({ workspaces: source });
    const ws = await service.addWorkspace({ rootPath: wsRoot });
    await service.writeDoc(ws.workspaceId, "docs/specs/login.md", "# Login\n");
    const pending = await service.pendingDocChanges(ws.workspaceId);
    expect(pending.map((c) => [c.path, c.status])).toEqual([["docs/AGENTS.md", "added"], ["docs/specs/login.md", "added"]]);
    const mission = await service.createMission(ws.workspaceId, { title: "Login", summary: "Add login" });
    expect(mission.docCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await service.pendingDocChanges(ws.workspaceId)).toEqual([]);
    expect((await service.listMissions(ws.workspaceId))[0]?.missionId).toBe(mission.missionId);
  });

  it("surfaces unanswered decisions and review work items in the inbox", async () => {
    const source = createMemoryWorkspaceSource();
    const wsRoot = await scratch("verm-ws-");
    const service = new WorkbenchService({ workspaces: source });
    const ws = await service.addWorkspace({ rootPath: wsRoot });
    const mission = await service.createMission(ws.workspaceId, { title: "M", summary: "" });
    const item = await service.createWorkItem(ws.workspaceId, { missionId: mission.missionId, title: "W", risk: "R2" });
    expect(item.autoClose).toBe(false);
    await service.updateWorkItem(ws.workspaceId, item.workItemId, { status: "review" });
    const card = await service.createDecision(ws.workspaceId, {
      question: "A or B?",
      context: "",
      options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      recommended: "a",
      missionId: mission.missionId
    });
    expect((await service.listInbox()).map((i) => i.kind).sort()).toEqual(["decision", "review"]);
    await service.answerDecision(ws.workspaceId, card.decisionId, { key: "a" });
    await service.updateWorkItem(ws.workspaceId, item.workItemId, { status: "closed" });
    expect(await service.listInbox()).toEqual([]);
  });
});
