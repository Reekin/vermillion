import { describe, expect, it } from "vitest";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { isHistoricalChatTreePosition } from "../src/ui/chat-shell/chat-tree-send-target.js";
import { projectChatTreeWorkers } from "../src/ui/app/chat-tree-workers.js";

const tree = (currentSessionId = "design"): ChatTreeSnapshotRpc => ({
  sessionId: "design", treeId: "design", currentSessionId, currentNodeId: currentSessionId === "design" ? "source" : "worker-tip",
  memberSessionIds: ["design", "worker", "other-worker"], supportsJump: true, engineId: "codex", fetchedAt: "now",
  nodes: [
    { nodeId: "source", turnId: "source", order: 0, isCurrent: currentSessionId === "design", label: "设计讨论" },
    { nodeId: "worker-tip", turnId: "worker-tip", parentNodeId: "source", order: 1, isCurrent: currentSessionId === "worker", label: "执行详情" },
    { nodeId: "other-tip", turnId: "other-tip", parentNodeId: "source", order: 2, isCurrent: false, label: "其他执行详情" }
  ],
  windows: [
    { sessionId: "design", snapshot: { sessions: [{ sessionId: "design", title: "设计讨论" }], turns: [{ sessionId: "design", turnId: "source" }] } },
    { sessionId: "worker", snapshot: { sessions: [{ sessionId: "worker", title: "Worker A", metadata: { role: "worker" } }], turns: [{ sessionId: "worker", turnId: "worker-tip" }] } },
    { sessionId: "other-worker", snapshot: { sessions: [{ sessionId: "other-worker", title: "Worker B", metadata: { role: "worker" } }], turns: [{ sessionId: "other-worker", turnId: "other-tip" }] } }
  ]
} as ChatTreeSnapshotRpc);

describe("Worker branch presentation", () => {
  it("keeps kickoff source selected and hides worker nodes while listing every worker", () => {
    const source = tree();
    const result = projectChatTreeWorkers(source, []);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
    expect(result.tree?.currentSessionId).toBe("design");
    expect(result.tree?.currentNodeId).toBe("source");
    expect(result.workers.map((worker) => worker.sessionId)).toEqual(["worker", "other-worker"]);
    expect(source.nodes).toHaveLength(3);
    expect(isHistoricalChatTreePosition(source)).toBe(false);
  });

  it("reveals the selected worker and its source, keeping sibling workers hidden", () => {
    const result = projectChatTreeWorkers(tree("worker"), []);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip"]);
    expect(result.workers[0]?.nodeId).toBe("worker-tip");
    expect(isHistoricalChatTreePosition(tree("worker"))).toBe(false);
  });

  it("forks only after the design session itself advances beyond the viewed source turn", () => {
    const source = tree();
    expect(isHistoricalChatTreePosition(source)).toBe(false);
    source.nodes.push({ nodeId: "design-next", turnId: "design-next", parentNodeId: "source", order: 3, isCurrent: false, label: "继续讨论" });
    source.windows![0]!.snapshot.turns.push({ sessionId: "design", turnId: "design-next" } as typeof source.windows[0]["snapshot"]["turns"][number]);
    expect(isHistoricalChatTreePosition(source)).toBe(true);
    source.currentNodeId = "design-next";
    expect(isHistoricalChatTreePosition(source)).toBe(false);
  });

  it("keeps pending and failed kickoff records before a worker or work item exists", () => {
    const requests = [
      { requestId: "one", sourceSessionId: "design", status: "pending", scope: "第一项" },
      { requestId: "two", sourceSessionId: "design", status: "failed", scope: "第二项", failure: "无法创建分支" },
      { requestId: "elsewhere", sourceSessionId: "another-tree", status: "pending" }
    ] as WorkRequest[];
    const result = projectChatTreeWorkers(tree(), [], requests);
    expect(result.workers.filter((worker) => !worker.sessionId)).toMatchObject([
      { key: "one", title: "第一项", status: "preparing" },
      { key: "two", title: "第二项", status: "failed", failure: "无法创建分支" }
    ]);
  });

  it("replaces preparation with the bound work item's title and state without duplication", () => {
    const requests = [{ requestId: "one", sourceSessionId: "design", workerSessionId: "worker", status: "ready" }] as WorkRequest[];
    const items = [{ requestId: "one", title: "实际工单", status: "decision", run: { sessionId: "worker" } }] as WorkItem[];
    const result = projectChatTreeWorkers(tree(), items, requests);
    expect(result.workers).toHaveLength(2);
    expect(result.workers[0]).toMatchObject({ title: "实际工单", status: "decision" });
    const waitingForTree = projectChatTreeWorkers({ ...tree(), windows: [] }, items, requests);
    expect(waitingForTree.workers).toMatchObject([{ title: "实际工单", status: "decision", sessionId: "worker" }]);
  });
});
