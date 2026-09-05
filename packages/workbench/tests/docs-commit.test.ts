import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchEvent } from "../src/contracts.js";
import { DocsService } from "../src/docs.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { createWorkbenchClient } from "../src/rpc.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const execFileAsync = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await execFileAsync("git", args, { cwd: root })).stdout;
const a = ".vermillion/docs/规格/A.md";
const b = ".vermillion/docs/B.md";
const dirs: string[] = [];
const services: WorkbenchService[] = [];

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-doc-commit-"));
  dirs.push(root);
  const service = new WorkbenchService({
    workspaces: createMemoryWorkspaceSource(),
    roles: new RoleService({ globalDir: join(root, "roles") })
  });
  services.push(service);
  const { workspaceId } = await service.addWorkspace({ rootPath: root });
  const handler = createWorkbenchRpcHandler(service);
  const client = createWorkbenchClient({ request: handler, onEvent: (listener) => service.subscribe(listener) });
  return { root, service, workspaceId, handler, client };
};

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

describe("ordinary doc commits with real Git", () => {
  it("commits only A, preserves staged B/outside docs, and keeps old refs while later revisions inherit A", async () => {
    const { root, service, workspaceId, client } = await setup();
    await service.writeDoc(workspaceId, a, "A original\n");
    await service.writeDoc(workspaceId, b, "B original\n");
    const mission = await service.createMission(workspaceId, { title: "Initial", summary: "" });
    const ref = { path: a, commit: mission.revisions[0]!.commit };
    const item = await service.createWorkItem(workspaceId, {
      missionId: mission.missionId, title: "Existing worker", objective: "Keep original A", risk: "R2",
      refs: [ref], scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: []
    });
    await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "existing-worker" });
    const missionsBefore = await service.listMissions(workspaceId);
    const itemsBefore = await service.listWorkItems(workspaceId);
    const runsBefore = await service.listRuns(workspaceId);

    await service.writeDoc(workspaceId, a, "A saved independently\n");
    await service.writeDoc(workspaceId, b, "B staged\n");
    await writeFile(join(root, "outside.txt"), "outside staged\n");
    await git(root, "add", "--", b, "outside.txt");
    await service.writeDoc(workspaceId, b, "B working\n");
    const stagedBefore = await git(root, "diff", "--cached", "--", b, "outside.txt");
    // Flush notifications from the setup writes before observing the commit itself.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const events: WorkbenchEvent[] = [];
    client.subscribe((event) => events.push(event));

    const result = await client.request("docs.commit", { workspaceId, message: "  保存 A  \n", paths: [a] });
    expect(result).toEqual({ commit: (await git(root, "rev-parse", "HEAD")).trim(), message: "保存 A" });
    expect((await git(root, "show", "-s", "--format=%B", result.commit)).trim()).toBe(result.message);
    expect((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", result.commit)).split("\0").filter(Boolean)).toEqual([a]);
    expect(await git(root, "diff", "--cached", "--", b, "outside.txt")).toBe(stagedBefore);
    expect(await readFile(join(root, b), "utf8")).toBe("B working\n");
    expect(await service.pendingDocChanges(workspaceId)).toEqual([{ path: b, status: "modified" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual([{ type: "docs.changed", workspaceId }]);
    expect(await service.listMissions(workspaceId)).toEqual(missionsBefore);
    expect(await service.listWorkItems(workspaceId)).toEqual(itemsBefore);
    expect(await service.listRuns(workspaceId)).toEqual(runsBefore);

    const revised = await client.request("mission.addRevision", { workspaceId, missionId: mission.missionId, message: "Commit B" });
    const revision = revised.revisions[1]!;
    expect(revision.paths).toEqual([b]);
    expect(await client.request("docs.read", { workspaceId, path: a, commit: revision.commit })).toEqual({ content: "A saved independently\n" });
    expect(await client.request("docs.read", { workspaceId, ...ref })).toEqual({ content: "A original\n" });
    expect((await service.getWorkItem(workspaceId, item.workItemId)).refs).toEqual([ref]);
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("outside.txt\n");
    expect(await client.request("docs.read", { workspaceId, path: a })).toEqual({ content: "A saved independently\n" });
  });

  it("rejects explicit empty paths in every entry point without committing or changing the index", async () => {
    const { root, service, workspaceId, handler } = await setup();
    await service.writeDoc(workspaceId, a, "original\n");
    const mission = await service.createMission(workspaceId, { title: "Initial", summary: "" });
    await service.writeDoc(workspaceId, a, "pending\n");
    await writeFile(join(root, "outside.txt"), "staged\n");
    await git(root, "add", "outside.txt");
    const headBefore = await git(root, "rev-parse", "HEAD");
    const indexBefore = await git(root, "ls-files", "--stage");
    const inputs = [
      { method: "docs.commit", params: { workspaceId, message: "Save", paths: [] } },
      { method: "mission.create", params: { workspaceId, title: "New", summary: "", paths: [] } },
      { method: "mission.addRevision", params: { workspaceId, missionId: mission.missionId, message: "More", paths: [] } }
    ];
    for (const input of inputs) expect((await handler(input)).ok).toBe(false);
    await expect(service.commitDocs(workspaceId, { message: "Save", paths: [] })).rejects.toThrow(/at least one/);
    await expect(service.createMission(workspaceId, { title: "New", summary: "", paths: [] })).rejects.toThrow(/at least one/);
    await expect(service.addMissionRevision(workspaceId, { missionId: mission.missionId, message: "More", paths: [] })).rejects.toThrow(/at least one/);
    await expect(new DocsService(root).commit("Save", [])).rejects.toThrow(/at least one/);
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(root, "ls-files", "--stage")).toBe(indexBefore);
    expect(await service.listMissions(workspaceId)).toEqual([mission]);
    expect(await service.pendingDocChanges(workspaceId)).toEqual([{ path: a, status: "modified" }]);
  });

  it("defaults omitted paths to pending docs and leaves failed requests recoverable", async () => {
    const { root, service, workspaceId, client } = await setup();
    await service.writeDoc(workspaceId, a, "new A\n");
    await service.writeDoc(workspaceId, b, "new B\n");
    await writeFile(join(root, "outside.txt"), "staged\n");
    await git(root, "add", "outside.txt");
    await expect(client.request("docs.commit", { workspaceId, message: " \n " })).rejects.toThrow();
    await expect(service.commitDocs(workspaceId, { message: " \n " })).rejects.toThrow(/message is required/);
    await expect(client.request("docs.commit", { workspaceId, message: "Missing", paths: [".vermillion/docs/missing.md"] })).rejects.toThrow(/No pending/);
    const committed = await client.request("docs.commit", { workspaceId, message: "All docs" });
    expect((await git(root, "ls-tree", "-r", "--name-only", "-z", committed.commit)).split("\0").filter(Boolean).sort()).toEqual([a, b].sort());
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("outside.txt\n");
    expect(await service.listMissions(workspaceId)).toEqual([]);
    expect(await service.listWorkItems(workspaceId)).toEqual([]);
    await expect(client.request("docs.commit", { workspaceId, message: "Again" })).rejects.toThrow(/No pending/);
    expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(committed.commit);
  });
});
