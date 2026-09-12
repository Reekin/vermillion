import { actionIsOpen, isUserPaused, type WorkflowAction, type WorkItem } from "@vermillion/workbench/client";

export const roleLabel: Record<string, string> = { worker: "Worker", workbench: "工作台", "design-partner": "设计伙伴", maintainer: "Maintainer", liaison: "Liaison" };
export const actionStatusLabel: Record<WorkflowAction["status"], string> = { pending: "待接手", running: "处理中", retry: "等待重试", decision: "待决策", done: "已解决", cancelled: "已取消" };
export const actionKindLabel: Record<WorkflowAction["kind"], string> = { execute: "执行恢复", integration: "合入处置" };
const stageLabel: Record<WorkflowAction["stage"], string> = { open: "打开会话", deliver: "送达消息", execute: "执行", merge: "合入", rollback: "回滚" };
export const actionRoleLabel = (action: WorkflowAction) => roleLabel[action.kind === "execute" || (action.kind === "integration" && action.agent) ? "worker" : "workbench"];

export const integrationProgress = (action: WorkflowAction, item?: WorkItem): string | undefined => {
  if (action.kind !== "integration") return undefined;
  if (!actionIsOpen(action)) return actionStatusLabel[action.status];
  if (action.agent) {
    if (item?.run.pauseReason === "user") return "用户暂停";
    if (item?.status === "decision") return "Agent 合入等待答复";
    if (item?.run.retryAt) return "Agent 合入等待重试";
    if (item?.status === "queued") return "等待 Agent 接手";
    return "Agent 处理合入";
  }
  if (action.status === "retry") return `合入失败 · 自动重试第 ${Math.min(action.attempts, 4)}/4 次`;
  if (action.status === "decision") return `合入失败 · 自动重试已用尽（已失败 ${action.attempts} 次）`;
  if (action.status === "running") return "正在合入";
  if (action.status === "pending") return "等待合入";
  return actionStatusLabel[action.status];
};

export const integrationShortStatus = (action: WorkflowAction, item?: WorkItem): string | undefined => {
  if (action.kind !== "integration") return undefined;
  if (action.agent) return item?.status === "running" ? "Agent处理" : integrationProgress(action, item);
  if (action.status === "retry") return "等待重试";
  if (action.status === "decision") return "待处置";
  if (action.status === "running") return "合入中";
  if (action.status === "pending") return "等待合入";
  return actionStatusLabel[action.status];
};

export const integrationFailureSummary = (action: WorkflowAction): string | undefined => {
  if (action.kind !== "integration" || !action.failure) return undefined;
  const files = action.failure.match(/following files would be overwritten by merge:\s*([\s\S]*?)(?:\r?\nPlease|$)/i)?.[1]
    ?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (files?.length) return "主工作区有未提交修改：" + files.join("、");
  if (/outside repository/i.test(action.failure)) return "交付路径包含仓库外文件，无法进行 Git 合入。";
  if (/Worker must commit its worktree/i.test(action.failure)) return "Worker worktree 仍有未提交修改。";
  if (/conflict/i.test(action.failure)) return "合入发生冲突，需要处理后继续。";
  const error = action.failure.split(/\r?\n/).find((line) => /^error:/i.test(line))?.replace(/^error:\s*/i, "").trim();
  const summary = error || action.failure.split(/\r?\n/).find(Boolean)?.trim();
  if (!summary) return undefined;
  return summary.length > 160 ? summary.slice(0, 157) + "…" : summary;
};

export const actionStatusText = (action: WorkflowAction, item?: WorkItem) => integrationProgress(action, item) ?? actionStatusLabel[action.status];

export const dispositionSummary = (action: WorkflowAction): string[] => action.history.flatMap((entry) => {
  const stage = entry.event.startsWith("failed:") ? entry.event.slice(7) : "";
  if (stage in stageLabel) return ["尝试" + stageLabel[stage as WorkflowAction["stage"]] + "，未完成。"];
  if (["contract.updated", "dependency.updated", "resolved"].includes(entry.event)) return [entry.message.split("\n")[0]!];
  return [];
});

export const waitingActions = (actions: WorkflowAction[], item: WorkItem) => actions.filter((action) =>
  action.workItemId === item.workItemId && actionIsOpen(action) && ["retry", "decision"].includes(action.status)
).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const waitingReason = (action: WorkflowAction) => {
  if (action.kind === "integration" && action.agent) return integrationProgress(action)!;
  if (isUserPaused(action)) return "用户已暂停";
  if (action.status === "retry") return stageLabel[action.stage] + "失败，等待重试";
  if (action.status === "decision") return actionKindLabel[action.kind] + "等待答复";
  return action.kind === "execute" ? "等待恢复执行" : "等待" + stageLabel[action.stage];
};

export const recoveryCondition = (action: WorkflowAction) => {
  if (action.kind === "integration" && action.agent) return "Agent 处理 worktree/rebase 后，登记最终合入。";
  if (isUserPaused(action)) return "明确恢复后，Worker 从原会话继续执行。";
  if (action.status === "decision") return "答复决策后，由当前处理者落实并检查恢复条件。";
  if (action.status === "retry") return "到达重试时间后，从" + stageLabel[action.stage] + "继续；其他等待条件仍须满足。";
  return action.kind === "execute" ? "Worker 从原会话继续执行。" : "由工作台完成" + stageLabel[action.stage] + "。";
};
