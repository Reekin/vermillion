import { actionIsOpen, type WorkflowAction, type WorkItem } from "@vermillion/workbench/client";

export const roleLabel: Record<string, string> = { steward: "管家", worker: "Worker", supervisor: "Supervisor", "workspace-repair": "WorkspaceRepair（工作区修复）", workbench: "工作台" };
export const actionStatusLabel: Record<WorkflowAction["status"], string> = { pending: "待接手", running: "处理中", waiting: "等待条件", retry: "等待重试", decision: "待决策", done: "已解决", cancelled: "已取消" };
export const actionKindLabel: Record<WorkflowAction["kind"], string> = { execute: "执行恢复", contract: "合同处置", dependency: "依赖处置", repair: "主工作区修复", integration: "合入处置", revision: "任务处置" };
const stageLabel: Record<WorkflowAction["stage"], string> = { worktree: "准备工作目录", open: "打开会话", deliver: "送达消息", execute: "执行", merge: "合入", rollback: "回滚", cleanup: "清理" };

export const dispositionSummary = (action: WorkflowAction): string[] => action.history.flatMap((entry) => {
  const stage = entry.event.startsWith("failed:") ? entry.event.slice(7) : "";
  if (stage in stageLabel) return ["尝试" + stageLabel[stage as WorkflowAction["stage"]] + "，未完成。"];
  if (["repair.submitted", "contract.updated", "dependency.updated", "resolved"].includes(entry.event)) return [entry.message.split("\n")[0]!];
  if (entry.event === "repair.check.failed") return ["已提交修复，工作台检查仍未通过。"];
  return [];
});

export const waitingActions = (actions: WorkflowAction[], item: WorkItem) => actions.filter((action) =>
  action.workItemIds.includes(item.workItemId) && actionIsOpen(action) && (!["execute", "integration"].includes(action.kind) || ["waiting", "retry", "decision"].includes(action.status))
).sort((a, b) => Number(b.kind === "repair") - Number(a.kind === "repair") || b.updatedAt.localeCompare(a.updatedAt));

export const waitingReason = (action: WorkflowAction) => {
  if (action.status === "retry") return stageLabel[action.stage] + "失败，等待重试";
  if (action.status === "decision") return actionKindLabel[action.kind] + "等待答复";
  return { execute: "等待恢复执行", contract: "等待合同落实", dependency: "等待前置工单", repair: "等待主工作区恢复", integration: "等待" + stageLabel[action.stage], revision: "等待任务处置" }[action.kind];
};

export const recoveryCondition = (action: WorkflowAction) => {
  if (action.status === "decision") return "答复决策后，由当前处理者落实并检查恢复条件。";
  if (action.status === "retry") return "到达重试时间后，从" + stageLabel[action.stage] + "继续；其他等待条件仍须满足。";
  return { execute: "处理者完成修复后继续执行。", contract: "管家落实相关合同、依赖或明确处置。", dependency: "前置工单关闭；已取消的前置由管家调整。", repair: "工作区修复提交结果，并通过工作台的恢复检查。", integration: "主工作区可用，由工作台完成" + stageLabel[action.stage] + "。", revision: "管家落实任务安排。" }[action.kind];
};
