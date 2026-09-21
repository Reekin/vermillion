import { describe, expect, it, vi } from "vitest";
import type { SessionCommandDispatch } from "@vermillion/desktop-server";
import type { CommandEnvelope, RuntimeCommandReceiptRpc } from "@vermillion/shared";
import type { MessageDeliveryPort } from "@vermillion/workbench";
import { connectExecutionDispatch } from "../src/electron/execution-dispatch.js";

const message: CommandEnvelope = {
  commandId: "command-1",
  command: {
    type: "sendUserMessage", sessionId: "worker", messageId: "message-1", content: "继续",
    attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "data:image/png;base64,AA==" }],
    execution: { modelId: "test-model", reasoningOptionId: "high" }
  }
};

function setup(blocked = false, activeTurnId?: string) {
  let dispatch: SessionCommandDispatch;
  let delivery: MessageDeliveryPort;
  const raw = vi.fn(async (input: CommandEnvelope): Promise<RuntimeCommandReceiptRpc> => ({
    commandId: input.commandId, commandType: input.command.type, accepted: true,
    sessionId: "worker", turnId: activeTurnId ?? "new-turn", providerSessionId: "provider-worker",
    ...(activeTurnId ? { delivery: "steered" as const } : {})
  }));
  const shell = {
    setCommandDispatch: (handler: SessionCommandDispatch) => { dispatch = handler; },
    getActiveTurnId: vi.fn().mockReturnValue(activeTurnId),
    ensureSessionLoadedForRead: vi.fn().mockResolvedValue(true),
    executeCommand: (input: CommandEnvelope) => dispatch(input, raw)
  };
  const admit = vi.fn(async (input, send) => blocked
    ? { accepted: false, queued: { messageId: input.messageId, reason: "等待前置工单", workItemId: "wi-dependency" } }
    : send(input));
  const disconnect = vi.fn();
  connectExecutionDispatch(shell, {
    dispatchSessionMessage: admit,
    setMessageDeliveryPort: (port) => { delivery = port; return disconnect; }
  });
  return { shell, raw, admit, delivery: () => delivery };
}

describe("desktop execution dispatch", () => {
  it("requests new admission if the active turn ends while history is loading", async () => {
    const f = setup(false, "old-turn");
    f.admit.mockImplementation(async (input, send) => send({ ...input, allowStart: false }));
    f.shell.ensureSessionLoadedForRead.mockImplementation(async () => { f.shell.getActiveTurnId.mockReturnValue(undefined); return true; });
    expect(await f.shell.executeCommand(message)).toMatchObject({ accepted: false, error: { code: "execution_readmission_required" } });
    expect(f.raw).not.toHaveBeenCalled();
  });

  it("returns queued without invoking the engine and retains the submitted payload", async () => {
    const f = setup(true);
    expect(await f.shell.executeCommand(message)).toMatchObject({
      accepted: false, queued: { messageId: "message-1", workItemId: "wi-dependency" }
    });
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.shell.ensureSessionLoadedForRead).not.toHaveBeenCalled();
    expect(f.admit.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "worker", messageId: "message-1", content: "继续",
      attachments: [{ attachmentId: "image" }], execution: { modelId: "test-model" }
    });
  });

  it("delivers ordinary messages through admission and retains configuration and attachments", async () => {
    const f = setup();
    expect(await f.shell.executeCommand(message)).toMatchObject({ accepted: true, turnId: "new-turn", providerSessionId: "provider-worker" });
    expect(f.raw).toHaveBeenCalledWith(message);
  });

  it("joins the current active turn instead of opening a second execution", async () => {
    const f = setup(false, "active-turn");
    expect(await f.shell.executeCommand(message)).toMatchObject({ accepted: true, delivery: "steered", turnId: "active-turn" });
    expect(f.raw.mock.calls[0]?.[0].command).toMatchObject({ type: "steerTurn", turnId: "active-turn", messageId: "message-1" });
    const stop: CommandEnvelope = { commandId: "stop", command: { type: "interruptTurn", sessionId: "worker", turnId: "active-turn" } };
    await f.shell.executeCommand(stop);
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.raw).toHaveBeenLastCalledWith(stop);
  });

  it("distinguishes a known engine rejection from an unknown transport outcome", async () => {
    const f = setup();
    f.raw.mockResolvedValueOnce({ commandId: "command-1", commandType: "sendUserMessage", accepted: false,
      error: { code: "busy", message: "引擎拒绝新轮" } });
    expect(await f.shell.executeCommand(message)).toMatchObject({ accepted: false,
      error: { code: "busy", message: "引擎拒绝新轮" } });
    f.raw.mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.shell.executeCommand(message)).rejects.toThrow("connection lost");
  });
});
