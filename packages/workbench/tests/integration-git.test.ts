import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { DocsService, WorkspaceNotReady, WorktreeMergeConflict, WorktreeNotReady } from "../src/docs.js";

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "verm-integration-"));
  roots.push(root);
  const main = join(root, "main");
  const worker = join(root, "worker");
  await git(root, "init", "-q", "-b", "main", main);
  await git(main, "config", "user.name", "Test");
  await git(main, "config", "user.email", "test@local");
  await git(main, "config", "core.autocrlf", "false");
  await writeFile(join(main, "file.txt"), "base\n");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "base");
  await git(main, "worktree", "add", "-b", "worker", worker);
  await writeFile(join(worker, "file.txt"), "worker\n");
  await git(worker, "commit", "-qam", "worker output");
  return { main, worker, docs: new DocsService(main) };
}

test("freezes target, keeps worktree, and resumes completed merge and cleanup", async () => {
  const { main, worker, docs } = await fixture();
  await docs.checkIntegrationReady();
  const snapshot = await docs.integrationSnapshot("worker");
  expect(snapshot.diffStat).toContain("file.txt");
  await writeFile(join(worker, "later.txt"), "later");
  await git(worker, "add", ".");
  await git(worker, "commit", "-qm", "later output");
  const result = await docs.mergeWorktree(worker, "worker", "output", snapshot.target);
  expect(result.commit).toBeTruthy();
  await access(worker);
  await expect(access(join(main, "later.txt"))).rejects.toThrow();
  expect(await docs.mergeWorktree(worker, "worker", "retry", snapshot.target)).toEqual({ diffStat: "" });
  // Unmerged worker output must survive cleanup failure.
  await expect(docs.dropWorktree(worker, "worker")).rejects.toThrow();
  expect(await git(main, "rev-parse", "worker")).not.toBe(snapshot.target);
  // Restore the worktree Git safely removed, then integrate the remaining output.
  await git(main, "worktree", "add", worker, "worker");
  await docs.mergeWorktree(worker, "worker", "remaining");
  await docs.dropWorktree(worker, "worker");
  await docs.dropWorktree(worker, "worker");
  await expect(access(worker)).rejects.toThrow();
  expect(await docs.mergeWorktree(worker, "worker", "retry after cleanup", snapshot.target)).toEqual({ diffStat: "" });
}, 20_000);

test("unrelated main workspace changes survive integration; Git operations and locks block it without changing files", async () => {
  const { main, worker, docs } = await fixture();
  const head = await docs.head();
  await writeFile(join(main, "personal.txt"), "keep");
  await writeFile(join(main, "file.txt"), "personal edit\n");
  await expect(docs.mergeWorktree(worker, "worker", "output")).rejects.toThrow();
  expect(await docs.head()).toBe(head);
  expect(await readFile(join(main, "file.txt"), "utf8")).toBe("personal edit\n");
  await writeFile(join(main, "file.txt"), "base\n");
  expect((await docs.mergeWorktree(worker, "worker", "output")).commit).toBeTruthy();
  expect(await readFile(join(main, "personal.txt"), "utf8")).toBe("keep");
  expect(await readFile(join(main, "file.txt"), "utf8")).toBe("worker\n");
  await rm(join(main, "personal.txt"));
  for (const marker of ["index.lock", "MERGE_HEAD"]) {
    const path = join(main, ".git", marker);
    await writeFile(path, head! + "\n");
    await expect(docs.checkIntegrationReady()).rejects.toBeInstanceOf(WorkspaceNotReady);
    await rm(path);
  }
  expect(await docs.head()).toBe(await git(main, "rev-parse", "HEAD"));
});

test("dirty worker is not committed or cleaned", async () => {
  const { worker, docs } = await fixture();
  const head = await git(worker, "rev-parse", "HEAD");
  await writeFile(join(worker, "pending.txt"), "keep");
  await expect(docs.mergeWorktree(worker, "worker", "output")).rejects.toBeInstanceOf(WorktreeNotReady);
  await expect(docs.dropWorktree(worker, "worker")).rejects.toThrow();
  expect(await git(worker, "rev-parse", "HEAD")).toBe(head);
  expect(await git(worker, "diff", "--cached", "--stat")).toBe("");
  expect(await readFile(join(worker, "pending.txt"), "utf8")).toBe("keep");
});

test("code conflict belongs to worker and restores main workspace", async () => {
  const { main, worker, docs } = await fixture();
  await writeFile(join(main, "file.txt"), "main\n");
  await git(main, "commit", "-qam", "main output");
  const head = await docs.head();
  await expect(docs.mergeWorktree(worker, "worker", "output")).rejects.toBeInstanceOf(WorktreeMergeConflict);
  expect(await docs.head()).toBe(head);
  expect(await readFile(join(main, "file.txt"), "utf8")).toBe("main\n");
  await docs.checkIntegrationReady();
  await access(worker);
});

test("rollback detects actual standard Git revert after persisted starting SHA", async () => {
  const { main, worker, docs } = await fixture();
  const merge = (await docs.mergeWorktree(worker, "worker", "output")).commit!;
  const before = (await docs.head())!;
  // An external Git revert models interruption after Git succeeds and before persistence.
  await git(main, "revert", "--no-edit", "-m", "1", merge);
  const reverted = (await docs.head())!;
  expect(await docs.getRollbackCommit(merge, before)).toBe(reverted);
  expect(await docs.rollbackMerge(merge, before)).toBe(reverted);
  expect(await docs.rollbackMerge(merge)).toBe(reverted);
  expect(await docs.head()).toBe(reverted);
  expect(await readFile(join(main, "file.txt"), "utf8")).toBe("base\n");
  expect(await docs.getRollbackCommit(merge, reverted)).toBeUndefined();
});

test("rollback executes once, and conflicting rollback is a workspace repair failure", async () => {
  const { main, worker, docs } = await fixture();
  const merge = (await docs.mergeWorktree(worker, "worker", "output")).commit!;
  await writeFile(join(main, "file.txt"), "later main change\n");
  await git(main, "commit", "-qam", "later change");
  const before = (await docs.head())!;
  await expect(docs.rollbackMerge(merge, before)).rejects.toBeInstanceOf(WorkspaceNotReady);
  expect(await docs.head()).toBe(before);
  await docs.checkIntegrationReady();
  await git(main, "revert", "--no-edit", before);
  const rollbackBefore = (await docs.head())!;
  const reverted = await docs.rollbackMerge(merge, rollbackBefore);
  expect(await docs.rollbackMerge(merge, rollbackBefore)).toBe(reverted);
  expect(await readFile(join(main, "file.txt"), "utf8")).toBe("base\n");
});
