import { describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { createRendererStore } from "../src/store/store.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";

vi.mock("xterm", () => ({
  Terminal: class MockTerminal {
    public open(): void {}
    public write(): void {}
    public reset(): void {}
    public dispose(): void {}
  }
}));

import {
  formatMessageTime,
  SessionPane,
  formatRelativeActivityAge,
  truncateSessionHeading
} from "../src/ui/chat-shell/SessionPane.js";

// Static render never runs effects, so the transport only needs to satisfy the type.
const transport = {} as DesktopTransport;
const createSession = async (): Promise<string> => "session-new";

const hydrateSession = () => {
  const store = createRendererStore();
  store.hydrateSnapshot(
    parseDomainSnapshot({
      conversations: [
        {
          conversationId: "conversation-1",
          participantEngineIds: ["agent-codex"],
          activeSessionId: "session-1",
          sessionIds: ["session-1"],
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "agent-codex",
          status: "awaiting_approval",
          title: "Refactor the shell",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:01:00.000Z"
        }
      ],
      turns: [
        {
          turnId: "turn-1",
          sessionId: "session-1",
          status: "completed",
          startedAt: "2026-04-18T00:01:00.000Z",
          completedAt: "2026-04-18T00:01:05.000Z",
          messageIds: ["message-1", "message-2"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          finalMessageId: "message-2"
        }
      ],
      messageBlocks: [
        {
          blockId: "message-1:md",
          messageId: "message-1",
          turnId: "turn-1",
          sessionId: "session-1",
          role: "user",
          kind: "markdown",
          text: "first line",
          actor: { participantId: "participant-1", engineId: "agent-codex" },
          startedAt: "2026-04-18T00:01:00.000Z"
        },
        {
          blockId: "message-2:md",
          messageId: "message-2",
          turnId: "turn-1",
          sessionId: "session-1",
          role: "assistant",
          kind: "markdown",
          text: "second line",
          actor: { participantId: "participant-1", engineId: "agent-codex" },
          startedAt: "2026-04-18T00:01:02.000Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [
        {
          requestId: "approval-1",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalKind: "command",
          status: "pending",
          title: "Approve shell command",
          details: "echo approval",
          requestedAt: "2026-04-18T00:01:00.000Z"
        }
      ],
      participants: [
        {
          participantId: "participant-1",
          conversationId: "conversation-1",
          engineId: "agent-codex",
          role: "primary",
          capabilities: ["chat"],
          activeSessionIds: ["session-1"]
        }
      ],
      sessionRelations: []
    })
  );
  return store;
};

describe("SessionPane", () => {
  it("renders the draft state with an empty transcript and a usable composer", () => {
    const html = renderToStaticMarkup(
      <SessionPane
        store={createRendererStore()}
        transport={transport}
        sessionId={undefined}
        createSession={createSession}
        composerExtras={<span data-testid="extra">workspace picker</span>}
      />
    );

    expect(html).toContain('class="awb-session-pane"');
    expect(html).toContain("\u53d1\u9001\u7b2c\u4e00\u6761\u6d88\u606f\u5f00\u59cb\u4f1a\u8bdd");
    expect(html).toContain("<textarea");
    expect(html).toContain("workspace picker");
    expect(html).not.toContain("awb-shell__sidebar");
    expect(html).not.toContain("awb-shell__detail");
    expect(html).not.toContain("awb-chat-entry");
  });

  it("renders the transcript, heading, and pending approvals for an active session", () => {
    const store = hydrateSession();
    const renderTurnNavigation = vi.fn(({ sessionId, turnId }: { sessionId: string; turnId: string }) =>
      <span data-navigation={`${sessionId}/${turnId}`}>Open linked session</span>);

    const html = renderToStaticMarkup(
      <SessionPane
        store={store}
        transport={transport}
        sessionId="session-1"
        createSession={createSession}
        renderTurnNavigation={renderTurnNavigation}
      />
    );

    expect(html).toContain("Refactor the shell");
    expect(html).toContain("first line");
    expect(html).toContain("second line");
    expect(html).toContain('data-navigation="session-1/turn-1"');
    expect(renderTurnNavigation).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", turnId: "turn-1" });
    expect(html).toContain('class="awb-chat-entry__timestamp"');
    expect(html).toContain('aria-label="待审批"');
    expect(html).toContain("Approve shell command");
    expect(html.indexOf("awb-composer-approvals")).toBeLessThan(html.indexOf("<textarea"));
    expect(html).not.toContain("awb-shell__sidebar");
  });

  it("truncates long thread titles to 20 characters", () => {
    expect(truncateSessionHeading("  \u8fd9\u662f\u4e00\u4e2a\u7279\u522b\u7279\u522b\u957f\u7684\u9996\u8f6e\u8f93\u5165\u6807\u9898\u7528\u4e8e\u9a8c\u8bc1\u622a\u65ad  ")).toBe(
      "\u8fd9\u662f\u4e00\u4e2a\u7279\u522b\u7279\u522b\u957f\u7684\u9996\u8f6e\u8f93\u5165\u6807\u9898\u7528\u4e8e\u9a8c\u8bc1\u2026"
    );
    expect(truncateSessionHeading("short title")).toBe("short title");
    expect(truncateSessionHeading("   ")).toBe("新会话");
  });

  it("formats session list times as relative Chinese phrases", () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

    expect(formatRelativeActivityAge(at(2026, 4, 4, 11, 59), now)).toBe("1分钟前");
    expect(formatRelativeActivityAge(new Date(now - 20_000).toISOString(), now)).toBe("刚刚");
    expect(formatRelativeActivityAge(at(2026, 4, 4, 11, 55), now)).toBe("5分钟前");
    expect(formatRelativeActivityAge(at(2026, 4, 4, 9, 30), now)).toBe("2小时前");
    expect(formatRelativeActivityAge(at(2026, 4, 3, 22, 10), now)).toBe("昨天 22:10");
    expect(formatRelativeActivityAge(at(2026, 4, 1, 8, 0), now)).toBe("5月1日");
    expect(formatRelativeActivityAge(at(2025, 11, 30, 8, 0), now)).toBe("2025年12月30日");
    expect(formatRelativeActivityAge(undefined, now)).toBeUndefined();
    expect(formatRelativeActivityAge("not-a-date", now)).toBeUndefined();
  });

  it("formats message times to the second", () => {
    const now = new Date(2026, 4, 4, 12, 0, 0);
    expect(formatMessageTime(new Date(2026, 4, 4, 9, 5, 7).toISOString(), now)).toBe("09:05:07");
    expect(formatMessageTime(new Date(2026, 4, 3, 22, 10, 5).toISOString(), now)).toBe("昨天 22:10:05");
    expect(formatMessageTime(new Date(2026, 3, 11, 7, 18, 50).toISOString(), now)).toBe("4月11日 07:18:50");
  });
});
