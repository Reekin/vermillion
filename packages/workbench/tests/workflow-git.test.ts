import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { contract, git, setup, submission } from "./workflow-fixture.js";
import { DocsService } from "../src/docs.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async (now?: () => string) => { const f = await setup(now); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

it("commits selected docs without touching another staged file, advances refs and persists the exact notice", async () => {
  const { service, workspaceId, root } = await fixture();
  const path = ".vermillion/docs/中文 A.md", other = ".vermillion/docs/B.md";
  await service.writeDoc(workspaceId, path, "Before\n");
  await service.writeDoc(workspaceId, other, "Other\n");
  const initial = await service.commitDocs(workspaceId, { message: "Initial docs" });
  const item = await service.createWorkItem(workspaceId, { ...contract, refs: [{ path, commit: initial.commit }], sessionId: "worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });
  await service.writeDoc(workspaceId, path, "After\n");
  await service.writeDoc(workspaceId, other, "Staged other\n");
  await writeFile(join(root, "other.txt"), "staged outside\n");
  await git(root, "add", other, "other.txt");
  const staged = await git(root, "diff", "--cached");
  const committed = await service.commitDocs(workspaceId, { message: "Selected docs", paths: [path] });
  expect(await git(root, "diff", "--cached")).toBe(staged);
  const updated = await service.getWorkItem(workspaceId, item.workItemId);
  expect(updated.refs).toEqual([{ path, commit: committed.commit }]);
  expect(updated.run.resumeMessage).toContain("-Before");
  expect(updated.run.resumeMessage).toContain("+After");
  await service.setWorkItemStaleTurn(workspaceId, item.workItemId, "old-turn");
  expect(await service.submitWorkItem(workspaceId, item.workItemId, submission)).toMatchObject({ status: "queued", evidence: undefined });
  expect((await service.getWorkItem(workspaceId, item.workItemId)).run.resumeMessage).toContain("+After");
});

it("rejects empty docs selections without altering HEAD or the index", async () => {
  const { service, workspaceId, root, client } = await fixture();
  await service.writeDoc(workspaceId, ".vermillion/docs/A.md", "pending\n");
  const head = await git(root, "rev-parse", "HEAD");
  await expect(client.request("docs.commit", { workspaceId, message: "Empty", paths: [] })).rejects.toThrow();
  await expect(service.commitDocs(workspaceId, { message: "Empty", paths: [] })).rejects.toThrow("at least one");
  expect(await git(root, "rev-parse", "HEAD")).toBe(head);
  expect(await git(root, "diff", "--cached")).toBe("");
});

it("observes external Git commits through filesystem events and sends changed referenced docs", async () => {
  const { service, workspaceId, root } = await fixture();
  const path = ".vermillion/docs/external.md";
  await service.writeDoc(workspaceId, path, "before\n");
  const initial = await service.commitDocs(workspaceId, { message: "Initial" });
  const item = await service.createWorkItem(workspaceId, { ...contract, refs: [{ path, commit: initial.commit }], sessionId: "worker" });
  await writeFile(join(root, path), "external change\n");
  await git(root, "add", path); await git(root, "commit", "-qm", "External docs update");
  const head = await git(root, "rev-parse", "HEAD");
  await vi.waitFor(async () => expect((await service.getWorkItem(workspaceId, item.workItemId)).refs).toEqual([{ path, commit: head }]));
  expect((await service.getWorkItem(workspaceId, item.workItemId)).run.resumeMessage).toContain("+external change");
});

it("removes only an empty residual directory after Git already unregistered a worktree", async () => {
  const { root } = await fixture();
  const docs = new DocsService(root), path = join(root, ".vermillion", "worktrees", "residual");
  await mkdir(path, { recursive: true });
  await git(root, "branch", "work/residual");
  await writeFile(join(path, "keep.txt"), "unknown content");
  await expect(docs.dropWorktree(path, "work/residual")).rejects.toThrow("仍有内容");
  expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("unknown content");
  const empty = join(root, ".vermillion", "worktrees", "empty");
  await mkdir(empty); await git(root, "branch", "work/empty");
  await docs.dropWorktree(empty, "work/empty");
  await expect(access(empty)).rejects.toThrow();
});

it("returns a branch needing rebase to its original worker while preserving unrelated root edits", async () => {
  const { service, workspaceId, root } = await fixture();
  await writeFile(join(root, "result.txt"), "base\n");
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "base");
  const branch = "work/conflict", worktreePath = join(root, ".vermillion", "worktrees", "conflict");
  await git(root, "worktree", "add", "-b", branch, worktreePath);
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "original", branch, worktreePath });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "original" });
  await writeFile(join(worktreePath, "result.txt"), "worker\n");
  await git(worktreePath, "add", "result.txt"); await git(worktreePath, "commit", "-qm", "worker");
  await writeFile(join(root, "result.txt"), "upstream\n");
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "upstream");
  await writeFile(join(root, "unrelated.txt"), "keep me\n");
  const result = await service.submitWorkItem(workspaceId, item.workItemId, submission);
  expect(result).toMatchObject({ status: "queued", run: { sessionId: "original", worktreePath, branch } });
  expect(result.rejections[0]?.reason).toContain("rebase");
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("keep me\n");
});

it("records and rolls back a root execution commit rather than treating code work as a pure operation", async () => {
  const { service, workspaceId, root } = await fixture();
  const release = vi.fn(async () => {});
  service.setWorkerEnvironmentReleaser(release);
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "root-worker", scope: { ...contract.scope, allowedPaths: ["result.txt"] } });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "root-worker" });
  await writeFile(join(root, "result.txt"), "result\n");
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "root result");
  const commit = await git(root, "rev-parse", "HEAD");
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, evidence: { ...submission.evidence, commit } });
  expect(closed).toMatchObject({ status: "closed", merge: { commit } });
  expect(release).not.toHaveBeenCalled();
  await service.releaseIdleWorkers(workspaceId);
  expect(release).toHaveBeenCalledWith("root-worker");
  expect(closed.merge?.diffStat).toContain("result.txt");
  await service.rollbackWorkItem(workspaceId, item.workItemId, "Remove result");
  await expect(access(join(root, "result.txt"))).rejects.toThrow();
});

it("releases a cancelled root worker after its active turn ends", async () => {
  const { service, workspaceId } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "root-worker" });
  let active = true;
  const release = vi.fn(async () => {});
  service.setWorkerActiveChecker(() => active);
  service.setWorkerEnvironmentReleaser(release);
  await service.cancelWorkItem(workspaceId, item.workItemId);
  expect(release).not.toHaveBeenCalled();
  active = false;
  await service.releaseIdleWorkers(workspaceId);
  expect(release).toHaveBeenCalledExactlyOnceWith("root-worker");
  expect((await service.getWorkItem(workspaceId, item.workItemId)).status).toBe("cancelled");
});

it("rejects untracked scoped root code and reverts every owned commit while retaining interleaved docs and unrelated commits", async () => {
  const { service, workspaceId, root } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, scope: { ...contract.scope, allowedPaths: ["result.txt"] }, sessionId: "root-worker" });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "root-worker" });
  await writeFile(join(root, "result.txt"), "first\n");
  const pending = await service.submitWorkItem(workspaceId, item.workItemId, submission);
  expect(pending.status).toBe("queued");
  expect(pending.rejections[0]?.reason).toContain("未提交");
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "root-worker" });
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "implementation");
  const first = await git(root, "rev-parse", "HEAD");
  await service.writeDoc(workspaceId, ".vermillion/docs/retained.md", "retained docs\n");
  await service.commitDocs(workspaceId, { message: "docs" });
  await writeFile(join(root, "unrelated.txt"), "retained unrelated\n");
  await git(root, "add", "unrelated.txt"); await git(root, "commit", "-qm", "unrelated");
  await writeFile(join(root, "result.txt"), "reviewed\n");
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "review fixes");
  const tip = await git(root, "rev-parse", "HEAD");
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, evidence: { ...submission.evidence, commit: tip } });
  expect(closed).toMatchObject({ status: "closed", merge: { commits: [first, tip] } });
  await service.rollbackWorkItem(workspaceId, item.workItemId, "Redo");
  await expect(access(join(root, "result.txt"))).rejects.toThrow();
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toContain("retained unrelated");
  expect(await service.readDoc(workspaceId, ".vermillion/docs/retained.md")).toContain("retained docs");
  const before = await git(root, "rev-parse", "HEAD");
  await service.continueIntegrations(workspaceId);
  expect(await git(root, "rev-parse", "HEAD")).toBe(before);
});

it("rejects a root commit mixing owned and unrelated files", async () => {
  const { root } = await fixture();
  const docs = new DocsService(root), base = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "owned.txt"), "owned"); await writeFile(join(root, "other.txt"), "other");
  await git(root, "add", "owned.txt", "other.txt"); await git(root, "commit", "-qm", "mixed");
  await expect(docs.rootResult(await git(root, "rev-parse", "HEAD"), base, ["owned.txt"])).rejects.toThrow("混合");
});
