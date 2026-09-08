import type { ChatTreeSnapshotRpc } from "@vermillion/shared";

/** Worker children do not make the design session's own tip a historical send target. */
export const isHistoricalChatTreePosition = (tree: ChatTreeSnapshotRpc): boolean => {
  const window = tree.windows?.find((entry) => entry.sessionId === tree.currentSessionId);
  if (window) {
    const turns = new Set(window.snapshot.turns.filter((turn) => turn.sessionId === window.sessionId).map((turn) => turn.turnId));
    const tip = tree.nodes.filter((node) => node.turnId && turns.has(node.turnId)).at(-1)?.nodeId;
    return Boolean(tree.currentNodeId && tip && tree.currentNodeId !== tip);
  }
  return tree.nodes.some((node) => node.parentNodeId === tree.currentNodeId);
};
