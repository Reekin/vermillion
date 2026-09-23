import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { contract, git, setup, submission } from "./workflow-fixture.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { DocsService } from "../src/docs.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.cleanup(); });

async function fixture() {
  const f = await setup();
  fixtures.push(f);
  const worktreePath = join(f.root, ".vermillion", "worktrees", "result"), branch = "work/result";
  await git(f.root, "worktree", "add", "-b", branch, worktreePath);
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original", branch, worktreePath });
  return { ...f, item, worktreePath, branch };
}

async function merge(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.startWorkItem(f.workspaceId, f.item.workItemId, { sessionId: "original" });
  await writeFile(join(f.worktreePath, "result.txt"), "worker\n");
  await git(f.worktreePath, "add", "result.txt");
  await git(f.worktreePath, "commit", "-qm", "worker result");
  return f.service.submitWorkItem(f.workspaceId, f.item.workItemId, { ...submission, sessionId: f.item.run.sessionId });
}

async function detach(f: Awaited<ReturnType<typeof fixture>>) {
  f.service.setWorkerEnvironmentReleaser(async () => {});
  await f.service.releaseIdleWorkers(f.workspaceId);
  await vi.waitFor(async () => expect((await f.service.listWorktreeCleanup(f.workspaceId))[0]?.detachedAt).toBeTruthy());
}

it("closes and publishes Inbox immediately; persists detached cleanup across restart and retries a busy path without reopening", async () => {
  const f = await fixture();
  let active = true;
  f.service.setWorkerActiveChecker(() => active);
  let ack!: () => void;
  const release = vi.fn(() => new Promise<void>((resolve) => { ack = resolve; }));
  f.service.setWorkerEnvironmentReleaser(release);
  const closed = await merge(f);
  expect(closed).toMatchObject({ status: "closed", run: { sessionId: "original" } });
  expect(closed.run.worktreePath).toBeUndefined();
  expect(closed.run.branch).toBeUndefined();
  expect(await f.service.listInbox()).toMatchObject([{ kind: "merged", workItem: { workItemId: f.item.workItemId } }]);
  expect(await f.client.request("worktree.list", { workspaceId: f.workspaceId })).toMatchObject([{ sessionId: "original", worktreePath: f.worktreePath, branch: f.branch, discard: false }]);
  expect(await f.client.request("worktree.cleanup", { workspaceId: f.workspaceId })).toMatchObject({ removed: [], retained: [{ reason: "active" }] });
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(release).not.toHaveBeenCalled();
  active = false;
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(release).toHaveBeenCalledOnce();
  expect((await f.service.getWorkItem(f.workspaceId, f.item.workItemId)).status).toBe("closed");
  ack();
  await vi.waitFor(async () => expect((await f.service.listWorktreeCleanup(f.workspaceId))[0]?.detachedAt).toBeTruthy());
  await f.service.dispose();
  const restarted = new WorkbenchService(f.options);
  restarted.setWorkerEnvironmentReleaser(release);
  try {
    await restarted.releaseIdleWorkers(f.workspaceId);
    expect(release).toHaveBeenCalledOnce();
    await restarted.workerTurnCompleted(f.workspaceId, "original");
    expect((await restarted.listWorktreeCleanup(f.workspaceId))[0]?.detachedAt).toBeUndefined();
    release.mockImplementation(async () => {});
    await restarted.releaseIdleWorkers(f.workspaceId);
    expect(release).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await restarted.listWorktreeCleanup(f.workspaceId))[0]?.detachedAt).toBeTruthy());
    const drop = vi.spyOn(DocsService.prototype, "dropWorktree");
    drop.mockRejectedValueOnce(new Error("EBUSY: native thread still owns directory"));
    expect(await restarted.cleanupWorktrees(f.workspaceId)).toMatchObject({ removed: [], retained: [{ reason: expect.stringContaining("EBUSY") }] });
    await access(f.worktreePath);
    expect((await restarted.getWorkItem(f.workspaceId, f.item.workItemId)).status).toBe("closed");
    expect(await restarted.listDecisions(f.workspaceId)).toEqual([]);
    expect((await restarted.listActions(f.workspaceId)).every((action) => action.status === "done")).toBe(true);
    expect(await restarted.cleanupWorktrees(f.workspaceId)).toEqual({ removed: [f.worktreePath], retained: [] });
    await expect(access(f.worktreePath)).rejects.toThrow();
    expect(await restarted.listWorktreeCleanup(f.workspaceId)).toEqual([]);
  } finally { await restarted.dispose(); }
});

it.each(["queued", "decision"] as const)("retains candidates owned by %s work through session, branch or path", async (status) => {
  const f = await fixture();
  await f.service.cancelWorkItem(f.workspaceId, f.item.workItemId);
  for (const ownership of [{ sessionId: "original" }, { worktreePath: f.worktreePath, branch: "other" }, { worktreePath: join(f.root, "other"), branch: f.branch }]) {
    const next = await f.service.createWorkItem(f.workspaceId, { ...contract, ...ownership });
    if (status === "decision") await f.service.createDecision(f.workspaceId, { workItemId: next.workItemId, question: "Continue?", context: "Wait", options: [{ key: "go", label: "Go" }] });
    const result = await f.service.cleanupWorktrees(f.workspaceId);
    expect(result.removed).toEqual([]);
    expect(result.retained.find((candidate) => candidate.workItemId === f.item.workItemId)?.reason).toBe("owned");
    await access(f.worktreePath);
    await f.service.cancelWorkItem(f.workspaceId, next.workItemId);
  }
});

it("rolls back while pending, preserves original session, and protects re-registered worktree", async () => {
  const f = await fixture();
  await merge(f);
  const release = vi.fn(async () => {});
  f.service.setWorkerEnvironmentReleaser(release);
  await f.service.releaseIdleWorkers(f.workspaceId);
  await vi.waitFor(async () => expect((await f.service.listWorktreeCleanup(f.workspaceId))[0]?.detachedAt).toBeTruthy());
  const rolled = await f.service.rollbackWorkItem(f.workspaceId, f.item.workItemId, "Revise");
  expect(rolled).toMatchObject({ status: "queued", run: { sessionId: "original" } });
  expect(rolled.run.worktreePath).toBeUndefined();
  await expect(access(join(f.root, "result.txt"))).rejects.toThrow();
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(release).toHaveBeenCalledOnce();
  expect(await f.service.cleanupWorktrees(f.workspaceId)).toMatchObject({ retained: [{ reason: "owned" }] });
  await f.service.updateWorkItem(f.workspaceId, f.item.workItemId, { note: "Reuse", worktreePath: f.worktreePath, branch: f.branch });
  await f.service.startWorkItem(f.workspaceId, f.item.workItemId, { sessionId: "original" });
  expect(await f.service.cleanupWorktrees(f.workspaceId)).toMatchObject({ removed: [], retained: [{ reason: "owned" }] });
  expect(await readFile(join(f.worktreePath, "result.txt"), "utf8")).toContain("worker");
  await f.service.cancelWorkItem(f.workspaceId, f.item.workItemId);
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(release).toHaveBeenCalledTimes(2);
});

it("serializes ownership registration with a sweep already inside Git deletion", async () => {
  const f = await fixture();
  await f.service.cancelWorkItem(f.workspaceId, f.item.workItemId);
  await detach(f);
  let unblock!: () => void;
  const drop = vi.spyOn(DocsService.prototype, "dropWorktree").mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { unblock = resolve; });
    throw new Error("busy");
  });
  const sweep = f.service.cleanupWorktrees(f.workspaceId);
  await vi.waitFor(() => expect(drop).toHaveBeenCalledOnce());
  let registered = false;
  const registration = f.service.createWorkItem(f.workspaceId, { ...contract, worktreePath: f.worktreePath, branch: f.branch })
    .then((item) => { registered = true; return item; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registered).toBe(false);
  } finally { unblock(); }
  await sweep;
  await registration;
  expect(await f.service.cleanupWorktrees(f.workspaceId)).toMatchObject({ removed: [], retained: [{ reason: "owned" }] });
  expect(drop).toHaveBeenCalledOnce();
});

it("retains externally repurposed Git worktrees when their checked out branch changed", async () => {
  const f = await fixture();
  expect((await f.service.cancelWorkItem(f.workspaceId, f.item.workItemId)).status).toBe("cancelled");
  await detach(f);
  await git(f.worktreePath, "switch", "-c", "external-owner");
  expect(await f.service.cleanupWorktrees(f.workspaceId)).toMatchObject({ removed: [], retained: [{ reason: expect.stringContaining("ownership changed") }] });
  await access(f.worktreePath);
});

it("requires unsubscribe ACK when an idle parent still owns an active native child", async () => {
  const f = await fixture();
  f.service.setWorkerActiveChecker(() => false);
  const release = vi.fn(async () => {}).mockRejectedValueOnce(new Error("native child is active"));
  f.service.setWorkerEnvironmentReleaser(release);
  await f.service.cancelWorkItem(f.workspaceId, f.item.workItemId);
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(await f.service.cleanupWorktrees(f.workspaceId)).toMatchObject({ removed: [], retained: [{ reason: "subscribed" }] });
  await access(f.worktreePath);
  await f.service.workerTurnCompleted(f.workspaceId, "original");
  await f.service.releaseIdleWorkers(f.workspaceId);
  await vi.waitFor(async () => expect((await f.service.listWorktreeCleanup(f.workspaceId))[0]?.detachedAt).toBeTruthy());
  expect(await f.service.cleanupWorktrees(f.workspaceId)).toEqual({ removed: [f.worktreePath], retained: [] });
  expect((await f.service.getWorkItem(f.workspaceId, f.item.workItemId)).status).toBe("cancelled");
  expect(await f.service.listDecisions(f.workspaceId)).toEqual([]);
});
