import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionBrowserItemRpc } from "@vermillion/shared";

vi.mock("xterm", () => ({
  Terminal: class MockTerminal {
    public open(): void {}
    public write(): void {}
    public reset(): void {}
    public dispose(): void {}
  }
}));

import { SessionSidebar } from "../src/ui/app/components/SessionSidebar.js";
import type { SidebarSession } from "../src/ui/app/use-session-sidebar.js";

const session = (
  sessionId: string,
  statusDot: SessionBrowserItemRpc["statusDot"],
  extra: Partial<SidebarSession> = {}
): SidebarSession => ({
  sessionId,
  engineId: "codex",
  title: `${sessionId} title`,
  statusDot,
  isActive: false,
  isPinned: false,
  subagents: [],
  workspaceId: "workspace",
  sortAt: "2026-09-16T10:00:00.000Z",
  ...extra
});

const render = (sessions: SidebarSession[]): string =>
  renderToStaticMarkup(
    <SessionSidebar
      sessions={sessions}
      hasMore={false}
      loading={false}
      loadMore={async () => {}}
      selectedSessionId={undefined}
      isDraft={false}
      workspaceLabelById={new Map()}
      workspaceFilterId={undefined}
      onWorkspaceFilter={() => {}}
      onOpen={() => {}}
      onNewChat={() => {}}
      onSearch={() => {}}
      menu={undefined}
      onOpenMenu={() => {}}
      onCloseMenu={() => {}}
      onRunAction={() => {}}
      notice={undefined}
      onClearNotice={() => {}}
    />
  );

const EMPTY_SLOT = '<span data-session-status="none" class="inline-flex h-1.5 w-1.5 shrink-0 items-center justify-center"></span>';

describe("session sidebar status lights", () => {
  it("lights a running tree yellow, a completed-unread tree green, and leaves read rows dark", () => {
    const html = render([
      session("running-tree", "running"),
      session("unread-tree", "unread_completed"),
      session("read-tree", "none")
    ]);

    expect(html).toContain('data-session-status="running"');
    expect(html).toContain('aria-label="进行中"');
    expect(html).toContain("animate-pulse bg-status-running");
    expect(html).toContain('data-session-status="unread_completed"');
    expect(html).toContain('aria-label="已完成未读"');
    expect(html).toContain("bg-status-unread");
    expect(html).toContain(EMPTY_SLOT);
  });

  it("keeps one status slot per row so titles start at the same place", () => {
    const html = render([session("running-tree", "running"), session("read-tree", "none")]);

    expect(html.match(/data-session-status=/g)).toHaveLength(2);
    expect(html.indexOf('data-session-status="running"')).toBeLessThan(html.indexOf("running-tree title"));
    expect(html.indexOf(EMPTY_SLOT)).toBeLessThan(html.indexOf("read-tree title"));
  });

  it("keeps a collapsed parent dark when only its nested subagent is unread", () => {
    const html = render([
      session("parent-tree", "none", {
        subagents: [session("subagent-tree", "unread_completed")]
      })
    ]);

    expect(html.match(/data-session-status=/g)).toHaveLength(1);
    expect(html).toContain(EMPTY_SLOT);
    expect(html).not.toContain('data-session-status="unread_completed"');
  });
});
