import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { ChatTreePanel } from "../src/ui/chat-shell/ChatTreePanel.js";

describe("chat tree presentation slots", () => {
  it("renders supplied nodes and a footer without workbench context", () => {
    const chatTree: ChatTreeSnapshotRpc = {
      sessionId: "source", currentNodeId: "tip", engineId: "codex", supportsJump: true, fetchedAt: "now",
      nodes: [{ nodeId: "tip", label: "Selected branch", order: 0, isCurrent: true }]
    };
    const html = renderToStaticMarkup(<ChatTreePanel chatTree={chatTree} nodeMarkers={{ tip: "R" }}
      footer={<div data-footer="branches">Branch list</div>} />);
    expect(html).toContain("has-marker");
    expect(html).toContain('class="awb-chat-tree__graph-node-dot">R</span>');
    expect(html).toContain('aria-label="R: Selected branch, current position"');
    expect(html).toContain("Selected branch");
    expect(html.indexOf('data-footer="branches"')).toBeGreaterThan(html.indexOf("awb-chat-tree__graph-node-dot"));
  });

  it.each([
    { status: "completed" as const, unread: true, expectedClass: "is-unread", absentClass: "is-running", label: "unread" },
    { status: "pending" as const, unread: true, expectedClass: "is-running", absentClass: "is-unread", label: "running" },
    { status: "pending" as const, unread: false, expectedClass: "is-running", absentClass: "is-unread", label: "running" }
  ])("renders $status/unread=$unread with only the $label state", ({ status, unread, expectedClass, absentClass, label }) => {
    const chatTree: ChatTreeSnapshotRpc = {
      sessionId: "source", engineId: "codex", supportsJump: true, fetchedAt: "now",
      nodes: [{ nodeId: "tip", label: "Branch", order: 0, isCurrent: false, status, unread }]
    };
    const html = renderToStaticMarkup(<ChatTreePanel chatTree={chatTree} />);
    expect(html).toContain(expectedClass);
    expect(html).not.toContain(absentClass);
    expect(html).toContain(`aria-label="Branch, ${label}"`);
    expect(html).not.toContain("has-marker");
  });

  it("removes unread presentation once the completed node is read", () => {
    const chatTree: ChatTreeSnapshotRpc = {
      sessionId: "source", engineId: "codex", supportsJump: true, fetchedAt: "now",
      nodes: [{ nodeId: "tip", label: "Read branch", order: 0, isCurrent: false, status: "completed", unread: false }]
    };
    const html = renderToStaticMarkup(<ChatTreePanel chatTree={chatTree} />);
    expect(html).not.toContain("is-unread");
    expect(html).not.toContain("is-running");
    expect(html).toContain('aria-label="Read branch"');
  });

  it("keeps the visibility toggle and branch list when filtering leaves no graph nodes", () => {
    const chatTree: ChatTreeSnapshotRpc = {
      sessionId: "source", engineId: "codex", supportsJump: true, fetchedAt: "now", nodes: []
    };
    const html = renderToStaticMarkup(<ChatTreePanel chatTree={chatTree}
      header={<button type="button" aria-pressed="false">Show all workers</button>}
      footer={<div data-footer="branches">Unfinished workers</div>} />);
    expect(html).toContain('aria-pressed="false">Show all workers</button>');
    expect(html).toContain('data-footer="branches">Unfinished workers');
    expect(html).not.toContain("awb-chat-tree__graph-node-dot");
    expect(html.indexOf("Show all workers")).toBeLessThan(html.indexOf("awb-chat-tree__graph-shell"));
    expect(html.indexOf('data-footer="branches"')).toBeGreaterThan(html.indexOf("awb-chat-tree__graph-shell"));
  });
});
