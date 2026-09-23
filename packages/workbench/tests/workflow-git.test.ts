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
  expect(updated.decisions).toEqual([]);
  const returned = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: item.run.sessionId });
  expect(returned).toMatchObject({ status: "queued" });
  expect(returned.evidence).toBeUndefined();
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

it("refreshes Explorer after external commits and index-only changes without active work items", async () => {
  const { service, workspaceId, root } = await fixture();
  const path = ".vermillion/docs/status.md";
  await service.writeDoc(workspaceId, path, "saved content\n");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const changed = vi.fn();
  const unsubscribe = service.subscribe((event) => { if (event.type === "docs.changed") changed(); });
  try {
    await git(root, "add", path);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 350));
    changed.mockClear();
    await git(root, "commit", "-qm", "External commit");
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(await service.pendingDocChanges(workspaceId)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    changed.mockClear();
    await git(root, "rm", "--cached", path);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(await service.pendingDocChanges(workspaceId)).not.toEqual([]);
  } finally { unsubscribe(); }
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

it("records a merge needing rebase without automatically requeueing and preserves unrelated root edits", async () => {
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
  const result = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: item.run.sessionId });
  expect(result).toMatchObject({ status: "merging", run: { sessionId: "original", worktreePath, branch } });
  expect((await service.listActions(workspaceId)).find((action) => action.kind === "integration")?.failure).toContain("rebase");
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
  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: item.run.sessionId, evidence: { ...submission.evidence, commit } });
  expect(closed).toMatchObject({ status: "closed", merge: { commit } });
  expect(release).not.toHaveBeenCalled();
  await service.releaseIdleWorkers(workspaceId);
  expect(release).toHaveBeenCalledWith("root-worker");
  expect(closed.merge?.diffStat).toContain("result.txt");
  await service.rollbackWorkItem(workspaceId, item.workItemId, "Remove result");
  await expect(access(join(root, "result.txt"))).rejects.toThrow();
});

it("closes a root work item whose allowed paths contain only an external artifact", async () => {
  const { service, workspaceId, root } = await fixture();
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "artifact-worker",
    scope: { ...contract.scope, allowedPaths: [join(root, "..", "external-artifact")] } });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "artifact-worker" });

  const closed = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: item.run.sessionId });

  expect(closed).toMatchObject({ status: "closed", merge: { diffStat: "" } });
  expect((await service.listActions(workspaceId)).find((action) => action.workItemId === item.workItemId && action.kind === "integration")).toMatchObject({ status: "done" });
});

it("checks repository paths in a mixed root scope while ignoring external artifacts", async () => {
  const { service, workspaceId, root } = await fixture();
  const external = join(root, "..", "external-artifact");
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "mixed-worker",
    scope: { ...contract.scope, allowedPaths: ["owned.txt", external] } });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "mixed-worker" });
  await writeFile(join(root, "owned.txt"), "owned\n");

  const pending = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: item.run.sessionId });
  expect(pending).toMatchObject({ status: "merging" });
  const failedMerge = (await service.listActions(workspaceId)).find((action) => action.kind === "integration");
  expect(failedMerge?.failure).toContain("未提交");
  expect(failedMerge?.failure).not.toContain("outside repository");
  await git(root, "add", "owned.txt");
  await git(root, "commit", "-qm", "owned result");
  const commit = await git(root, "rev-parse", "HEAD");
  const closed = await service.retryIntegration(workspaceId, item.workItemId);

  expect(closed).toMatchObject({ status: "closed", merge: { commit } });
  expect(closed.merge?.diffStat).toContain("owned.txt");
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
  const pending = await service.submitWorkItem(workspaceId, item.workItemId, { ...submission, sessionId: item.run.sessionId });
  expect(pending.status).toBe("merging");
  expect((await service.listActions(workspaceId)).find((action) => action.kind === "integration")?.failure).toContain("未提交");
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "implementation");
  const first = await git(root, "rev-parse", "HEAD");
  await service.writeDoc(workspaceId, ".vermillion/docs/retained.md", "retained docs\n");
  await service.commitDocs(workspaceId, { message: "docs" });
  await writeFile(join(root, "unrelated.txt"), "retained unrelated\n");
  await git(root, "add", "unrelated.txt"); await git(root, "commit", "-qm", "unrelated");
  await writeFile(join(root, "result.txt"), "reviewed\n");
  await git(root, "add", "result.txt"); await git(root, "commit", "-qm", "review fixes");
  const tip = await git(root, "rev-parse", "HEAD");
  const closed = await service.retryIntegration(workspaceId, item.workItemId);
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

it("moves only the exact changed reference when one file supplies several sections", async () => {
  const { service, workspaceId } = await fixture();
  const path = ".vermillion/docs/Spec/PRD.md";
  const document = (alpha: string, beta: string, gamma: string) => "# Spec\n\n## Alpha\n\n" + alpha + "\n\n### Detail\n\nNested\n\n## Beta\n\n" + beta + "\n\n## Gamma\n\n" + gamma + "\n";
  await service.writeDoc(workspaceId, path, document("Alpha text", "Beta text", "Gamma text"));
  const initial = await service.commitDocs(workspaceId, { message: "Initial" });
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker",
    refs: [
      { path, section: "Spec / Alpha", description: "alpha requirement", commit: initial.commit },
      { path, section: "Spec / Beta", description: "beta requirement", commit: initial.commit }
    ] });

  await service.writeDoc(workspaceId, path, document("Alpha text", "Beta changed", "Gamma text"));
  const betaCommit = await service.commitDocs(workspaceId, { message: "Beta change", paths: [path] });
  const betaMoved = await service.getWorkItem(workspaceId, item.workItemId);
  expect(betaMoved.refs.map((ref) => ref.commit)).toEqual([initial.commit, betaCommit.commit]);
  expect(betaMoved.contractRevision).toBe(1);
  expect(betaMoved.run.resumeMessage).toContain("#Spec / Beta");
  expect(betaMoved.run.resumeMessage).toContain("+Beta changed");
  expect(betaMoved.run.resumeMessage).not.toContain("Alpha text");

  await service.writeDoc(workspaceId, path, document("Alpha text", "Beta changed", "Gamma changed"));
  await service.commitDocs(workspaceId, { message: "Unreferenced change", paths: [path] });
  const untouched = await service.getWorkItem(workspaceId, item.workItemId);
  expect(untouched.refs.map((ref) => ref.commit)).toEqual([initial.commit, betaCommit.commit]);
  expect(untouched.contractRevision).toBe(1);

  await service.writeDoc(workspaceId, path, document("Alpha changed", "Beta changed", "Gamma changed"));
  const committed = await service.commitDocs(workspaceId, { message: "Alpha change", paths: [path] });
  const moved = await service.getWorkItem(workspaceId, item.workItemId);
  expect(moved.refs.map((ref) => ref.commit)).toEqual([committed.commit, betaCommit.commit]);
  expect(moved.contractRevision).toBe(2);
  expect(moved.decisions).toEqual([]);
});

it("validates exact sections on create and update while keeping description separate", async () => {
  const { service, workspaceId, root } = await fixture();
  const path = ".vermillion/docs/Spec/PRD.md";
  const content = "# Spec\n\n## A\n\n### Item\n\nFirst\n\n## B\n\n### Item\n\nSecond\n";
  await service.writeDoc(workspaceId, path, content);
  const commit = await service.commitDocs(workspaceId, { message: "Sections" });

  await expect(service.createWorkItem(workspaceId, { ...contract,
    refs: [{ path, section: "Item", commit: commit.commit }] })).rejects.toThrow("不唯一");
  await expect(service.createWorkItem(workspaceId, { ...contract,
    refs: [{ path, section: "Spec / A / Item（L5）", commit: commit.commit }] })).rejects.toThrow("不存在");

  const item = await service.createWorkItem(workspaceId, { ...contract,
    refs: [{ path, section: "Spec / A / Item", description: "L5 · first item", commit: "HEAD" }] });
  expect(item.refs[0]).toEqual({ path, section: "Spec / A / Item", description: "L5 · first item", commit: commit.commit });
  await expect(service.updateWorkItem(workspaceId, item.workItemId, { note: "Wrong section",
    refs: [{ path, section: "Missing", commit: commit.commit }] })).rejects.toThrow("不存在");

  await writeFile(join(root, "AGENTS.md"), "# Rules\n\n## Checks\n\nRun them.\n");
  await git(root, "add", "AGENTS.md"); await git(root, "commit", "-qm", "rules");
  const rules = await git(root, "rev-parse", "HEAD");
  const external = await service.createWorkItem(workspaceId, { ...contract,
    refs: [{ path: "AGENTS.md", commit: rules }] });
  expect(external.refs[0]?.commit).toBe(rules);

  await service.writeDoc(workspaceId, path, content.replace("First", "First updated"));
  await service.commitDocs(workspaceId, { message: "Unrelated docs", paths: [path] });
  expect((await service.getWorkItem(workspaceId, external.workItemId)).refs[0]?.commit).toBe(rules);

  await writeFile(join(root, "AGENTS.md"), "# Rules\n\n## Checks\n\nRun all of them.\n");
  await git(root, "add", "AGENTS.md"); await git(root, "commit", "-qm", "update rules");
  const updatedRules = await git(root, "rev-parse", "HEAD");
  await service.refreshDocRefs(workspaceId);
  expect((await service.getWorkItem(workspaceId, external.workItemId)).refs[0]?.commit).toBe(updatedRules);
});

it("retains a reference and diagnoses it when the heading disappears", async () => {
  const { service, workspaceId } = await fixture();
  const path = ".vermillion/docs/Spec/PRD.md";
  await service.writeDoc(workspaceId, path, "# Spec\n\n## Alpha\n\nRequired\n\n## Beta\n\nOther\n");
  const initial = await service.commitDocs(workspaceId, { message: "Initial" });
  const item = await service.createWorkItem(workspaceId, { ...contract,
    refs: [{ path, section: "Spec / Alpha", commit: initial.commit }] });

  await service.writeDoc(workspaceId, path, "# Spec\n\n## Renamed\n\nRequired\n\n## Beta\n\nOther\n");
  await service.commitDocs(workspaceId, { message: "Rename section", paths: [path] });
  const retained = await service.getWorkItem(workspaceId, item.workItemId);
  expect(retained.refs[0]?.commit).toBe(initial.commit);
  expect(retained.contractRevision).toBe(0);
  const diagnosis = await service.diagnoseWorkItem(workspaceId, item.workItemId);
  expect(diagnosis.invalidRefs).toEqual([expect.objectContaining({ path, section: "Spec / Alpha", commit: initial.commit, reason: expect.stringContaining("不存在") })]);
  expect(diagnosis.waiting).toContainEqual(expect.stringContaining("引用定位失效"));
});

it("moves a worker's own document commit without notifying that worker", async () => {
  const { service, workspaceId } = await fixture();
  service.setSessionTreeResolver(async (sessionId) => sessionId);
  const path = ".vermillion/docs/Own/PRD.md";
  await service.writeDoc(workspaceId, path, "Before\n");
  const initial = await service.commitDocs(workspaceId, { message: "Initial" });
  const item = await service.createWorkItem(workspaceId, { ...contract, sessionId: "worker", refs: [{ path, commit: initial.commit }] });
  await service.startWorkItem(workspaceId, item.workItemId, { sessionId: "worker" });

  // The worker edits its own tree's draft; the commit publishes it to the main branch and moves the ref.
  await service.writeDoc(workspaceId, path, "After\n", "worker");
  const committed = await service.commitDocs(workspaceId, { message: "Own docs", paths: [path], sessionId: "worker" });

  const updated = await service.getWorkItem(workspaceId, item.workItemId);
  expect(updated.refs).toEqual([{ path, commit: committed.commit }]);
  expect(updated.contractRevision).toBe(1);
  expect(updated.run.resumeMessage).toBeUndefined();
  expect((await service.listActions(workspaceId))[0]).toMatchObject({ notices: [] });
});
