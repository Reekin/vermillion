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

it("sends composed input and configured preparation together after the selected source finishes", async () => {
  const f = await fixture();
  f.active.add("design");
  f.orchestrator.start();
  const message = { content: "[$review](/skills/review)\n\nImplement ABC", attachments: [
    { attachmentId: "image", mimeType: "image/png", uri: "file:///example.png" }
  ], execution: { modelId: "chosen-model", reasoningOptionId: "high", serviceTierId: null } };
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", turnId: "viewed-turn", message });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).not.toHaveBeenCalled();
  expect(f.runner.fork).not.toHaveBeenCalled();
  expect((await f.service.listWorkRequests(f.workspaceId))[0]?.message).toEqual(message);
  f.complete("design");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  expect(f.runner.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "design", sourceTurnId: "viewed-turn" }));
  const [target, content, options] = vi.mocked(f.runner.send).mock.calls[0]!;
  expect(target).toBe("fork-1");
  expect(content.startsWith(message.content + "\n\n" + (await f.roles.resolve(f.root, "work-preparation")).content)).toBe(true);
  expect(content).toContain(request.requestId);
  expect(options).toEqual({ attachments: message.attachments, execution: message.execution });
});

it("prepares a verified empty New Chat in place and preserves its message for retry", async () => {
  const f = await fixture();
  vi.mocked(f.runner.resolveSourceTurn!).mockResolvedValue(undefined);
  vi.mocked(f.runner.send).mockRejectedValueOnce(new Error("provider unavailable"));
  f.orchestrator.start();
  const message = { content: "New task", attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png" }] };
  const request = await f.service.startWork(f.workspaceId, { sessionId: "new", message });
  await vi.waitFor(async () => expect((await f.service.listWorkRequests(f.workspaceId))[0]?.failure).toBe("provider unavailable"));
  expect(f.runner.fork).not.toHaveBeenCalled();
  expect(f.runner.open).not.toHaveBeenCalled();
  expect(f.runner.resume).not.toHaveBeenCalled();
  const saved = (await f.service.listWorkRequests(f.workspaceId))[0]!;
  expect(saved.sourceTurnId).toBeUndefined();
  expect(saved.workerSessionId).toBe("new");
  await f.service.putWorkRequest(f.workspaceId, { ...saved, retryAt: undefined });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(f.runner.send).toHaveBeenLastCalledWith("new", expect.stringContaining("New task"), { attachments: message.attachments, execution: undefined });
  expect(f.runner.fork).not.toHaveBeenCalled();
});

it("requires a source resolver to verify empty sessions and rejects contentless empty work", async () => {
  const f = await fixture();
  await expect(f.service.startWork(f.workspaceId, { sessionId: "unknown", message: { content: "task" } })).rejects.toThrow("turnId");
  f.orchestrator.start();
  vi.mocked(f.runner.resolveSourceTurn!).mockResolvedValue(undefined);
  await expect(f.service.startWork(f.workspaceId, { sessionId: "empty" })).rejects.toThrow("空会话");
});

it("waits for the source turn, prepares while execution is disabled, then resumes and forks queued siblings", async () => {
  const f = await fixture();
  await f.service.setScheduler(f.workspaceId, { enabled: false, maxWorkers: 2 });
  f.active.add("design"); f.orchestrator.start();
  const request = await f.service.startWork(f.workspaceId, { sessionId: "design", scope: "ABC" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.fork).not.toHaveBeenCalled();
  f.complete("design", "source-turn");
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(1));
  expect(f.runner.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "design", sourceTurnId: "source-turn", metadata: expect.objectContaining({ role: "work-preparation" }) }));
  expect(vi.mocked(f.runner.fork).mock.calls[0]![0].developerInstructions).toBeUndefined();
  expect(vi.mocked(f.runner.send).mock.calls[0]![1]).toContain((await f.roles.resolve(f.root, "work-preparation")).content);
  expect(f.runner.resume).not.toHaveBeenCalledWith("fork-1", expect.objectContaining({ developerInstructions: expect.any(String) }));
  const first = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId, sessionId: "fork-1" });
  const sibling = await f.service.createWorkItem(f.workspaceId, { ...contract, requestId: request.requestId });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runner.send).toHaveBeenCalledTimes(1);
  expect((await f.service.getWorkItem(f.workspaceId, first.workItemId)).status).toBe("preparing");
  f.complete("fork-1", "prep-end");
  await vi.waitFor(async () => expect((await f.service.getWorkItem(f.workspaceId, sibling.workItemId)).status).toBe("running"));
  expect(f.runner.fork).toHaveBeenLastCalledWith(expect.objectContaining({ sourceSessionId: "fork-1", sourceTurnId: "prep-end" }));
  expect(f.runner.resume).toHaveBeenCalledWith("fork-1", expect.objectContaining({ cwd: f.root, developerInstructions: expect.stringContaining("reviewer subagent prompt"), metadata: expect.objectContaining({ role: "worker", workItemId: first.workItemId }) }));
  expect(vi.mocked(f.runner.fork).mock.calls.at(-1)![0].developerInstructions).toContain("verifier subagent prompt");
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

it("delivers decision answers and parked adjustments once without replaying worker instructions", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  const initial = vi.mocked(f.runner.send).mock.calls[0]![1];
  expect(initial).toContain("你负责工单");
  expect(initial).toContain("workItem.get");
  expect(initial).toContain("完成后必须调用");
  for (const note of ["First answer", "Second answer"]) {
    const card = await f.service.createDecision(f.workspaceId, { workItemId: item.workItemId,
      sessionId: "original", question: "Continue?", context: "Choice", options: [{ key: "yes", label: "Continue" }] });
    f.complete("original");
    await vi.waitFor(async () => expect((await f.service.listRuns(f.workspaceId)).some((run) => run.status === "running")).toBe(false));
    await f.service.updateWorkItem(f.workspaceId, item.workItemId, { note: "Adjustment for " + note });
    const count = vi.mocked(f.runner.send).mock.calls.length;
    await f.service.answerDecision(f.workspaceId, card.decisionId, { key: "yes", note });
    await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(count + 1));
    expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original",
      "用户决策答复：Continue? -> Continue (" + note + ")；挂起期间工单调整：Adjustment for " + note]);
  }
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).decisions).toHaveLength(2);
});

it("records the opening delivery even when the worker creates a decision before send returns", async () => {
  const f = await fixture();
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original" });
  vi.mocked(f.runner.send).mockImplementationOnce(async () => {
    await f.service.createDecision(f.workspaceId, { workItemId: item.workItemId, sessionId: "original",
      question: "Continue?", context: "Choice", options: [{ key: "yes", label: "Continue" }] });
  });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(async () => expect((await f.service.listActions(f.workspaceId))[0]).toMatchObject({
    status: "decision", deliveredAt: expect.any(String)
  }));
  const [card] = await f.service.listDecisions(f.workspaceId);
  await f.service.answerDecision(f.workspaceId, card!.decisionId, { key: "yes" });
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "用户决策答复：Continue? -> Continue"]);
});

it("steers only the latest committed document diff and resumes without the opening message", async () => {
  const f = await fixture();
  const path = ".vermillion/docs/Task/PRD.md";
  await f.service.writeDoc(f.workspaceId, path, "Baseline\n");
  const baseline = await f.service.commitDocs(f.workspaceId, { message: "baseline", paths: [path] });
  const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "original",
    refs: [{ path, commit: baseline.commit }] });
  await f.service.setScheduler(f.workspaceId, { enabled: true, maxWorkers: 1 });
  f.orchestrator.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledOnce());
  for (const content of ["First change\n", "Second change\n"]) {
    await f.service.writeDoc(f.workspaceId, path, content);
    const diff = await f.service.docDiff(f.workspaceId, path);
    const count = vi.mocked(f.runner.steer).mock.calls.length;
    const committed = await f.service.commitDocs(f.workspaceId, { message: content.trim(), paths: [path] });
    await vi.waitFor(() => expect(f.runner.steer).toHaveBeenCalledTimes(count + 1));
    expect(vi.mocked(f.runner.steer).mock.calls.at(-1)).toEqual(["original",
      "工单已调整：引用文档已提交 " + committed.commit + "\n" + diff +
      "\n立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。"]);
  }
  expect((await f.service.getWorkItem(f.workspaceId, item.workItemId)).run.staleTurnId).toBe("active-turn");
  await f.orchestrator.dispose();
  f.active.clear();
  const restarted = new Orchestrator({ service: f.service, roles: f.roles, runner: f.runner });
  orchestrators.push(restarted);
  restarted.start();
  await vi.waitFor(() => expect(f.runner.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.runner.send).mock.calls.at(-1)).toEqual(["original", "会话已恢复。核对当前成果与持久化处置结果，继续尚未完成的动作。"]);
});
