import { describe, expect, it } from "vitest";
import { parseMobileRoute, sessionHash } from "../src/ui/mobile/navigation.js";

describe("mobile notification routes", () => {
  it("round trips session identifiers without treating slashes as routing", () => {
    expect(parseMobileRoute(sessionHash("codex-thread:你好/a"))).toEqual({ page: "session", sessionId: "codex-thread:你好/a" });
  });
  it("locates Inbox messages within their workspace", () => {
    expect(parseMobileRoute("#/inbox/workspace-1/decision-1")).toEqual({ page: "inbox", workspaceId: "workspace-1", itemKey: "decision-1" });
  });
  it("opens the list for malformed external links", () => {
    expect(parseMobileRoute("#/session/%invalid")).toEqual({ page: "sessions" });
    expect(parseMobileRoute("#/session/")).toEqual({ page: "sessions" });
  });
});
