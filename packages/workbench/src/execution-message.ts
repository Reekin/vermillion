import type { WorkItem } from "./contracts.js";

/** The first accepted Worker message carries the same contract context for every sender. */
export function workerOpeningMessage(workspaceId: string, item: WorkItem, root: string): string {
  const isolated = !!item.run.worktreePath;
  return [
    "你负责工单「" + item.title + "」。",
    "workspaceId: " + workspaceId,
    "workItemId: " + item.workItemId,
    "contractRevision: " + item.contractRevision,
    "sourceSessionId: " + (item.sourceSessionId ?? ""),
    "sourceTurnId: " + (item.sourceTurnId ?? ""),
    "会话 cwd: " + root,
    "工作目录: " + (item.run.worktreePath ?? root) + (isolated ? "（独立 worktree，分支 " + item.run.branch + "）" : "（workspace 根目录，不开分支）"),
    ...(isolated ? [
      "会话 cwd 保持 workspace 根目录。操作本工单文件时显式指定工具 workdir、git -C 或 worktree 内的绝对路径。",
      "workspace 根目录（只读主分支）: " + root,
      "提交前先在自己的分支提交 allowedPaths 内的成果，再用 git -C " + JSON.stringify(root) + " rev-parse HEAD 读取主分支当前 SHA，在本 worktree 执行 git rebase <该 SHA>。不要修改或合并主分支。",
      "rebase 冲突在自己的分支解决并继续；基于 rebase 后的结果做 review 和验收。workItem.submit 前再次读取主分支 HEAD，若已前进则重复 rebase 并更新受影响的验证和提交材料。"
    ] : []),
    "先用 CLI 读取完整工单：vermillion workItem.get '" + JSON.stringify({ workspaceId, workItemId: item.workItemId }) + "'",
    ...(item.run.migratedFromSessionId ? ["本工单已从历史节点迁移到当前分支；调用 workItem.submit 时必须传当前 sessionId: " + item.run.sessionId] : []),
    "完成后必须调用 workItem.submit，需要用户决定时调用 decision.create，发现依赖另一张未合入的工单时通过 workItem.update 修改 dependsOn，需要用户取舍时直接创建决策卡；调用后结束会话。",
    "sessionId: " + item.run.sessionId,
    "actionId: execution-" + item.workItemId
  ].join("\n");
}
