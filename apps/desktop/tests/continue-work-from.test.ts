import { describe, expect, it, vi } from "vitest";
import type { RuntimeCommandReceiptRpc } from "@vermillion/shared";
import type { ComposerSubmitHandler } from "../src/ui/chat-shell/composer/composer-types.js";
import { continueWorkFrom } from "../src/ui/app/continue-work-from.js";

const setup = () => {
  const request = vi.fn(async () => ({ run: { sessionId: "new-worker" } }));
  const send = vi.fn(async (): Promise<RuntimeCommandReceiptRpc> => ({ accepted: true }));
  const payload = { sessionId: "old-worker", content: "continue with this adjustment",
    attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png" }],
    execution: { modelId: "chosen-model", reasoningOptionId: "max" } };
  const submitUsing = vi.fn(async (handler: ComposerSubmitHandler) => { await handler(payload); });
  const input = { client: { request }, transport: { chat: { send } }, composer: { hasContent: true, canSubmit: true, submitUsing },
    workspaceId: "workspace", target: { workItemId: "item" }, sessionId: "old-worker", turnId: "historical-turn", open: vi.fn(async () => {})
  } as unknown as Parameters<typeof continueWorkFrom>[0];
  return { input, request, send, payload, submitUsing };
};

describe("continue execution from history", () => {
  it("uses preparation ownership before a Worker exists", async () => {
    const { input, request, send, payload } = setup();
    input.target = { requestId: "preparation" };
    request.mockResolvedValueOnce({ workerSessionId: "new-preparation" } as unknown as Awaited<ReturnType<typeof request>>);
    await continueWorkFrom(input);
    expect(request).toHaveBeenCalledExactlyOnceWith("work.continueFrom", {
      workspaceId: "workspace", requestId: "preparation", sessionId: "old-worker", turnId: "historical-turn"
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({ ...payload, sessionId: "new-preparation" });
  });
  it("transfers the explicit target then sends the captured attachments and configuration to its new branch", async () => {
    const { input, request, send, payload } = setup();
    send.mockResolvedValueOnce({ accepted: false, queued: { messageId: "queued", reason: "等待资源" } });
    await continueWorkFrom(input);
    expect(request).toHaveBeenCalledWith("workItem.continueFrom", {
      workspaceId: "workspace", workItemId: "item", sessionId: "old-worker", turnId: "historical-turn"
    });
    expect(input.open).toHaveBeenCalledWith("workspace", "new-worker");
    expect(send).toHaveBeenCalledExactlyOnceWith({ ...payload, sessionId: "new-worker" });
  });

  it("does not send when transfer fails, and rejects so the composer retains its draft", async () => {
    const { input, request, send } = setup();
    request.mockRejectedValueOnce(new Error("old execution has not stopped"));
    await expect(continueWorkFrom(input)).rejects.toThrow("old execution has not stopped");
    expect(send).not.toHaveBeenCalled();
    expect(input.open).not.toHaveBeenCalled();
  });

  it("keeps the new target visible and rejects an engine refusal so its draft can be retried there", async () => {
    const { input, send } = setup();
    send.mockResolvedValueOnce({ accepted: false });
    await expect(continueWorkFrom(input)).rejects.toThrow("消息仍保留在输入器中");
    expect(input.open).toHaveBeenCalledWith("workspace", "new-worker");
  });

  it("transfers an empty composer without manufacturing a message", async () => {
    const { input, send, submitUsing } = setup();
    input.composer!.hasContent = false;
    await continueWorkFrom(input);
    expect(input.open).toHaveBeenCalledWith("workspace", "new-worker");
    expect(submitUsing).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
