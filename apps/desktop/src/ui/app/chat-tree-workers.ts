import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { workSessionLabel } from "./components/task-labels.js";

const requestWorkerStatus = (status: WorkRequest["status"]): "preparing" | "failed" | "cancelled" | "closed" =>
  status === "ready" ? "closed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "preparing";

export const projectChatTreeWorkers = (tree: ChatTreeSnapshotRpc | undefined, items: WorkItem[], requests: WorkRequest[] = [], showAll = false) => {
  if (!tree) return { workers: [], activeWorkers: [], hasWorkSessions: false, nodeMarkers: {}, tree: undefined };
  const newestItems = [...items].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const treeSessionIds = new Set([tree.sessionId, ...(tree.memberSessionIds ?? [])]);
  const relevantRequests = requests.filter((request) =>
    !(request.status === "cancelled" && !request.workerSessionId) &&
    ((request.treeId && request.treeId === tree.treeId) || treeSessionIds.has(request.sourceSessionId))
  );
  const relevantRequestIds = new Set(relevantRequests.map((request) => request.requestId));
  const relevantItems = newestItems.filter((item) => {
    if (!item.run.sessionId || !treeSessionIds.has(item.run.sessionId)) return false;
    if (!item.treeId && !item.sourceSessionId && !item.requestId) return true;
    return (item.treeId && item.treeId === tree.treeId) ||
      (item.sourceSessionId && treeSessionIds.has(item.sourceSessionId)) ||
      (item.requestId && relevantRequestIds.has(item.requestId));
  });
  const workerSessionIds = new Set<string>();
  for (const request of relevantRequests) {
    if (request.workerSessionId && treeSessionIds.has(request.workerSessionId)) workerSessionIds.add(request.workerSessionId);
  }
  for (const item of relevantItems) {
    if (item.run.sessionId) workerSessionIds.add(item.run.sessionId);
  }
  const workers = [...workerSessionIds].map((sessionId) => {
    const request = relevantRequests.find((entry) => entry.workerSessionId === sessionId);
    const item = relevantItems.find((entry) => entry.run.sessionId === sessionId && !["closed", "cancelled"].includes(entry.status))
      ?? relevantItems.find((entry) => entry.run.sessionId === sessionId);
    const nodes = tree.nodes.filter((node) => node.sessionId === sessionId).sort((a, b) => a.order - b.order);
    return { key: sessionId, requestId: request?.requestId ?? item?.requestId, sessionId: sessionId as string | undefined, title: item?.title ?? request?.scope ?? "Worker", status: item?.status ?? (request ? requestWorkerStatus(request.status) : "preparing"), failure: request?.failure,
      activity: workSessionLabel(item, request), active: Boolean((item?.run ?? request)?.activeTurnId && (item?.run ?? request)?.turnStatus !== "unknown"),
      nodeId: nodes.at(-1)?.nodeId, nodeIds: nodes.map((node) => node.nodeId) };
  });
  for (const request of relevantRequests) {
    if (request.status === "ready") continue;
    if (request.workerSessionId && !treeSessionIds.has(request.workerSessionId)) continue;
    if (workers.some((worker) => worker.requestId === request.requestId || (request.workerSessionId && worker.sessionId === request.workerSessionId))) continue;
    const item = items.find((entry) => entry.requestId === request.requestId);
    workers.push({ key: request.requestId, requestId: request.requestId, sessionId: request.workerSessionId, title: item?.title ?? request.scope ?? "开工准备", status: item?.status ?? requestWorkerStatus(request.status), failure: request.failure, activity: workSessionLabel(item, request), active: Boolean(request.activeTurnId && request.turnStatus !== "unknown"), nodeId: undefined, nodeIds: [] });
  }
  const supervisors = relevantRequests.flatMap((request) => {
    const sessionId = request.supervisor?.sessionId;
    if (!sessionId || !treeSessionIds.has(sessionId)) return [];
    return [{ sessionId, nodeIds: tree.nodes.filter((node) => node.sessionId === sessionId).map((node) => node.nodeId) }];
  });
  const branches = [...workers, ...supervisors];
  const selected = branches.find((branch) => branch.nodeIds.includes(tree.currentNodeId ?? ""));
  const hiddenIds = new Set(branches.filter((branch) => branch !== selected).flatMap((branch) => branch.nodeIds));
  // Every visible branch needs its ancestors, including ordinary forks from work sessions.
  const nodesById = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  for (const node of tree.nodes.filter((entry) => !hiddenIds.has(entry.nodeId))) {
    let ancestor = node.parentNodeId;
    while (ancestor && hiddenIds.delete(ancestor)) {
      ancestor = nodesById.get(ancestor)?.parentNodeId;
    }
  }
  const activeWorkers = workers.filter((worker) => !["closed", "cancelled"].includes(worker.status));
  const nodeMarkers: Record<string, string> = Object.fromEntries([
    ...workers.flatMap((worker) => worker.nodeIds.map((id) => [id, "W"])),
    ...supervisors.flatMap((supervisor) => supervisor.nodeIds.map((id) => [id, "M"]))
  ]);
  return { workers, activeWorkers, hasWorkSessions: branches.length > 0, nodeMarkers,
    tree: { ...tree, nodes: showAll ? tree.nodes : tree.nodes.filter((node) => !hiddenIds.has(node.nodeId)) } };
};
