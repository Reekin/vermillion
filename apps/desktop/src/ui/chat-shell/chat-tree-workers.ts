import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";

export const projectChatTreeWorkers = (tree: ChatTreeSnapshotRpc | undefined, items: WorkItem[], requests: WorkRequest[] = []) => {
  const relevantRequests = requests.filter((request) => tree && ((request.treeId && request.treeId === tree.treeId) || request.sourceSessionId === tree.sessionId || tree.memberSessionIds?.includes(request.sourceSessionId)));
  const workers = (tree?.windows ?? []).flatMap((window) => {
    const session = window.snapshot.sessions.find((entry) => entry.sessionId === window.sessionId);
    if (session?.metadata?.role !== "worker") return [];
    const request = relevantRequests.find((entry) => entry.workerSessionId === session.sessionId);
    const item = items.find((entry) => entry.run.sessionId === session.sessionId);
    const turnIds = new Set(window.snapshot.turns.filter((turn) => turn.sessionId === session.sessionId).map((turn) => turn.turnId));
    const nodes = tree!.nodes.filter((node) => node.turnId && turnIds.has(node.turnId));
    return [{ key: session.sessionId, sessionId: session.sessionId as string | undefined, title: item?.title ?? request?.scope ?? session.title ?? "Worker", status: item?.status ?? (request?.status === "failed" ? "failed" as const : "preparing" as const), failure: request?.failure,
      nodeId: nodes.at(-1)?.nodeId, nodeIds: nodes.map((node) => node.nodeId) }];
  });
  for (const request of relevantRequests) {
    if ((request.workerSessionId && workers.some((worker) => worker.sessionId === request.workerSessionId))) continue;
    const item = items.find((entry) => entry.requestId === request.requestId);
    workers.push({ key: request.requestId, sessionId: request.workerSessionId, title: item?.title ?? request.scope ?? "开工准备", status: item?.status ?? (request.status === "failed" ? "failed" : "preparing"), failure: request.failure, nodeId: undefined, nodeIds: [] });
  }
  const selected = workers.find((worker) => worker.sessionId === tree?.currentSessionId);
  const hiddenIds = new Set(workers.filter((worker) => worker !== selected).flatMap((worker) => worker.nodeIds));
  // A selected worker may fork from another worker; retain its ancestors so the graph stays connected.
  let ancestor = selected?.nodeId;
  while (ancestor) {
    hiddenIds.delete(ancestor);
    ancestor = tree?.nodes.find((node) => node.nodeId === ancestor)?.parentNodeId;
  }
  return { workers, tree: tree && { ...tree, nodes: tree.nodes.filter((node) => !hiddenIds.has(node.nodeId)) } };
};
