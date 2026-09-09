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
    const html = renderToStaticMarkup(<ChatTreePanel chatTree={chatTree} highlightedNodeIds={["tip"]}
      footer={<div data-footer="branches">Branch list</div>} />);
    expect(html).toContain("is-highlighted");
    expect(html).toContain("Selected branch");
    expect(html.indexOf('data-footer="branches"')).toBeGreaterThan(html.indexOf("awb-chat-tree__graph-node-dot"));
  });
});
