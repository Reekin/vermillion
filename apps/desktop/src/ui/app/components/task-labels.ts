import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";

export const statusLabel: Record<WorkItem["status"], string> = { preparing: "准备中", queued: "排队中", running: "进行中", merging: "等待合入", decision: "等待用户", closed: "已关闭", cancelled: "已取消" };

export type CurrentWorkState = "running" | "queued" | "manual" | "paused" | "interrupted" | "confirmation" | "decision" | "finished";

/** Fault causes stay in details; the work bar presents one lifecycle state. */
export const currentWorkStatus = (item?: WorkItem, request?: WorkRequest, hasDecision = false): { kind: CurrentWorkState; label: string } => {
  const status = item?.status ?? request?.status;
  const run = item?.run ?? request;
  if (status === "closed" || status === "cancelled" || (!item && status === "ready"))
    return { kind: "finished", label: status === "cancelled" ? "已取消" : status === "ready" ? "已交接" : "已完成" };
  if (run?.control === "paused" || item?.run.pauseReason === "user") return { kind: "paused", label: "已暂停" };
  if (hasDecision) return { kind: "decision", label: "等待决策" };
  if (run?.pendingMessageId && run.waitReason) return { kind: "confirmation", label: "等待确认" };
  const failure = item?.run.lastFailure ?? request?.failure;
  if (status === "failed" || run?.retryAt || (failure && !run?.activeTurnId && (status === "decision" || run?.control === "manual")))
    return { kind: "interrupted", label: "已中断" };
  if (run?.control === "manual") return { kind: "manual", label: "人工接管" };
  if (status === "decision") return { kind: "decision", label: "等待决策" };
  if (status === "running" || status === "preparing") return { kind: "running", label: status === "preparing" ? "准备中" : "执行中" };
  return { kind: "queued", label: status === "merging" ? "等待合入" : status === "pending" ? "等待准备" : "排队中" };
};
