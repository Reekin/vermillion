import { afterEach, expect, it, vi } from "vitest";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { DocsService } from "../src/docs.js";
import { contract, git, setup, submission } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const orchestrators: Orchestrator[] = [];
afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.dispose();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

it("keeps the worker session at workspace root while directing tools to its worktree", async () => {
  const f = await fixture();
  const worktreePath = f.root + "/worker-tree";
  await git(f.root, "worktree", "add", "-b", "worker-test", worktreePath);
  await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original", worktreePath, branch: "worker-test" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  expect(f.runner.resume).toHaveBeenCalledWith("original", expect.objectContaining({ cwd: f.root }));
  const message = vi.mocked(f.runner.send).mock.calls[0]![1];
  expect(message).toContain("工作目录: " + worktreePath);
  expect(message).toContain("显式指定工具 workdir、git -C 或 worktree 内的绝对路径");
});

it("detaches a completed worker after its turn ends without waiting for release ACK", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  let ack!: () => void;
  vi.mocked(f.runner.release).mockImplementation(() => new Promise<void>((resolve) => { ack = resolve; }));
  try {
    expect((await f.service.submitWorkItem(f.workspaceId, item.workItemId, submission)).status).toBe("closed");
    expect(f.runner.release).not.toHaveBeenCalled();
    f.complete("original");
    await vi.waitFor(() => expect(f.runner.release).toHaveBeenCalledExactlyOnceWith("original"));
    const next = await f.service.createWorkItem(f.workspaceId, contract);
    await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, next.workItemId)).status).toBe("running"));
  } finally { ack?.(); }
});

it("unsubscribes again after a user follows up in a completed worker session", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  await f.service.submitWorkItem(f.workspaceId, item.workItemId, submission);
  f.complete("original");
  await vi.waitFor(() => expect(f.runner.release).toHaveBeenCalledOnce());
  f.active.add("original");
  await f.service.releaseIdleWorkers(f.workspaceId);
  expect(f.runner.release).toHaveBeenCalledOnce();
  f.complete("original", "user-followup");
  await vi.waitFor(() => expect(f.runner.release).toHaveBeenCalledTimes(2));
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).status).toBe("closed");
});

it("interrupts a cancelled worker before sending work to the next shared-resource owner", async () => {
  // Exercise service-event ordering independently of filesystem notification timing.
  const watcher = vi.spyOn(DocsService.prototype, "watch").mockReturnValue({ close() {} });
  const f = await fixture();
  const needs = ["browser:shared-profile"];
  const first = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker-a", needs }).finally(() => watcher.mockRestore());
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const second = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker-b", needs });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await f.service.getWorkItem(f.workspaceId, second.workItemId)).status).toBe("queued");
  expect(f.runner.send).toHaveBeenCalledOnce();
  expect(f.active.has("worker-a")).toBe(true);

  const order: string[] = [];
  vi.mocked(f.runner.interrupt).mockImplementation(async (id) => {
    order.push("interrupt:" + id);
    f.active.delete(id);
  });
  vi.mocked(f.runner.send).mockImplementation(async (id) => {
    order.push("send:" + id);
    f.active.add(id);
  });
  await f.service.cancelWorkItem(f.workspaceId, first.workItemId);
  await vi.waitFor(() => expect(order).toContain("send:worker-b"));
  expect(order).toEqual(["interrupt:worker-a", "send:worker-b"]);
  expect((await f.service.getWorkItem(f.workspaceId, second.workItemId)).status).toBe("running");
});

async function fixture() {
  const f = await setup(); fixtures.push(f);
  const active = new Set<string>();
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  let sequence = 0;
  const runner: AgentRunner = {
    open: vi.fn(async () => ({ sessionId: "open-" + ++sequence })),
    fork: vi.fn(async (input) => {
      if (input.sourceTurnId === "missing") throw new Error("Unknown source turn");
      return { sessionId: "fork-" + ++sequence, treeId: "tree" };
    }),
    resolveSourceTurn: vi.fn(async () => "source-turn"),
    resume: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    send: vi.fn(async (id) => { active.add(id); }),
    steer: vi.fn(async () => ({ turnId: "active-turn" })),
    interrupt: vi.fn(async (id) => { active.delete(id); }),
    isActive: (id) => active.has(id),
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const orchestrator = new Orchestrator({ service: f.service, roles: f.roles, runner });
  orchestrators.push(orchestrator);
  const complete = (sessionId: string, turnId = "end") => {
    active.delete(sessionId);
    for (const listener of listeners) listener({ sessionId, turnId, finishReason: "completed" });
  };
  return { ...f, runner, active, orchestrator, complete };
}

it("waits for the source turn, prepares while execution is disabled, then resumes and forks queued siblings", async () => {
  const f = await fixture();
  f.active.add("design"); f.orchestrator.start();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", scope: "ABC" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.fork).not.toHaveBeenCalled();
  f.complete("design", "source-turn");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  expect(f.runner.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "design", sourceTurnId: "source-turn", metadata: expect.objectContaining({ role: "worker" }) }));
  expect(vi.mocked(f.runner.fork).mock.calls[0]![0].developerInstructions).toContain("reviewer subagent prompt");
  expect(vi.mocked(f.runner.fork).mock.calls[0]![0].developerInstructions).toContain("verifier subagent prompt");
  const first = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "fork-1" });
  const sibling = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
  expect((await f.service.getWorkItem(f.workspaceId, first.workItemId)).status).toBe("preparing");
  f.complete("fork-1", "prep-end");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, sibling.workItemId)).status).toBe("running"));
  expect(f.runner.fork).toHaveBeenLastCalledWith(expect.objectContaining({ sourceSessionId: "fork-1", sourceTurnId: "prep-end" }));
  expect(f.runner.resume).toHaveBeenCalledWith("fork-1", expect.objectContaining({ cwd: f.root, metadata: expect.objectContaining({ workItemId: first.workItemId }) }));
  expect(f.runner.open).not.toHaveBeenCalled();
});

it("fails an explicit missing source turn visibly instead of forking the latest turn", async () => {
  const f = await fixture(); f.orchestrator.start();
  await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "missing" });
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]).toMatchObject({ status: "pending", attempts: 1, failure: "Unknown source turn" }));
  expect(f.runner.send).not.toHaveBeenCalled();
});

it("records resume failure and preserves the original execution session without opening a replacement", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  vi.mocked(f.runner.resume).mockResolvedValue(false);
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run).toMatchObject({ sessionId: "original", attempts: 1 }));
  expect(f.runner.open).not.toHaveBeenCalled();
  expect(f.runner.fork).not.toHaveBeenCalled();
  expect((await f.service.diagnoseWorkItem(f.workspaceId, item.workItemId)).nextRetryAt).toBeTruthy();
});

it("steers changed contracts into an active worker and voids the old turn's submission", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "New criterion", objective: "Updated result" });
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("active-turn"));
  expect(f.runner.steer).toHaveBeenCalled();
});
