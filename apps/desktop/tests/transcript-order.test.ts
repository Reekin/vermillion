import { describe, expect, it } from "vitest";
import { DomainProjector } from "@vermillion/core";
import { parseDomainSnapshot } from "@vermillion/shared";
import { createRendererStore } from "../src/store/store.js";
import { buildTurnTranscriptRows } from "../src/ui/chat-shell/transcript-view-model.js";
import { buildTurnHistoryItems } from "../src/ui/chat-shell/TurnProcessPanel.js";

describe("transcript item order", () => {
  it("keeps interleaved engine items in the same order while running and after completion", () => {
    const early = "2026-09-28T14:12:06.000Z";
    const late = "2026-09-28T14:13:02.000Z";
    const snapshot = parseDomainSnapshot({
      turns: [{
        turnId: "turn", sessionId: "session", status: "streaming", startedAt: early,
        messageIds: ["first", "second", "final"], toolCallIds: ["generate", "view", "edit"],
        finalMessageId: "final",
        transcriptItemIds: ["message:first", "tool:generate", "message:second", "tool:view", "tool:edit", "message:final"]
      }],
      messageBlocks: ["first", "second", "final"].map((id) => ({
        blockId: id, messageId: id, turnId: "turn", sessionId: "session",
        role: "assistant", kind: "markdown", text: id,
        phase: id === "final" ? "final_answer" : "commentary", startedAt: late
      })),
      toolCalls: ["generate", "view", "edit"].map((id, index) => ({
        toolCallId: id, turnId: "turn", sessionId: "session", status: "completed",
        toolName: ["imageGeneration", "imageView", "fileChange"][index], startedAt: early
      }))
    });
    const store = createRendererStore();
    store.hydrateSnapshot(snapshot);
    const running = buildTurnTranscriptRows(store.getDomainReadModel(), snapshot.turns);
    expect(running.map((row) => row.blocks[0]?.messageId ?? row.toolCalls[0]?.toolCallId))
      .toEqual(["first", "generate", "second", "view", "edit", "final"]);
    const completed = buildTurnTranscriptRows(store.getDomainReadModel(), [{ ...snapshot.turns[0]!, status: "completed" }]);
    const final = completed.find((row) => row.isFinalResponseRow)!;
    expect(buildTurnHistoryItems(final, completed.filter((row) => !row.isFinalResponseRow)).map((item) => item.id))
      .toEqual(["message:first", "tool:generate", "message:second", "tool:view", "tool:edit"]);
    expect(buildTurnHistoryItems(final, []).map((item) => item.id))
      .toEqual(["tool:generate", "tool:view", "tool:edit"]);
  });

  it("records first appearance once, independently of timestamps and completion order", () => {
    const projector = new DomainProjector();
    const sessionId = "session";
    const turnId = "turn";
    const at = "2026-09-28T14:12:06.000Z";
    projector.apply({ type: "session.created", conversationId: "conversation", sessionId, engineId: "codex", status: "running" }, at);
    projector.apply({ type: "turn.started", sessionId, turnId }, at);
    projector.apply({ type: "message.started", engineId: "codex", sessionId, turnId, messageId: "first", role: "assistant" }, at);
    projector.apply({ type: "tool.started", engineId: "codex", sessionId, turnId, toolCallId: "generate", toolName: "imageGeneration" }, at);
    projector.apply({ type: "message.started", engineId: "codex", sessionId, turnId, messageId: "second", role: "assistant" }, at);
    projector.apply({ type: "tool.completed", engineId: "codex", sessionId, turnId, toolCallId: "generate", toolName: "imageGeneration", status: "completed" }, at);
    projector.apply({ type: "turn.completed", sessionId, turnId, finishReason: "completed" }, at);
    expect(projector.store.getTurn(turnId)?.transcriptItemIds)
      .toEqual(["message:first", "tool:generate", "message:second"]);
  });
});
