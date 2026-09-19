import type { ChatTreeSnapshotRpc } from "@vermillion/shared";

/** Worker children do not make the design session's own tip a historical send target. */
export const isHistoricalChatTreePosition = (tree: ChatTreeSnapshotRpc): boolean => {
  const tip = tree.nodes.filter((node) => node.sessionId === tree.currentSessionId).at(-1)?.nodeId;
  return Boolean(tree.currentNodeId && tip && tree.currentNodeId !== tip);
};
