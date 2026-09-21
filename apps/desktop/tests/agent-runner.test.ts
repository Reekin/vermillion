import { describe, expect, it, vi } from "vitest";
import { createAgentRunner, createSessionSteerer, createSourceAsker } from "../src/electron/agent-runner.js";

describe("AgentRunner recovery", () => {
  it.each(["send", "steer"] as const)("preserves a known rejection from scheduled %s", async (method) => {
    const shell = {
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      getActiveTurnId: () => undefined,
      getSnapshot: () => ({ turns: [] }),
      executeCommand: vi.fn().mockResolvedValue({ accepted: false, error: { code: "rejected", message: "引擎明确拒绝" } })
    };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    await expect(runner[method]("worker", "continue"))
      .resolves.toMatchObject({ accepted: false, error: { code: "rejected", message: "引擎明确拒绝" } });
  });

  it("returns a pending receipt when a provider-addressed Worker is blocked", async () => {
    const shell = {
      resolveSessionIdentifier: () => "codex-thread:worker",
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      getActiveTurnId: () => undefined,
      getSnapshot: () => ({ turns: [] }),
      executeCommand: vi.fn().mockResolvedValue({
        accepted: false, queued: { messageId: "queued-message", reason: "等待前置工单", workItemId: "blocked" }
      })
    };
    await expect(createSessionSteerer(shell as unknown as Parameters<typeof createSessionSteerer>[0])("worker", "继续"))
      .resolves.toEqual({ sessionId: "codex-thread:worker", accepted: false,
        queued: { messageId: "queued-message", reason: "等待前置工单", workItemId: "blocked" } });
  });

  it("returns canonical delivery for generic session steering", async () => {
    const shell = {
      resolveSessionIdentifier: vi.fn((sessionId: string) => sessionId),
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      getActiveTurnId: vi.fn().mockReturnValue("active-turn"),
      executeCommand: vi.fn().mockResolvedValue({ accepted: true, turnId: "actual-turn", delivery: "steered" })
    };

    await expect(createSessionSteerer(shell as unknown as Parameters<typeof createSessionSteerer>[0])("target", "continue"))
      .resolves.toEqual({ sessionId: "target", turnId: "actual-turn", delivery: "steered" });
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "steerTurn", sessionId: "target", turnId: "active-turn", content: "continue"
    }) }));
  });

  it("starts a new turn when generic steering finds an idle session", async () => {
    const shell = {
      resolveSessionIdentifier: vi.fn((sessionId: string) => sessionId),
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      getActiveTurnId: vi.fn().mockReturnValue(undefined),
      getSnapshot: vi.fn().mockReturnValue({ turns: [] }),
      executeCommand: vi.fn().mockResolvedValue({ accepted: true, turnId: "started-turn" })
    };

    await expect(createSessionSteerer(shell as unknown as Parameters<typeof createSessionSteerer>[0])("target", "start"))
      .resolves.toEqual({ sessionId: "target", turnId: "started-turn", delivery: "started" });
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "sendUserMessage", sessionId: "target", content: "start"
    }) }));
  });

  it("steers a cold-loaded active turn from hydrated transcript state", async () => {
    const shell = {
      resolveSessionIdentifier: vi.fn((sessionId: string) => sessionId),
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      getActiveTurnId: vi.fn().mockReturnValue(undefined),
      getSnapshot: vi.fn().mockReturnValue({ turns: [{ sessionId: "target", turnId: "cold-turn", status: "streaming" }] }),
      executeCommand: vi.fn().mockResolvedValue({ accepted: true, turnId: "cold-turn", delivery: "steered" })
    };

    await expect(createSessionSteerer(shell as unknown as Parameters<typeof createSessionSteerer>[0])("target", "continue"))
      .resolves.toMatchObject({ turnId: "cold-turn", delivery: "steered" });
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "steerTurn", sessionId: "target", turnId: "cold-turn", content: "continue"
    }) }));
  });

  it("steers a session addressed by its engine session id", async () => {
    const shell = {
      resolveSessionIdentifier: vi.fn((sessionId: string) =>
        sessionId === "thread-subagent" ? "codex-thread:thread-subagent" : undefined),
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      getActiveTurnId: vi.fn().mockReturnValue("active-turn"),
      executeCommand: vi.fn().mockResolvedValue({ accepted: true, turnId: "actual-turn", delivery: "steered" })
    };
    const steer = createSessionSteerer(shell as unknown as Parameters<typeof createSessionSteerer>[0]);

    await expect(steer("thread-subagent", "continue")).resolves.toEqual({
      sessionId: "codex-thread:thread-subagent", turnId: "actual-turn", delivery: "steered"
    });
    expect(shell.ensureSessionLoadedForRead).toHaveBeenCalledWith("codex-thread:thread-subagent");
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "steerTurn", sessionId: "codex-thread:thread-subagent", turnId: "active-turn", content: "continue"
    }) }));
    await expect(steer("thread-missing", "continue")).rejects.toThrow("Session not found: thread-missing");
  });

  it("asks from the recorded source turn and archives the temporary design fork", async () => {
    let emit: ((envelope: { event: Record<string, unknown> }) => void) | undefined;
    const shell = {
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      listSessions: () => [{ sessionId: "design", engineId: "codex" }],
      getSettings: vi.fn().mockResolvedValue({ executionPreferencesByEngineId: {} }),
      runSessionAction: vi.fn().mockImplementation(async (input: { action: string }) =>
        input.action === "fork"
          ? { action: "fork", status: "forked", forkedSessionId: "ask-session" }
          : { action: "archive", archived: true }),
      setSessionTitle: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((listener) => { emit = listener; return () => { emit = undefined; }; }),
      executeCommand: vi.fn().mockImplementation(async () => {
        queueMicrotask(() => emit?.({ event: { type: "turn.completed", sessionId: "ask-session", turnId: "ask-turn", finishReason: "completed" } }));
        return { accepted: true, turnId: "ask-turn" };
      }),
      getSnapshot: vi.fn().mockReturnValue({
        turns: [{ sessionId: "ask-session", turnId: "ask-turn" }],
        messageBlocks: [{
          blockId: "answer-block", messageId: "answer", sessionId: "ask-session", turnId: "ask-turn",
          role: "assistant", phase: "final_answer", kind: "markdown", text: "Use the original design.",
          startedAt: "2026-06-06T00:00:01.000Z"
        }]
      })
    };
    const asker = createSourceAsker(
      shell as unknown as Parameters<typeof createSourceAsker>[0],
      async () => ({ cwd: "I:/project", modelConfig: { modelId: "design-model", reasoningOptionId: "high", serviceTierId: null } })
    );

    await expect(asker({ workspaceId: "workspace", workItemId: "item", sourceSessionId: "design", sourceTurnId: "source-turn", question: "Clarify the boundary." }))
      .resolves.toMatchObject({ answer: "Use the original design.", askSessionId: "ask-session", askTurnId: "ask-turn", archived: true });
    expect(shell.runSessionAction).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: "design", action: "fork", fromTurnId: "source-turn", activateFork: false,
      cwd: "I:/project",
      metadata: expect.objectContaining({ role: "design-partner", workItemId: "item", sourceTurnId: "source-turn", asksource: true })
    }));
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "sendUserMessage", sessionId: "ask-session", content: "Clarify the boundary.",
      execution: { modelId: "design-model", reasoningOptionId: "high", serviceTierId: null }
    }) }));
    expect(shell.runSessionAction).toHaveBeenLastCalledWith({ sessionId: "ask-session", action: "archive" });
  });

  it("archives the temporary design fork when the source question fails", async () => {
    const unsubscribe = vi.fn();
    const shell = {
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      listSessions: () => [{ sessionId: "design", engineId: "codex" }],
      getSettings: vi.fn().mockResolvedValue({ executionPreferencesByEngineId: {} }),
      runSessionAction: vi.fn().mockImplementation(async (input: { action: string }) =>
        input.action === "fork" ? { action: "fork", status: "forked", forkedSessionId: "ask-session" } : { action: "archive", archived: true }),
      setSessionTitle: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => unsubscribe),
      executeCommand: vi.fn().mockRejectedValue(new Error("provider unavailable"))
    };
    const asker = createSourceAsker(
      shell as unknown as Parameters<typeof createSourceAsker>[0],
      async () => ({ cwd: "I:/project" })
    );

    await expect(asker({ workspaceId: "workspace", workItemId: "item", sourceSessionId: "design", sourceTurnId: "source-turn", question: "Clarify" }))
      .rejects.toThrow("temporary fork archived");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(shell.runSessionAction).toHaveBeenLastCalledWith({ sessionId: "ask-session", action: "archive" });
  });

  it.each([
    { delivery: "start_or_steer", expected: { turnId: "actual", delivery: "started" } },
    { delivery: "steered", expected: { turnId: "actual", delivery: "steered" } }
  ])("uses confirmed shared delivery instead of the requested turn: $delivery", async ({ delivery, expected }) => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true), getActiveTurnId: () => "ended", executeCommand: vi.fn()
      .mockResolvedValueOnce({ accepted: true, turnId: "actual", delivery }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    const receipt = await runner.steer("worker", "update");
    expect(receipt).toMatchObject(expected);
    // The caller supplies the message id so the receipt stays the only record of who opened the turn.
    expect(receipt.messageId).toEqual(expect.any(String));
    expect(shell.executeCommand.mock.calls.map(([input]) => input.command.type)).toEqual(["steerTurn"]);
    expect(vi.mocked(shell.executeCommand).mock.calls[0]![0].command).toMatchObject({ messageId: receipt.messageId });
  });

  it.each(["connection lost", "no active turn to steer"])("leaves shared delivery failures to the caller without retrying: %s", async (message) => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true), getActiveTurnId: () => "running", executeCommand: vi.fn().mockRejectedValue(new Error(message)) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    await expect(runner.steer("worker", "update")).rejects.toThrow(message);
    expect(shell.executeCommand).toHaveBeenCalledOnce();
  });

  it("uses execution state instead of stale transcript state", async () => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true), getActiveTurnId: () => undefined,
      getSnapshot: () => ({ turns: [{ sessionId: "worker", turnId: "old", status: "completed" }] }),
      executeCommand: vi.fn().mockResolvedValue({ accepted: true }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    expect(runner.isActive!("worker")).toBe(false);
    await runner.steer("worker", "continue");
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ type: "sendUserMessage" }) }));
  });
  it("forwards attachments and selected execution with the first preparation message", async () => {
    const shell = { executeCommand: vi.fn().mockResolvedValue({ accepted: true, turnId: "started" }), getActiveTurnId: () => undefined };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    const options = { attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png" }],
      execution: { modelId: "selected", reasoningOptionId: "high", serviceTierId: null } };
    const receipt = await runner.send("worker", "User input\n\nPreparation prompt", { ...options, messageId: "caller-message" });
    expect(receipt).toEqual({ turnId: "started", messageId: "caller-message" });
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({
      type: "sendUserMessage", sessionId: "worker", messageId: "caller-message", content: "User input\n\nPreparation prompt", ...options
    }) }));
  });

  it("distinguishes verified empty sources from paged history and unknown sessions", async () => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true), getChatTree: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue({ sessions: [{ sessionId: "source" }], turns: [] }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    await expect(runner.resolveSourceTurn!("source")).resolves.toBeUndefined();
    shell.getSnapshot.mockReturnValue({ sessions: [{ sessionId: "source", lastTurnId: "historical" }], turns: [] });
    await expect(runner.resolveSourceTurn!("source")).resolves.toBe("historical");
    shell.ensureSessionLoadedForRead.mockResolvedValue(false);
    await expect(runner.resolveSourceTurn!("missing")).rejects.toThrow("Source session not found");
  });
  it("releases the execution environment through the session facade", async () => {
    const shell = { releaseSessionExecution: vi.fn().mockResolvedValue(undefined) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    await runner.release("worker");
    expect(shell.releaseSessionExecution).toHaveBeenCalledWith("worker");
    shell.releaseSessionExecution.mockRejectedValue(new Error("turn is active"));
    await expect(runner.release("worker")).rejects.toThrow("turn is active");
  });
  it.each([true, false])("forks a preparation session without replacing its inherited role instructions (cached=%s)", async (cached) => {
    const shell = {
      ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      listSessions: () => [{ sessionId: "source", engineId: "codex" }],
      listEngines: () => [{ engineId: "codex", displayName: "Codex" }],
      listWorkspaces: async () => ({ workspaces: [{ workspaceId: "workspace", absolutePath: "I:/workspace" }] }),
      getChatTree: async () => ({ treeId: "tree" }),
      getSettings: async () => ({ executionPreferencesByEngineId: {} }),
      getSnapshot: () => ({ turns: cached ? [{ sessionId: "source", turnId: "turn", status: "completed" }] : [] }),
      runSessionAction: vi.fn().mockResolvedValue({ action: "fork", status: "forked", forkedSessionId: "worker" }),
      setSessionTitle: vi.fn(), openSession: vi.fn()
    };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    await expect(runner.fork({ sourceSessionId: "source", sourceTurnId: "turn", workspaceId: "workspace",
      title: "Work", metadata: { role: "work-preparation", workItemId: "item", treeSessionId: "tree" } }))
      .resolves.toEqual({ sessionId: "worker", treeId: "tree" });
    expect(shell.runSessionAction).toHaveBeenCalledWith(expect.objectContaining({ action: "fork", fromTurnId: "turn",
      activateFork: false,
      metadata: expect.objectContaining({ role: "work-preparation", workItemId: "item", sourceSessionId: "source", treeSessionId: "tree" }) }));
    expect(shell.openSession).not.toHaveBeenCalled();
  });

  it("rejects a running fork point before creating a provider thread", async () => {
    const shell = { ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
      listSessions: () => [{ sessionId: "source", engineId: "codex" }],
      listEngines: () => [{ engineId: "codex", displayName: "Codex" }],
      listWorkspaces: async () => ({ workspaces: [{ workspaceId: "workspace", absolutePath: "I:/workspace" }] }),
      getChatTree: async () => ({ treeId: "tree" }),
      getSnapshot: () => ({ turns: [{ sessionId: "source", turnId: "turn", status: "running" }] }), runSessionAction: vi.fn() };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
    await expect(runner.fork({ sourceSessionId: "source", sourceTurnId: "turn", workspaceId: "workspace",
      title: "Work", metadata: {} })).rejects.toThrow("completed source turn");
    expect(shell.runSessionAction).not.toHaveBeenCalled();
  });

  it("forwards the failed turn's runtime reason without leaking it into later turns", () => {
    let emit: (envelope: { event: Record<string, unknown> }) => void = () => {};
    const shell = { subscribe: vi.fn((listener) => { emit = listener; return () => {}; }) };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
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
      listSessions: () => [{ sessionId: "worker", engineId: "codex" }],
      listEngines: () => [{ engineId: "codex", displayName: "Codex" }],
      runSessionAction: vi.fn().mockResolvedValue({ action: "resume", resumed: true }),
      setSessionTitle: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ executionPreferencesByEngineId: {} }),
      openSession: vi.fn().mockRejectedValue(new Error("Open session cancelled."))
    };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0]);
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
    await expect(runner.resume("worker", {
      modelConfig: { modelId: "execution-model" }, metadata: { role: "worker", workItemId: "item" } })).resolves.toBe(true);
    expect(shell.runSessionAction).toHaveBeenCalledWith({ sessionId: "worker", action: "resume", preserveExecution: true,
      metadata: expect.objectContaining({ role: "worker", workItemId: "item",
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
