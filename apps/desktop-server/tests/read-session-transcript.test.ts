import { describe, expect, it } from "vitest";
import type { ChatSession, DomainSnapshot, MessageBlock, Turn } from "@vermillion/shared";
import { buildReadSessionTranscript } from "../src/read-session-transcript.js";

const baseSession: ChatSession = {
  sessionId: "session-1",
  conversationId: "conversation-1",
  engineId: "codex",
  status: "idle",
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:05:00.000Z"
};

const baseSnapshot = (
  turns: Turn[],
  messageBlocks: MessageBlock[],
  session: ChatSession = baseSession
): DomainSnapshot => ({
  conversations: [{
    conversationId: "conversation-1",
    participantEngineIds: ["codex"],
    activeSessionId: "session-1",
    sessionIds: ["session-1"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:05:00.000Z"
  }],
  sessions: [session],
  turns,
  messageBlocks,
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  runtimeInteractions: [],
  participants: [],
  threadGoals: [],
  sessionRelations: []
});

const turn = (input: Partial<Turn> & Pick<Turn, "turnId">): Turn => ({
  sessionId: "session-1",
  status: "completed",
  finishReason: "completed",
  startedAt: "2026-06-06T00:01:00.000Z",
  completedAt: "2026-06-06T00:01:10.000Z",
  messageIds: [],
  toolCallIds: [],
  terminalIds: [],
  approvalRequestIds: [],
  interactionRequestIds: [],
  ...input
});

const block = (
  input: Partial<MessageBlock> & Pick<MessageBlock, "blockId" | "messageId" | "turnId" | "role" | "text">
): MessageBlock => ({
  sessionId: "session-1",
  kind: "markdown",
  startedAt: "2026-06-06T00:01:01.000Z",
  ...input
});

describe("buildReadSessionTranscript", () => {
  it("returns user, commentary, final, and in-progress agent messages", () => {
    const snapshot = baseSnapshot([
      turn({
        turnId: "turn-1",
        status: "streaming",
        messageIds: ["user-1", "agent-commentary", "agent-final", "agent-live"]
      })
    ], [
      block({ blockId: "user", messageId: "user-1", turnId: "turn-1", role: "user", text: "Inspect this.", startedAt: "2026-06-06T00:01:01.000Z" }),
      block({ blockId: "commentary", messageId: "agent-commentary", turnId: "turn-1", role: "assistant", phase: "commentary", text: "I am checking.", startedAt: "2026-06-06T00:01:02.000Z" }),
      block({ blockId: "final", messageId: "agent-final", turnId: "turn-1", role: "assistant", phase: "final_answer", text: "The result is ready.", startedAt: "2026-06-06T00:01:03.000Z" }),
      block({ blockId: "live", messageId: "agent-live", turnId: "turn-1", role: "assistant", phase: "commentary", text: "Still working.", startedAt: "2026-06-06T00:01:04.000Z", completedAt: undefined }),
      block({ blockId: "tool", messageId: "tool-1", turnId: "turn-1", role: "assistant", kind: "tool_ref", text: "do not expose" }),
      block({ blockId: "system", messageId: "system-1", turnId: "turn-1", role: "system", text: "do not expose" })
    ]);

    const result = buildReadSessionTranscript({ snapshot, sessionId: "session-1" });

    expect(result.sessionStatus).toBe("idle");
    expect(result.activeTurnId).toBe("turn-1");
    expect(result.messages).toEqual([
      expect.objectContaining({ messageId: "user-1", sender: "user", text: "Inspect this." }),
      expect.objectContaining({ messageId: "agent-commentary", sender: "agent", phase: "commentary", text: "I am checking." }),
      expect.objectContaining({ messageId: "agent-final", sender: "agent", phase: "final_answer", text: "The result is ready." }),
      expect.objectContaining({ messageId: "agent-live", sender: "agent", phase: "commentary", text: "Still working." })
    ]);
    expect(JSON.stringify(result)).not.toContain("do not expose");
  });

  it("merges streaming blocks by message id and resolves a stale block turn from turn message ids", () => {
    const snapshot = baseSnapshot([
      turn({ turnId: "turn-1", messageIds: ["user-1", "agent-1"] })
    ], [
      block({ blockId: "user", messageId: "user-1", turnId: "stale-turn", role: "user", text: "Question" }),
      block({ blockId: "agent-a", messageId: "agent-1", turnId: "stale-turn", role: "assistant", phase: "commentary", text: "first", startedAt: "2026-06-06T00:01:02.000Z" }),
      block({ blockId: "agent-b", messageId: "agent-1", turnId: "stale-turn", role: "assistant", phase: "commentary", text: "second", startedAt: "2026-06-06T00:01:03.000Z", completedAt: "2026-06-06T00:01:04.000Z" })
    ]);

    const result = buildReadSessionTranscript({ snapshot, sessionId: "session-1" });

    expect(result.totalMessageCount).toBe(2);
    expect(result.messages).toEqual([
      expect.objectContaining({ messageId: "user-1", turnId: "turn-1" }),
      expect.objectContaining({ messageId: "agent-1", turnId: "turn-1", text: "first\n\nsecond", completedAt: "2026-06-06T00:01:04.000Z" })
    ]);
  });

  it("limits by recent message count while keeping chronological output", () => {
    const snapshot = baseSnapshot([
      turn({ turnId: "turn-1", startedAt: "2026-06-06T00:01:00.000Z", messageIds: ["m-1"] }),
      turn({ turnId: "turn-2", startedAt: "2026-06-06T00:02:00.000Z", messageIds: ["m-2", "m-3"] }),
      turn({ turnId: "turn-3", startedAt: "2026-06-06T00:03:00.000Z", messageIds: ["m-4"] })
    ], [
      block({ blockId: "m-1", messageId: "m-1", turnId: "turn-1", role: "user", text: "one", startedAt: "2026-06-06T00:01:01.000Z" }),
      block({ blockId: "m-2", messageId: "m-2", turnId: "turn-2", role: "user", text: "two", startedAt: "2026-06-06T00:02:01.000Z" }),
      block({ blockId: "m-3", messageId: "m-3", turnId: "turn-2", role: "assistant", text: "three", startedAt: "2026-06-06T00:02:02.000Z" }),
      block({ blockId: "m-4", messageId: "m-4", turnId: "turn-3", role: "assistant", text: "four", startedAt: "2026-06-06T00:03:01.000Z" })
    ]);

    const limited = buildReadSessionTranscript({ snapshot, sessionId: "session-1", limit: 2 });
    const all = buildReadSessionTranscript({ snapshot, sessionId: "session-1" });

    expect(limited.messages.map((message) => message.messageId)).toEqual(["m-3", "m-4"]);
    expect(limited.messages.map((message) => message.text)).toEqual(["three", "four"]);
    expect(limited.totalMessageCount).toBe(4);
    expect(limited.returnedMessageCount).toBe(2);
    expect(limited.truncatedByMessages).toBe(true);
    expect(all.messages).toHaveLength(4);
    expect(all.truncatedByMessages).toBe(false);
  });

  it("returns inherited fork history through the requested session without leaking later ancestor turns", () => {
    const root: ChatSession = { ...baseSession, sessionId: "root", updatedAt: "2026-06-06T00:06:00.000Z" };
    const child: ChatSession = { ...baseSession, sessionId: "child", updatedAt: "2026-06-06T00:06:00.000Z" };
    const snapshot = baseSnapshot([
      turn({ turnId: "root-1", sessionId: "root", startedAt: "2026-06-06T00:01:00.000Z", messageIds: ["root-message-1"] }),
      turn({ turnId: "root-2", sessionId: "root", startedAt: "2026-06-06T00:02:00.000Z", messageIds: ["root-message-2"] }),
      turn({ turnId: "root-3", sessionId: "root", startedAt: "2026-06-06T00:03:00.000Z", messageIds: ["root-message-3"] }),
      turn({ turnId: "child-1", sessionId: "child", startedAt: "2026-06-06T00:04:00.000Z", messageIds: ["child-message-1"] })
    ], [
      block({ blockId: "root-message-1", messageId: "root-message-1", sessionId: "root", turnId: "root-1", role: "user", text: "Root one", startedAt: "2026-06-06T00:01:01.000Z" }),
      block({ blockId: "root-message-2", messageId: "root-message-2", sessionId: "root", turnId: "root-2", role: "assistant", text: "Root two", startedAt: "2026-06-06T00:02:01.000Z" }),
      block({ blockId: "root-message-3", messageId: "root-message-3", sessionId: "root", turnId: "root-3", role: "assistant", text: "Root three", startedAt: "2026-06-06T00:03:01.000Z" }),
      block({ blockId: "child-message-1", messageId: "child-message-1", sessionId: "child", turnId: "child-1", role: "user", text: "Child one", startedAt: "2026-06-06T00:04:01.000Z" })
    ]);
    snapshot.conversations[0] = {
      ...snapshot.conversations[0]!,
      sessionIds: ["root", "child"],
      activeSessionId: "child"
    };
    snapshot.sessions = [root, child];
    snapshot.sessionRelations = [{
      relationId: "root-child",
      parentSessionId: "root",
      childSessionId: "child",
      relationType: "fork",
      sourceTurnId: "root-2",
      createdAt: "2026-06-06T00:02:30.000Z"
    }];

    const result = buildReadSessionTranscript({ snapshot, sessionId: "child" });

    expect(result.turns.map((entry) => entry.turnId)).toEqual(["root-1", "root-2", "child-1"]);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "root-message-1", "root-message-2", "child-message-1"
    ]);
    expect(result.messages.map((message) => message.text)).not.toContain("Root three");
  });

  it("prioritizes recent messages within a character budget and marks truncated text", () => {
    const snapshot = baseSnapshot([
      turn({ turnId: "turn-1", messageIds: ["old", "new"] })
    ], [
      block({ blockId: "old", messageId: "old", turnId: "turn-1", role: "user", text: "old text", startedAt: "2026-06-06T00:01:01.000Z" }),
      block({ blockId: "new", messageId: "new", turnId: "turn-1", role: "assistant", text: "new text", startedAt: "2026-06-06T00:01:02.000Z" })
    ]);

    const result = buildReadSessionTranscript({ snapshot, sessionId: "session-1", maxTextChars: 4 });

    expect(result.truncatedByChars).toBe(true);
    expect(result.messages).toEqual([
      expect.objectContaining({ messageId: "old", text: "", textTruncated: true }),
      expect.objectContaining({ messageId: "new", text: "new", textTruncated: true })
    ]);
  });

  it("reports a clear error for an unknown session", () => {
    expect(() => buildReadSessionTranscript({
      snapshot: baseSnapshot([], []),
      sessionId: "missing-session"
    })).toThrow("Unknown session: missing-session");
  });
});
