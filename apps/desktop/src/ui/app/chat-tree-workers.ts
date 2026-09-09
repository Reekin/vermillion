import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";

export const projectChatTreeWorkers = (tree: ChatTreeSnapshotRpc | undefined, items: WorkItem[], requests: WorkRequest[] = [], showAll = false) => {
  const newestItems = [...items].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const relevantRequests = requests.filter((request) => tree && ((request.treeId && request.treeId === tree.treeId) || request.sourceSessionId === tree.sessionId || tree.memberSessionIds?.includes(request.sourceSessionId)));
  const workers = (tree?.windows ?? []).flatMap((window) => {
    const session = window.snapshot.sessions.find((entry) => entry.sessionId === window.sessionId);
    if (!session) return [];
    const request = relevantRequests.find((entry) => entry.workerSessionId === session.sessionId || entry.requestId === session.metadata?.requestId);
    if (!["worker", "work-preparation"].includes(String(session.metadata?.role)) && !request) return [];
    const item = newestItems.find((entry) => entry.run.sessionId === session.sessionId && !["closed", "cancelled"].includes(entry.status))
      ?? newestItems.find((entry) => entry.run.sessionId === session.sessionId);
    const turnIds = new Set(window.snapshot.turns.filter((turn) => turn.sessionId === session.sessionId).map((turn) => turn.turnId));
    const nodes = tree!.nodes.filter((node) => node.turnId && turnIds.has(node.turnId)).sort((a, b) => a.order - b.order);
    return [{ key: session.sessionId, requestId: request?.requestId, sessionId: session.sessionId as string | undefined, title: item?.title ?? request?.scope ?? session.title ?? "Worker", status: item?.status ?? (request?.status === "ready" ? "closed" as const : request?.status === "failed" ? "failed" as const : "preparing" as const), failure: request?.failure,
      nodeId: nodes.at(-1)?.nodeId, nodeIds: nodes.map((node) => node.nodeId) }];
  });
  for (const request of relevantRequests) {
    if (request.status === "ready") continue;
    if (workers.some((worker) => worker.requestId === request.requestId || (request.workerSessionId && worker.sessionId === request.workerSessionId))) continue;
    const item = items.find((entry) => entry.requestId === request.requestId);
    workers.push({ key: request.requestId, requestId: request.requestId, sessionId: request.workerSessionId, title: item?.title ?? request.scope ?? "开工准备", status: item?.status ?? (request.status === "failed" ? "failed" : "preparing"), failure: request.failure, nodeId: undefined, nodeIds: [] });
  }
  const selected = workers.find((worker) => worker.nodeIds.includes(tree?.currentNodeId ?? ""));
  const hiddenIds = new Set(workers.filter((worker) => worker !== selected).flatMap((worker) => worker.nodeIds));
  // A selected worker may fork from another worker; retain its ancestors so the graph stays connected.
  let ancestor = selected?.nodeId;
  while (ancestor) {
    hiddenIds.delete(ancestor);
    ancestor = tree?.nodes.find((node) => node.nodeId === ancestor)?.parentNodeId;
  }
  const activeWorkers = workers.filter((worker) => !["closed", "cancelled"].includes(worker.status));
  return { workers, activeWorkers, tree: tree && { ...tree, nodes: showAll ? tree.nodes : tree.nodes.filter((node) => !hiddenIds.has(node.nodeId)) } };
};
