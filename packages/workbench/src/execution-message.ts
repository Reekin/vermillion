import type { WorkItem } from "./contracts.js";

/** The first accepted Worker message carries the same contract context for every sender. */
export function workerOpeningMessage(workspaceId: string, item: WorkItem, root: string): string {
  const isolated = !!item.run.worktreePath;
  return [
    "You own the work item \"" + item.title + "\".",
    "workspaceId: " + workspaceId,
    "workItemId: " + item.workItemId,
    "contractRevision: " + item.contractRevision,
    "sourceSessionId: " + (item.sourceSessionId ?? ""),
    "sourceTurnId: " + (item.sourceTurnId ?? ""),
    "Session cwd: " + root,
    "Working directory: " + (item.run.worktreePath ?? root) + (isolated ? " (isolated worktree, branch " + item.run.branch + ")" : " (workspace root, no branch)"),
    ...(isolated ? [
      "The session cwd stays at the workspace root. When working on this work item's files, set the tool workdir, use git -C, or use absolute paths inside the worktree.",
      "Workspace root (read-only main branch): " + root,
      "Before submitting, commit the results within allowedPaths on your own branch, read the current main branch SHA with git -C " + JSON.stringify(root) + " rev-parse HEAD, and run git rebase <that SHA> in this worktree. Do not modify or merge the main branch.",
      "Resolve rebase conflicts on your own branch and continue; review and verify on the rebased result. Read the main branch HEAD again before workItem.submit; if it moved, rebase again and update the affected verification and submission material."
    ] : []),
    "First read the full work item with the CLI: vermillion workItem.get '" + JSON.stringify({ workspaceId, workItemId: item.workItemId }) + "'",
    "Pass this work item's fixed sessionId to workItem.submit: " + item.run.sessionId,
    "When finished you must call workItem.submit. Call decision.create when the user must decide; when you find a dependency on another unmerged work item, change dependsOn with workItem.update. End the session after the call.",
    "sessionId: " + item.run.sessionId,
    "actionId: execution-" + item.workItemId
  ].join("\n");
}
