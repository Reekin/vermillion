import { describe, expect, it } from "vitest";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { isHistoricalChatTreePosition } from "../src/ui/chat-shell/chat-tree-send-target.js";
import { projectChatTreeWorkers } from "../src/ui/app/chat-tree-workers.js";

const boundItems = ["worker", "other-worker"].map((sessionId) => ({
  title: sessionId, status: "running", run: { sessionId }
})) as WorkItem[];

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
  it("lists the preparation branch without assigning it a Worker role", () => {
    const source = tree();
    source.windows![1]!.snapshot.sessions[0]!.metadata = { role: "work-preparation" };
    const request = { requestId: "prep", sourceSessionId: "design", workerSessionId: "worker", status: "preparing" } as WorkRequest;
    const result = projectChatTreeWorkers(source, [boundItems[1]!], [request]);
    expect(result.workers.find((worker) => worker.sessionId === "worker")).toMatchObject({ nodeId: "worker-tip", status: "preparing" });
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
  });

  it("keeps an unbound preparation visible while a request awaits its explicit session binding", () => {
    const source = tree();
    source.windows![1]!.snapshot.sessions[0]!.metadata = { role: "work-preparation", requestId: "prep" };
    const request = { requestId: "prep", sourceSessionId: "design", status: "preparing", scope: "Prepare this work" } as WorkRequest;
    const result = projectChatTreeWorkers(source, [], [request]);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip", "other-tip"]);
    expect(result.workers).toHaveLength(1);
    expect(result.workers.filter((worker) => worker.title === "Prepare this work")).toMatchObject([
      { sessionId: undefined, nodeId: undefined, status: "preparing" }
    ]);
    expect(result.workers.some((worker) => worker.sessionId === "worker")).toBe(false);
  });

  it.each(["worker", "work-preparation"])("keeps ordinary branches with stale %s metadata visible after preparation is ready", (role) => {
    const source = tree();
    source.windows![2]!.snapshot.sessions[0]!.metadata = { role, requestId: "ready", workItemId: "old-item" };
    const requests = [{ requestId: "ready", sourceSessionId: "design", workerSessionId: "worker", status: "ready" }] as WorkRequest[];
    const result = projectChatTreeWorkers(source, [], requests);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "other-tip"]);
    expect(result.workers).toMatchObject([{ sessionId: "worker", status: "closed" }]);
    expect(result.workers).toHaveLength(1);
    expect(result.activeWorkers).toEqual([]);
    source.currentSessionId = "other-worker";
    source.currentNodeId = "other-tip";
    expect(projectChatTreeWorkers(source, [], requests).tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "other-tip"]);
  });
  it("keeps kickoff source selected and hides worker nodes while listing every worker", () => {
    const source = tree();
    const result = projectChatTreeWorkers(source, boundItems);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
    expect(result.tree?.currentSessionId).toBe("design");
    expect(result.tree?.currentNodeId).toBe("source");
    expect(result.workers.map((worker) => worker.sessionId)).toEqual(expect.arrayContaining(["worker", "other-worker"]));
    expect(source.nodes).toHaveLength(3);
    expect(isHistoricalChatTreePosition(source)).toBe(false);
  });

  it("reveals the selected worker and its source, keeping sibling workers hidden", () => {
    const result = projectChatTreeWorkers(tree("worker"), boundItems);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip"]);
    expect(result.workers.find((worker) => worker.sessionId === "worker")?.nodeId).toBe("worker-tip");
    expect(isHistoricalChatTreePosition(tree("worker"))).toBe(false);
  });

  it("hides, reveals and hides worker branches as the viewed node changes", () => {
    const source = tree();
    const visibleIds = (currentNodeId: string) => projectChatTreeWorkers({
      ...source, currentSessionId: "worker", currentNodeId
    }, boundItems).tree?.nodes.map((node) => node.nodeId);
    expect(visibleIds("source")).toEqual(["source"]);
    expect(visibleIds("worker-tip")).toEqual(["source", "worker-tip"]);
    expect(visibleIds("other-tip")).toEqual(["source", "other-tip"]);
    expect(visibleIds("source")).toEqual(["source"]);
    expect(source.nodes).toHaveLength(3);
  });

  it("selects a worker from its own viewed turn even when the provider window contains source turns", () => {
    const source = tree("worker");
    source.currentNodeId = "source";
    source.windows![1]!.snapshot.turns.unshift({ sessionId: "design", turnId: "source" } as typeof source.windows[0]["snapshot"]["turns"][number]);
    const result = projectChatTreeWorkers(source, boundItems);
    expect(result.workers.find((worker) => worker.sessionId === "worker")?.nodeIds).toEqual(["worker-tip"]);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
  });

  it("retains a selected worker's ancestors across nested worker forks", () => {
    const source = tree();
    source.nodes.find((node) => node.nodeId === "other-tip")!.parentNodeId = "worker-tip";
    source.currentSessionId = "other-worker";
    source.currentNodeId = "other-tip";
    expect(projectChatTreeWorkers(source, boundItems).tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip", "other-tip"]);
    source.currentNodeId = "source";
    expect(projectChatTreeWorkers(source, boundItems).tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
  });

  it("retains worker ancestors of ordinary forks while hiding later execution and sibling workers", () => {
    const source = tree();
    source.nodes.push(
      { nodeId: "ordinary", turnId: "ordinary", parentNodeId: "worker-tip", order: 3, isCurrent: false, label: "Follow-up" },
      { nodeId: "worker-later", turnId: "worker-later", parentNodeId: "worker-tip", order: 4, isCurrent: false, label: "Execution" }
    );
    source.windows![1]!.snapshot.turns.push({ sessionId: "worker", turnId: "worker-later" } as typeof source.windows[0]["snapshot"]["turns"][number]);
    source.windows.push({ sessionId: "ordinary", snapshot: {
      sessions: [{ sessionId: "ordinary", metadata: { role: "work-preparation", requestId: "ready" } }],
      turns: [{ sessionId: "ordinary", turnId: "ordinary" }]
    } } as typeof source.windows[number]);
    const requests = [{ requestId: "ready", sourceSessionId: "design", workerSessionId: "worker", status: "ready" }] as WorkRequest[];
    for (const currentNodeId of ["source", "ordinary"]) {
      const result = projectChatTreeWorkers({ ...source, currentNodeId }, [boundItems[1]!], requests);
      expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip", "ordinary"]);
      expect(result.workers.map((worker) => worker.sessionId)).toEqual(["worker", "other-worker"]);
    }
  });

  it("shows closed and cancelled branches with showAll while keeping the unfinished list separate", () => {
    const source = tree();
    const items = [
      { title: "Finished", status: "closed", run: { sessionId: "worker" } },
      { title: "Cancelled", status: "cancelled", run: { sessionId: "other-worker" } }
    ] as WorkItem[];
    const requests = [
      { requestId: "pending", sourceSessionId: "design", status: "pending", scope: "Preparing" },
      { requestId: "failed", sourceSessionId: "design", status: "failed", scope: "Retry needed" }
    ] as WorkRequest[];
    const hidden = projectChatTreeWorkers(source, items, requests);
    const all = projectChatTreeWorkers(source, items, requests, true);
    expect(hidden.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
    expect(all.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip", "other-tip"]);
    expect(all.workers.map((worker) => worker.status)).toEqual(expect.arrayContaining(["closed", "cancelled", "preparing", "failed"]));
    expect(all.activeWorkers.map((worker) => worker.key)).toEqual(expect.arrayContaining(["pending", "failed"]));
    expect(all.activeWorkers).toHaveLength(2);
    expect(all.activeWorkers).toEqual(hidden.activeWorkers);
    expect(projectChatTreeWorkers(source, items, requests, false).tree?.nodes).toEqual(hidden.tree?.nodes);
  });

  it("opens each worker's latest own node regardless of snapshot array order", () => {
    const source = tree();
    source.nodes.unshift({ nodeId: "worker-latest", turnId: "worker-latest", parentNodeId: "worker-tip", order: 5, isCurrent: false, label: "Latest work" });
    source.windows![1]!.snapshot.turns.unshift({ sessionId: "worker", turnId: "worker-latest" } as typeof source.windows[0]["snapshot"]["turns"][number]);
    const result = projectChatTreeWorkers(source, boundItems);
    expect(result.workers.find((worker) => worker.sessionId === "worker")).toMatchObject({ nodeId: "worker-latest", nodeIds: ["worker-tip", "worker-latest"] });
    expect(result.workers.find((worker) => worker.sessionId === "other-worker")?.nodeId).toBe("other-tip");
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

  it("keeps cancelled kickoff records out of the active worker list", () => {
    const result = projectChatTreeWorkers(tree(), [], [
      { requestId: "cancelled", sourceSessionId: "design", status: "cancelled", scope: "Cancelled preparation" }
    ] as WorkRequest[]);

    expect(result.workers).toEqual([]);
    expect(result.activeWorkers).toEqual([]);
  });

  it("replaces preparation with the bound work item's title and state without duplication", () => {
    const requests = [{ requestId: "one", sourceSessionId: "design", workerSessionId: "worker", status: "ready" }] as WorkRequest[];
    const items = [{ requestId: "one", title: "实际工单", status: "decision", run: { sessionId: "worker" } }] as WorkItem[];
    const result = projectChatTreeWorkers(tree(), items, requests);
    expect(result.workers).toHaveLength(1);
    expect(result.workers.find((worker) => worker.sessionId === "worker")).toMatchObject({ title: "实际工单", status: "decision" });
    const partialTree = { ...tree(), memberSessionIds: ["design", "worker"], nodes: [tree().nodes[0]!], windows: [tree().windows![0]!] };
    const partialItems = [{ ...items[0], treeId: "design", sourceSessionId: "design" }] as WorkItem[];
    const partialRequests = [{ ...requests[0], treeId: "design" }] as WorkRequest[];
    const waitingForTree = projectChatTreeWorkers(partialTree, partialItems, partialRequests);
    expect(waitingForTree.workers).toMatchObject([{ sessionId: "worker", title: "实际工单", status: "decision", nodeIds: [] }]);
    expect(waitingForTree.activeWorkers).toMatchObject([{ sessionId: "worker", title: "实际工单", status: "decision" }]);
  });

  it("ignores work records for archived branches removed from the tree", () => {
    const source = tree();
    source.memberSessionIds = ["design"];
    source.nodes = [source.nodes[0]!];
    source.windows = [source.windows![0]!];
    const items = [{ ...boundItems[0], treeId: "design", sourceSessionId: "design" }] as WorkItem[];
    const result = projectChatTreeWorkers(source, items);
    expect(result.workers).toEqual([]);
    expect(result.activeWorkers).toEqual([]);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
  });

  it("ignores requests for archived branches removed from the tree", () => {
    const source = tree();
    source.memberSessionIds = ["design"];
    source.nodes = [source.nodes[0]!];
    source.windows = [source.windows![0]!];
    const requests = [{ requestId: "archived", sourceSessionId: "design", workerSessionId: "worker", status: "failed" }] as WorkRequest[];
    const result = projectChatTreeWorkers(source, [], requests);
    expect(result.workers).toEqual([]);
    expect(result.activeWorkers).toEqual([]);
  });

  it.each(["closed", "cancelled"])("keeps the active item visible when a reused session also has a %s item", (status) => {
    const items = [
      { title: "Ended work", status, createdAt: "2026-09-10T02:00:00Z", run: { sessionId: "worker" } },
      { title: "Active work", status: "decision", createdAt: "2026-09-10T01:00:00Z", run: { sessionId: "worker" } }
    ] as WorkItem[];
    for (const orderedItems of [items, [...items].reverse()]) {
      const result = projectChatTreeWorkers(tree(), orderedItems);
      expect(result.workers.filter((worker) => worker.sessionId === "worker")).toMatchObject([
        { title: "Active work", status: "decision", nodeId: "worker-tip" }
      ]);
      expect(result.activeWorkers.find((worker) => worker.sessionId === "worker")).toMatchObject({ title: "Active work", status: "decision" });
    }
  });

  it("ends a ready preparation branch while keeping its actual worker in the unfinished list", () => {
    const source = tree();
    source.windows![1]!.snapshot.sessions[0]!.metadata = { role: "work-preparation" };
    const requests = [{ requestId: "ready", sourceSessionId: "design", workerSessionId: "worker", status: "ready", scope: "Preparation" }] as WorkRequest[];
    const items = [{ requestId: "ready", title: "Actual work", status: "decision", run: { sessionId: "other-worker" } }] as WorkItem[];
    const result = projectChatTreeWorkers(source, items, requests);
    expect(result.workers.find((worker) => worker.sessionId === "worker")).toMatchObject({ title: "Preparation", status: "closed", nodeId: "worker-tip" });
    expect(result.activeWorkers).toMatchObject([{ sessionId: "other-worker", title: "Actual work", status: "decision" }]);
    expect(result.activeWorkers).toHaveLength(1);
    expect(result.tree?.nodes.map((node) => node.nodeId)).toEqual(["source"]);
    const all = projectChatTreeWorkers(source, items, requests, true);
    expect(all.tree?.nodes.map((node) => node.nodeId)).toEqual(["source", "worker-tip", "other-tip"]);
    expect(all.activeWorkers).toEqual(result.activeWorkers);
  });
});
