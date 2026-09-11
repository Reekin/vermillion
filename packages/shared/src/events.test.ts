import { describe, expect, it } from "vitest";
import { invalidatesSessionBrowser } from "./events.js";

describe("invalidatesSessionBrowser", () => {
  it("refreshes for user messages without refreshing for assistant output", () => {
    expect(invalidatesSessionBrowser({
      type: "message.started",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-1",
      role: "user"
    })).toBe(true);
    expect(invalidatesSessionBrowser({
      type: "message.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-1",
      role: "user"
    })).toBe(true);
    expect(invalidatesSessionBrowser({
      type: "message.started",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-2",
      role: "assistant"
    })).toBe(false);
    expect(invalidatesSessionBrowser({
      type: "message.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-2",
      role: "assistant"
    })).toBe(false);
  });
});
