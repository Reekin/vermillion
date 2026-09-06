import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { createWorkbenchClient } from "../src/rpc.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd })).stdout;
const commit = async (cwd: string, message: string) => {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-qm", message);
};
const dirs: string[] = [];
const services: WorkbenchService[] = [];
const files = ["output.txt", "中文 文件.txt"];
const submission = {
  evidence: { summary: "rebased result", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
  review: [{ comment: "Keep scope", decision: "accepted" as const, reason: "Covered" }],
  verify: { items: [{ index: 0, pass: true, evidence: "real Git" }], verdict: "pass" as const }
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-merge-"));
  dirs.push(root);
  const service = new WorkbenchService({
    workspaces: createMemoryWorkspaceSource(), roles: new RoleService({ globalDir: join(root, ".vermillion", "roles") })
  });
  services.push(service);
  const { workspaceId } = await service.addWorkspace({ rootPath: root });
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "user.name", "Merge test");
  await git(root, "config", "user.email", "merge@local");
  for (const file of files) await writeFile(join(root, file), "base\n");
  await commit(root, "base");
  const client = createWorkbenchClient({ request: createWorkbenchRpcHandler(service), onEvent: (listener) => service.subscribe(listener) });
  const item = await client.request("workItem.create", {
    workspaceId, title: "Merge work", objective: "Resolve on worker branch", risk: "R2",
    scope: { inScope: [], outOfScope: [], allowedPaths: [...files, "retained.txt"] }, acceptance: [{ text: "Changes merged" }]
  });
  const workItemId = item.workItemId;
  const branch = "vermillion/" + workItemId;
  const worktreePath = join(root, ".vermillion", "worktrees", workItemId);
  await git(root, "worktree", "add", "-b", branch, worktreePath);
  await service.startWorkItem(workspaceId, workItemId, { sessionId: "original-worker", branch, worktreePath });
  for (const file of files) await writeFile(join(worktreePath, file), "worker\n");
  await writeFile(join(worktreePath, "retained.txt"), "previous work\n");
  await commit(worktreePath, "worker result");
  return { root, service, client, workspaceId, workItemId, branch, worktreePath };
};

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

describe("work item merge conflict loop with real Git and RPC", { timeout: 30000 }, () => {
  it("rebases, submits, rejects conflicts with paths, then accepts the resolved resubmission and cleans up", async () => {
    const { root, service, client, workspaceId, workItemId, branch, worktreePath } = await setup();
    const params = { workspaceId, workItemId };
    await writeFile(join(root, "upstream.txt"), "upstream\n");
    await commit(root, "upstream advance before submission");
    const base = (await git(root, "rev-parse", "HEAD")).trim();
    await git(worktreePath, "rebase", base);
    await git(worktreePath, "merge-base", "--is-ancestor", base, "HEAD");
    const submitted = await client.request("workItem.submit", { ...params, ...submission });
    expect(submitted.status).toBe("review");
    expect(await client.request("workItem.get", params)).toMatchObject({ ...submission, status: "review" });
    expect((await service.listInbox()).map((entry) => entry.kind)).toEqual(["review"]);
    const workerHead = await git(worktreePath, "rev-parse", "HEAD");

    // The workspace moves after review was requested; accepting now encounters real conflicts.
    for (const file of files) await writeFile(join(root, file), "upstream edit\n");
    await commit(root, "advance during review");
    const mainHead = await git(root, "rev-parse", "HEAD");
    const rejected = await client.request("workItem.approve", params);
    expect(rejected.status).toBe("queued");
    expect(rejected.rejections).toHaveLength(1);
    for (const file of files) expect(rejected.rejections[0]!.reason).toContain("- " + file);
    expect(rejected.rejections[0]!.reason).toContain("rebase");
    expect(rejected.run).toMatchObject({ sessionId: "original-worker", branch, worktreePath });
    expect(await git(worktreePath, "rev-parse", "HEAD")).toBe(workerHead);
    expect(await readFile(join(worktreePath, "retained.txt"), "utf8")).toBe("previous work\n");
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainHead);
    expect(await git(root, "status", "--porcelain")).toBe("");
    await expect(git(root, "rev-parse", "--verify", "MERGE_HEAD")).rejects.toThrow();
    expect(await service.listDecisions(workspaceId)).toEqual([]);

    // Worker actions stay entirely in the retained branch and worktree.
    await service.startWorkItem(workspaceId, workItemId, { sessionId: "original-worker" });
    await expect(git(worktreePath, "rebase", mainHead.trim())).rejects.toThrow();
    for (const file of files) await writeFile(join(worktreePath, file), "upstream edit\nworker resolved\n");
    await git(worktreePath, "add", "--", ...files);
    await git(worktreePath, "-c", "core.editor=true", "rebase", "--continue");
    await git(worktreePath, "merge-base", "--is-ancestor", mainHead.trim(), "HEAD");
    const updated = { ...submission, evidence: { ...submission.evidence, summary: "resolved and verified" } };
    const resubmitted = await client.request("workItem.submit", { ...params, ...updated });
    expect(resubmitted).toMatchObject({ ...updated, status: "review" });
    expect((await service.listInbox()).map((entry) => entry.kind)).toEqual(["review"]);
    const approved = await client.request("workItem.approve", params);
    expect(approved.status).toBe("closed");
    expect(approved.run.worktreePath).toBeUndefined();
    expect(approved.run.branch).toBeUndefined();
    for (const file of files) expect(await readFile(join(root, file), "utf8")).toBe("upstream edit\nworker resolved\n");
    expect(await readFile(join(root, "retained.txt"), "utf8")).toBe("previous work\n");
    await expect(access(worktreePath)).rejects.toThrow();
    expect(await git(root, "branch", "--list", branch)).toBe("");
    expect(await service.listInbox()).toEqual([]);
  });

  it("keeps non-conflict Git errors as errors without rejecting or losing local workspace edits", async () => {
    const { root, service, client, workspaceId, workItemId, worktreePath } = await setup();
    const params = { workspaceId, workItemId };
    await client.request("workItem.submit", { ...params, ...submission });
    await writeFile(join(root, files[0]!), "unsaved user work\n");
    await expect(client.request("workItem.approve", params)).rejects.toThrow();
    expect(await service.getWorkItem(workspaceId, workItemId)).toMatchObject({ status: "review", rejections: [] });
    expect(await readFile(join(root, files[0]!), "utf8")).toBe("unsaved user work\n");
    await access(worktreePath);
  });

  it("preserves an unfinished user merge instead of treating it as a worker conflict", async () => {
    const { root, service, client, workspaceId, workItemId, worktreePath } = await setup();
    const params = { workspaceId, workItemId };
    await client.request("workItem.submit", { ...params, ...submission });
    await git(root, "checkout", "-b", "user-side");
    await writeFile(join(root, files[0]!), "user side\n");
    await commit(root, "user side");
    await git(root, "checkout", "-");
    await writeFile(join(root, files[0]!), "user main\n");
    await commit(root, "user main");
    await expect(git(root, "merge", "user-side")).rejects.toThrow();
    const mergeHead = await git(root, "rev-parse", "MERGE_HEAD");
    const index = await git(root, "ls-files", "--stage");
    const conflict = await readFile(join(root, files[0]!), "utf8");

    await expect(client.request("workItem.approve", params)).rejects.toThrow("主工作区存在尚未解决的冲突");
    expect(await service.getWorkItem(workspaceId, workItemId)).toMatchObject({ status: "review", rejections: [] });
    expect(await git(root, "rev-parse", "MERGE_HEAD")).toBe(mergeHead);
    expect(await git(root, "ls-files", "--stage")).toBe(index);
    expect(await readFile(join(root, files[0]!), "utf8")).toBe(conflict);
    await access(worktreePath);
  });
});
