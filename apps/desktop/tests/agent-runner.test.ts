import { describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../src/electron/agent-runner.js";

describe("AgentRunner recovery", () => {
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
      openSession: vi.fn().mockRejectedValue(new Error("Open session cancelled."))
    };
    const runner = createAgentRunner(shell as unknown as Parameters<typeof createAgentRunner>[0], "codex");
    return { shell, runner };
  };

  it("loads and resumes the provider session independently of foreground session opening", async () => {
    const { shell, runner } = setup();
    await expect(runner.resume("worker")).resolves.toBe(true);
    expect(shell.ensureSessionLoadedForRead).toHaveBeenCalledWith("worker");
    expect(shell.runSessionAction).toHaveBeenCalledWith({ sessionId: "worker", action: "resume" });
    expect(shell.openSession).not.toHaveBeenCalled();
  });

  it("reports a missing session without trying to resume it", async () => {
    const { shell, runner } = setup();
    shell.ensureSessionLoadedForRead.mockResolvedValue(false);
    await expect(runner.resume("missing")).resolves.toBe(false);
    expect(shell.runSessionAction).not.toHaveBeenCalled();
  });

  it("reports a provider session that cannot resume", async () => {
    const { shell, runner } = setup();
    shell.runSessionAction.mockRejectedValue(new Error("Thread not found"));
    await expect(runner.resume("worker")).resolves.toBe(false);
  });
});
