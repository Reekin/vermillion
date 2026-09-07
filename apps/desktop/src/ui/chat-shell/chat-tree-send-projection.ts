import type { ChatTreeSendOperation, ChatTreeSnapshotRpc } from "@vermillion/shared";

/** Operation nodes occupy the same sibling slot while their real turn is being created. */
export const projectChatTreeSends = (
  tree: ChatTreeSnapshotRpc | undefined,
  operations: ChatTreeSendOperation[],
  selectedOperationId?: string
): ChatTreeSnapshotRpc | undefined => {
  if (!tree) return tree;
  const operationByTurn = new Map(operations.filter((op) => op.turnId).map((op) => [op.turnId, op]));
  const baseOrder = tree.nodes.length;
  const nodes = tree.nodes.map((node) => {
    const operation = operationByTurn.get(node.turnId);
    return operation ? { ...node, order: baseOrder + operations.indexOf(operation) } : node;
  });
  for (const [index, operation] of operations.entries()) {
    if (operation.turnId && nodes.some((node) => node.turnId === operation.turnId)) continue;
    nodes.push({
      nodeId: operation.operationId,
      parentNodeId: operation.nodeId,
      label: operation.content.trim().slice(0, 80) || "附件",
      order: baseOrder + index,
      isCurrent: false
    });
  }
  const selected = operations.find((operation) => operation.operationId === selectedOperationId);
  if (!selected) return { ...tree, nodes };
  const realNode = nodes.find((node) => node.turnId && node.turnId === selected.turnId);
  const currentNodeId = realNode?.nodeId ?? selected.operationId;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const visibleNodeIds: string[] = [];
  let cursor: string | undefined = currentNodeId;
  while (cursor) {
    visibleNodeIds.unshift(cursor);
    cursor = byId.get(cursor)?.parentNodeId;
  }
  const sourceWindow = tree.windows?.find((window) =>
    window.snapshot.turns.some((turn) => turn.turnId === selected.nodeId));
  return {
    ...tree,
    nodes: nodes.map((node) => ({ ...node, isCurrent: node.nodeId === currentNodeId })),
    currentNodeId,
    currentSessionId: realNode ? selected.targetSessionId : sourceWindow?.sessionId ?? tree.currentSessionId,
    visibleNodeIds,
    visibleTurnIds: visibleNodeIds.flatMap((id) => byId.get(id)?.turnId ? [byId.get(id)!.turnId!] : [])
  };
};
