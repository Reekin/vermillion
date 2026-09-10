import { describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../src/electron/agent-runner.js";

describe("AgentRunner recovery", () => {
  it.each([
    { delivery: "start_or_steer", expected: {} },
    { delivery: "steered", expected: { turnId: "actual" } }
  ])("uses confirmed shared delivery instead of the requested turn: $delivery", async ({ delivery, expected }) => {
    const shell = { getActiveTurnId: () => "ended", executeCommand: vi.fn()
      .mockResolvedValueOnce({ accepted: true, turnId: "actual", delivery }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    await expect(runner.steer("worker", "update")).resolves.toEqual(expected);
    expect(shell.executeCommand.mock.calls.map(([input]) => input.command.type)).toEqual(["steerTurn"]);
  });

  it.each(["connection lost", "no active turn to steer"])("leaves shared delivery failures to the caller without retrying: %s", async (message) => {
    const shell = { getActiveTurnId: () => "running", executeCommand: vi.fn().mockRejectedValue(new Error(message)) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    await expect(runner.steer("worker", "update")).rejects.toThrow(message);
    expect(shell.executeCommand).toHaveBeenCalledOnce();
  });

  it("uses execution state instead of stale transcript state", async () => {
    const shell = { getActiveTurnId: () => undefined,
      getSnapshot: () => ({ turns: [{ sessionId: "worker", turnId: "old", status: "streaming" }] }),
      executeCommand: vi.fn().mockResolvedValue({ accepted: true }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    expect(runner.isActive!("worker")).toBe(false);
    await runner.steer("worker", "continue");
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ type: "sendUserMessage" }) }));
  });
  it("forwards attachments and selected execution with the first preparation message", async () => {
    const shell = { executeCommand: vi.fn().mockResolvedValue({ accepted: true, turnId: "started" }), getActiveTurnId: () => undefined };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    const options = { attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png" }],
      execution: { modelId: "selected", reasoningOptionId: "high", serviceTierId: null } };
    await expect(runner.send("worker", "User input\n\nPreparation prompt", options)).resolves.toEqual({ turnId: "started" });
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "sendUserMessage", sessionId: "worker", content: "User input\n\nPreparation prompt", ...options
    }) }));
  });

  it("distinguishes verified empty sources from paged history and unknown sessions", async () => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true), getChatTree: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue({ sessions: [{ sessionId: "source" }], turns: [] }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    await expect(runner.resolveSourceTurn!("source")).resolves.toBeUndefined();
    shell.getSnapshot.mockReturnValue({ sessions: [{ sessionId: "source", lastTurnId: "historical" }], turns: [] });
    await expect(runner.resolveSourceTurn!("source")).resolves.toBe("historical");
    shell.ensureSessionLoadedForRead.mockResolvedValue(false);
    await expect(runner.resolveSourceTurn!("missing")).rejects.toThrow("Source session not found");
  });
  it("releases the execution environment through the session facade", async () => {
    const shell = { releaseSessionExecution: vi.fn().mockResolvedValue(undefined) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    await runner.release("worker");
    expect(shell.releaseSessionExecution).toHaveBeenCalledWith("worker");
    shell.releaseSessionExecution.mockRejectedValue(new Error("turn is active"));
    await expect(runner.release("worker")).rejects.toThrow("turn is active");
  });
  it.each([true, false])("forks a preparation session without replacing its inherited role instructions (cached=%s)", async (cached) => {
    const shell = {
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      listWorkspaces: async () => ({ workspaces: [{ workspaceId: "workspace", absolutePath: "I:/workspace" }] }),
      getChatTree: async () => ({ treeId: "tree" }),
      getSettings: async () => ({ executionPreferencesByEngineId: {} }),
      getSnapshot: () => ({ turns: cached ? [{ sessionId: "source", turnId: "turn", status: "completed" }] : [] }),
      runSessionAction: vi.fn().mockResolvedValue({ action: "fork", status: "forked", forkedSessionId: "worker" }),
      setSessionTitle: vi.fn(), openSession: vi.fn()
    };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    await expect(runner.fork({ sourceSessionId: "source", sourceTurnId: "turn", workspaceId: "workspace",
      title: "Work", metadata: { role: "work-preparation", workItemId: "item", treeSessionId: "tree" } }))
      .resolves.toEqual({ sessionId: "worker", treeId: "tree" });
    expect(shell.runSessionAction).toHaveBeenCalledWith(expect.objectContaining({ action: "fork", fromTurnId: "turn",
      activateFork: false, developerInstructions: undefined,
      metadata: expect.objectContaining({ role: "work-preparation", workItemId: "item", sourceSessionId: "source", treeSessionId: "tree" }) }));
    expect(shell.openSession).not.toHaveBeenCalled();
  });

  it("rejects a running fork point before creating a provider thread", async () => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      listWorkspaces: async () => ({ workspaces: [{ workspaceId: "workspace", absolutePath: "I:/workspace" }] }),
      getChatTree: async () => ({ treeId: "tree" }),
      getSnapshot: () => ({ turns: [{ sessionId: "source", turnId: "turn", status: "running" }] }), runSessionAction: vi.fn() };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    await expect(runner.fork({ sourceSessionId: "source", sourceTurnId: "turn", workspaceId: "workspace",
      title: "Work", developerInstructions: "Worker role", metadata: {} })).rejects.toThrow("completed source turn");
    expect(shell.runSessionAction).not.toHaveBeenCalled();
  });

  it("forwards the failed turn's runtime reason without leaking it into later turns", () => {
    let emit: (envelope: { event: Record<string, unknown> }) => void = () => {};
    const shell = { subscribe: vi.fn((listener) => { emit = listener; return () => {}; }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    const completed = vi.fn();
    runner.onTurnCompleted(completed);
    emit({ event: { type: "runtime.error", sessionId: "worker", turnId: "t1", message: "quota exceeded", recoverable: false } });
    emit({ event: { type: "turn.completed", sessionId: "worker", turnId: "t1", finishReason: "failed" } });
    expect(completed).toHaveBeenLastCalledWith({ sessionId: "worker", turnId: "t1", finishReason: "failed", failure: "quota exceeded" });
    emit({ event: { type: "runtime.error", sessionId: "worker", turnId: "t2", message: "retrying", recoverable: true } });
    emit({ event: { type: "turn.completed", sessionId: "worker", turnId: "t2", finishReason: "interrupted" } });
    expect(completed).toHaveBeenLastCalledWith({ sessionId: "worker", turnId: "t2", finishReason: "interrupted", failure: undefined });
  });

  const setup = () => {
    const shell = {
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      runSessionAction: vi.fn().mockResolvedValue({ action: "resume", resumed: true }),
      setSessionTitle: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ executionPreferencesByEngineId: {} }),
      openSession: vi.fn().mockRejectedValue(new Error("Open session cancelled."))
    };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    return { shell, runner };
  };

  it("loads and resumes the provider session independently of foreground session opening", async () => {
    const { shell, runner } = setup();
    await expect(runner.resume("worker")).resolves.toBe(true);
    expect(shell.ensureSessionLoadedForRead).toHaveBeenCalledWith("worker");
    expect(shell.runSessionAction).toHaveBeenCalledWith({ sessionId: "worker", action: "resume", preserveExecution: true });
    expect(shell.openSession).not.toHaveBeenCalled();
    expect(shell.getSettings).not.toHaveBeenCalled();
  });

  it("applies the execution role and model profile when resuming a prepared session", async () => {
    const { shell, runner } = setup();
    await expect(runner.resume("worker", { developerInstructions: "Worker role",
      modelConfig: { modelId: "execution-model" }, metadata: { role: "worker", workItemId: "item" } })).resolves.toBe(true);
    expect(shell.runSessionAction).toHaveBeenCalledWith({ sessionId: "worker", action: "resume", preserveExecution: true,
      developerInstructions: "Worker role", metadata: expect.objectContaining({ role: "worker", workItemId: "item",
        sessionProfile: expect.objectContaining({ engineId: "codex", modelId: "execution-model" }) }) });
  });

  it("reports a missing session without trying to resume it", async () => {
    const { shell, runner } = setup();
    shell.ensureSessionLoadedForRead.mockResolvedValue(false);
    await expect(runner.resume("missing")).resolves.toBe(false);
    expect(shell.runSessionAction).not.toHaveBeenCalled();
  });

  it("names the claimed Worker after its work item once resumed", async () => {
    const { shell, runner } = setup();
    const options = { cwd: "I:/worktree", title: "Worker · Greeting", metadata: { workItemId: "item" } };
    await expect(runner.resume("worker", options)).resolves.toBe(true);
    expect(shell.setSessionTitle).toHaveBeenCalledWith("worker", "Worker · Greeting");
    expect(shell.runSessionAction).toHaveBeenCalledWith({ sessionId: "worker", action: "resume", preserveExecution: true,
      cwd: "I:/worktree", metadata: { workItemId: "item" } });
    expect(shell.openSession).not.toHaveBeenCalled();
  });

  it("preserves the provider failure so recovery can report its cause", async () => {
    const { shell, runner } = setup();
    shell.runSessionAction.mockRejectedValue(new Error("Thread not found"));
    await expect(runner.resume("worker")).rejects.toThrow("Thread not found");
  });
});
