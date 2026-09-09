import { actionIsOpen, type WorkflowAction, type WorkItem } from "@vermillion/workbench/client";

export const roleLabel: Record<string, string> = { worker: "Worker", workbench: "工作台", "design-partner": "设计伙伴", maintainer: "Maintainer", liaison: "Liaison" };
export const actionStatusLabel: Record<WorkflowAction["status"], string> = { pending: "待接手", running: "处理中", retry: "等待重试", decision: "待决策", done: "已解决", cancelled: "已取消" };
export const actionKindLabel: Record<WorkflowAction["kind"], string> = { execute: "执行恢复", integration: "合入处置" };
const stageLabel: Record<WorkflowAction["stage"], string> = { open: "打开会话", deliver: "送达消息", execute: "执行", merge: "合入", rollback: "回滚" };
export const actionRoleLabel = (action: WorkflowAction) => roleLabel[action.kind === "execute" ? "worker" : "workbench"];

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
  if (action.status === "retry") return stageLabel[action.stage] + "失败，等待重试";
  if (action.status === "decision") return actionKindLabel[action.kind] + "等待答复";
  return action.kind === "execute" ? "等待恢复执行" : "等待" + stageLabel[action.stage];
};

export const recoveryCondition = (action: WorkflowAction) => {
  if (action.status === "decision") return "答复决策后，由当前处理者落实并检查恢复条件。";
  if (action.status === "retry") return "到达重试时间后，从" + stageLabel[action.stage] + "继续；其他等待条件仍须满足。";
  return action.kind === "execute" ? "Worker 从原会话继续执行。" : "由工作台完成" + stageLabel[action.stage] + "。";
};
