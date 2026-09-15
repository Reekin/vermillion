import { describe, expect, it } from "vitest";
import { engineItemKey, sessionItemId } from "../src/session-item-id.js";

describe("session item identity", () => {
  it("scopes engine item ids by session so fork members keep separate entities", () => {
    expect(sessionItemId("codex-thread:thread-a", "msg-1")).toBe(
      "codex-thread:thread-a:msg-1"
    );
    expect(sessionItemId("codex-thread:thread-b", "msg-1")).not.toBe(
      sessionItemId("codex-thread:thread-a", "msg-1")
    );
  });

  it("prefers the client message id the engine echoes for user messages", () => {
    expect(engineItemKey({ id: "user-turn-1", clientId: "client-1" })).toBe(
      "client-1"
    );
    expect(
      sessionItemId("session-1", engineItemKey({ id: "user-turn-1", clientId: "client-1" }))
    ).toBe("session-1:client-1");
  });

  it("falls back to the engine item id when no client message id came back", () => {
    expect(engineItemKey({ id: "user-turn-1", clientId: null })).toBe("user-turn-1");
    expect(engineItemKey({ id: "user-turn-1", clientId: "  " })).toBe("user-turn-1");
    expect(sessionItemId("session-1", engineItemKey({ id: "user-turn-1" }))).toBe(
      "session-1:user-turn-1"
    );
  });
});
