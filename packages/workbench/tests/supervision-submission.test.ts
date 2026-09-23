import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { contract, git, setup, submission } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async () => { const f = await setup(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

it("keeps invalid root results running until the same Worker resubmits a valid commit", async () => {
  const { service, workspaceId, root } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker", scope: { ...contract.scope, allowedPaths: ["result.txt"] } });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await writeFile(join(root, "result.txt"), "result\n");
  const dirty = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: "worker" });
  expect(dirty).toMatchObject({ status: "running", run: { lastFailure: expect.stringContaining("未提交") } });
  expect((await service.listActions(workspaceId)).filter((action) => action.kind === "integration")).toEqual([]);
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ notices: [] });
  await git(root, "add", "result.txt");
  await git(root, "commit", "-qm", "Implement result");
  const commit = await git(root, "rev-parse", "HEAD");
  const missingCommit = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: "worker" });
  expect(missingCommit).toMatchObject({ status: "running", run: { lastFailure: expect.stringContaining("evidence.commit") } });
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: "worker", evidence: { ...submission.evidence, commit } });
  expect(closed).toMatchObject({ status: "closed", merge: { commit }, rejections: [{ reason: expect.stringContaining("未提交") }, { reason: expect.stringContaining("evidence.commit") }] });
  expect(closed.run.lastFailure).toBeUndefined();
  expect(closed.evidence?.commit).toBe(commit);
});

it("integration completion refreshes the branch target after the fixed Worker rebases", async () => {
  const { service, workspaceId, root } = await fixture();
  const base = await git(root, "rev-parse", "HEAD");
  const worktreePath = join(root, ".vermillion", "worktrees", "worker");
  await git(root, "worktree", "add", "-b", "work/result", worktreePath);
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker", worktreePath, branch: "work/result" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await writeFile(join(worktreePath, "result.txt"), "result\n");
  await git(worktreePath, "add", "result.txt");
  await git(worktreePath, "commit", "-qm", "Implement result");
  const originalTarget = await git(worktreePath, "rev-parse", "HEAD");
  const action = await service.createAction(workspaceId, { kind: "integration", workItemId: item.workItemId,
    status: "decision", stage: "merge", message: "Resolve integration", failure: "Rebase required",
    agent: { sessionId: "worker", requestedAt: new Date().toISOString() },
    integration: { operation: "merge", contractRevision: 0, before: base, target: originalTarget, diffStat: "original result" }
  }, (current) => ({ ...current, status: "merging" }));
  await writeFile(join(root, "independent.txt"), "main update\n");
  await git(root, "add", "independent.txt");
  await git(root, "commit", "-qm", "Independent main update");
  const newBase = await git(root, "rev-parse", "HEAD");
  await git(worktreePath, "rebase", newBase);
  const rebasedTarget = await git(worktreePath, "rev-parse", "HEAD");
  expect(rebasedTarget).not.toBe(originalTarget);
  const closed = await service.completeIntegration(workspaceId, item.workItemId, action.actionId, "worker");
  expect(closed.status).toBe("closed");
  expect((await service.listActions(workspaceId)).find((entry) => entry.actionId === action.actionId)).toMatchObject({
    status: "done", integration: { target: rebasedTarget, before: newBase }
  });
  expect((await readFile(join(root, "result.txt"), "utf8")).trim()).toBe("result");
  expect((await readFile(join(root, "independent.txt"), "utf8")).trim()).toBe("main update");
});
