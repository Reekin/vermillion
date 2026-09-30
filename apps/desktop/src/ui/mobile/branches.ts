import type { ChatTreeSnapshotRpc } from "@vermillion/shared";

export type TreeBranch = {
  sessionId: string;
  depth: number;
  /** Label of the latest node, i.e. the branch's last user message. */
  lastLabel?: string;
  firstLabel?: string;
  running: boolean;
  unread: boolean;
};

/**
 * Groups the tree's turn nodes into one entry per member branch, parents before children and siblings in
 * fork order. A branch is a child of the member that owns the node it was forked from.
 */
export const treeBranches = (tree: ChatTreeSnapshotRpc, exclude: ReadonlySet<string> = new Set()): TreeBranch[] => {
  const nodes = [...tree.nodes].sort((a, b) => a.order - b.order);
  const ownerByNode = new Map(nodes.map((node) => [node.nodeId, node.sessionId]));
  const bySession = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (!node.sessionId || exclude.has(node.sessionId)) continue;
    bySession.set(node.sessionId, [...(bySession.get(node.sessionId) ?? []), node]);
  }
  const parentOf = (sessionId: string): string | undefined => {
    const first = bySession.get(sessionId)?.[0];
    const parent = first?.parentNodeId ? ownerByNode.get(first.parentNodeId) : undefined;
    return parent && parent !== sessionId && bySession.has(parent) ? parent : undefined;
  };
  const children = new Map<string | undefined, string[]>();
  for (const sessionId of bySession.keys()) {
    const parent = parentOf(sessionId);
    children.set(parent, [...(children.get(parent) ?? []), sessionId]);
  }
  const result: TreeBranch[] = [];
  const visit = (sessionId: string, depth: number) => {
    const own = bySession.get(sessionId)!;
    result.push({
      sessionId, depth,
      firstLabel: own[0]?.label,
      lastLabel: own.at(-1)?.label,
      running: own.some((node) => node.status === "pending"),
      unread: own.some((node) => node.unread)
    });
    for (const child of children.get(sessionId) ?? []) visit(child, depth + 1);
  };
  const roots = children.get(undefined) ?? [];
  // The tree's own root comes first even when another member has an earlier node.
  roots.sort((a, b) => (a === tree.treeId ? -1 : b === tree.treeId ? 1 : 0));
  for (const root of roots) visit(root, 0);
  return result;
};

export const branchesStatus = (branches: TreeBranch[]): "none" | "running" | "unread_completed" =>
  branches.some((branch) => branch.running) ? "running" : branches.some((branch) => branch.unread) ? "unread_completed" : "none";
