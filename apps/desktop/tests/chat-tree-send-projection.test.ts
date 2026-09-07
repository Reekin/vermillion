import { describe, expect, it } from "vitest";
import type { ChatTreeSendOperation, ChatTreeSnapshotRpc } from "@vermillion/shared";
import { projectChatTreeSends } from "../src/ui/chat-shell/chat-tree-send-projection.js";
import { buildChatTreeGraphLayout } from "../src/ui/chat-shell/chat-tree-layout.js";

const tree: ChatTreeSnapshotRpc = {
  sessionId: "tree", engineId: "codex", supportsJump: true, fetchedAt: "now",
  currentNodeId: "root", currentSessionId: "tree", visibleTurnIds: ["root"],
  nodes: [
    { nodeId: "root", turnId: "root", label: "root", order: 0, isCurrent: true },
    { nodeId: "tip", turnId: "tip", parentNodeId: "root", label: "tip", order: 1, isCurrent: false }
  ]
};
const operation: ChatTreeSendOperation = {
  operationId: "send", sessionId: "tree", nodeId: "root", content: "question", attachments: [], status: "creating"
};

describe("branch operation projection", () => {
  it("selects the child while limiting history to the submitted parent", () => {
    const result = projectChatTreeSends(tree, [operation], "send")!;
    expect(result.currentNodeId).toBe("send");
    expect(result.visibleTurnIds).toEqual(["root"]);
    expect(result.nodes.at(-1)).toMatchObject({ nodeId: "send", parentNodeId: "root", isCurrent: true });
  });

  it("replaces the virtual child in the same graph slot when operations finish out of order", () => {
    const second = { ...operation, operationId: "second" };
    const before = buildChatTreeGraphLayout(projectChatTreeSends(tree, [operation, second], "second"));
    const realTree = { ...tree, nodes: [...tree.nodes,
      { nodeId: "real", turnId: "real", parentNodeId: "root", label: "question", order: 2, isCurrent: false }
    ] };
    const completed = { ...second, status: "sent" as const, turnId: "real", targetSessionId: "branch" };
    const result = projectChatTreeSends(realTree, [operation, completed], "second")!;
    const after = buildChatTreeGraphLayout(result);
    expect(result.nodes).toHaveLength(4);
    expect(result.currentNodeId).toBe("real");
    expect(result.currentSessionId).toBe("branch");
    expect(result.visibleTurnIds).toEqual(["root", "real"]);
    const previous = before.nodes.find((node) => node.node.nodeId === "second")!;
    expect(after.nodes.find((node) => node.node.nodeId === "real")).toMatchObject({ x: previous.x, y: previous.y });
  });

  it("keeps a later browsing selection while retaining a failed operation", () => {
    const result = projectChatTreeSends({ ...tree, currentNodeId: "tip" }, [
      { ...operation, status: "failed", error: "unavailable" }
    ])!;
    expect(result.currentNodeId).toBe("tip");
    expect(result.nodes.some((node) => node.nodeId === "send")).toBe(true);
  });
});
