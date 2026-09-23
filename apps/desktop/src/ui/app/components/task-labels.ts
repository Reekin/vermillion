import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { isPreparingWork } from "./work-board-display.js";

export const statusLabel: Record<WorkItem["status"], string> = { preparing: "准备", queued: "排队", running: "执行", merging: "待合入", closed: "已关闭", cancelled: "已取消" };
export type CurrentWorkState = "running" | "queued" | "paused" | "stopped" | "interrupted" | "confirmation" | "decision" | "finished";

export const workPhaseLabel = (item?: WorkItem, request?: WorkRequest) => item ? statusLabel[item.status]
  : request?.status === "cancelled" ? "已取消" : request?.status === "ready" ? "已交接" : "准备";

export const workSessionLabel = (item?: WorkItem, request?: WorkRequest) => {
  const run = item?.run ?? request;
  if (run?.turnStatus === "unknown") return "运行状态未确认";
  if (run?.activeTurnId) return "会话运行中";
  if (run?.userStopped) return "用户已停止";
  if (item?.run.lastFailure || request?.failure) return "会话失败";
  if (item?.status === "running" || request?.status === "preparing") return "会话已结束 · 尚未交付";
  return "无活动轮次";
};

export const currentWorkStatus = (item?: WorkItem, request?: WorkRequest, hasDecision = false): { kind: CurrentWorkState; label: string } => {
  const status = item?.status ?? request?.status;
  const run = item?.run ?? request;
  if (status === "closed" || status === "cancelled" || (!item && status === "ready" && !run?.activeTurnId))
    return { kind: "finished", label: status === "cancelled" ? "已取消" : status === "ready" ? "已交接" : "已完成" };
  if (run?.paused) return { kind: "paused", label: "已暂停" };
  if (hasDecision) return { kind: "decision", label: "等待决策" };
  if (run?.turnStatus === "unknown") return { kind: "confirmation", label: "运行状态未确认" };
  if (run?.activeTurnId) return { kind: "running", label: "会话运行中" };
  if (run?.userStopped) return { kind: "stopped", label: "用户已停止" };
  if (status === "failed" || item?.run.lastFailure || request?.failure) return { kind: "interrupted", label: "已中断" };
  return { kind: "queued", label: status === "running" || status === "preparing" ? "尚未交付" : status === "merging" ? "等待合入" : "等待推进" };
};

export const workRequestStatus = (request: WorkRequest, items: WorkItem[]): { label: string; status: WorkItem["status"] | "decision" } => {
  if (request.paused) return { label: "已暂停", status: "decision" };
  if (!isPreparingWork(request) && items.length) {
    const open = items.filter((item) => item.status !== "closed" && item.status !== "cancelled");
    if (!open.length) {
      const closed = items.filter((item) => item.status === "closed").length;
      return { label: closed === items.length ? "已完成" : closed ? "部分完成" : "已取消", status: closed ? "closed" : "cancelled" };
    }
    if (open.some((item) => item.run.activeTurnId && item.run.turnStatus !== "unknown")) return { label: "会话运行中", status: "running" };
    if (open.every((item) => item.run.paused)) return { label: "已暂停", status: "decision" };
    if (open.some((item) => item.run.turnStatus === "unknown")) return { label: "运行状态未确认", status: "decision" };
    if (open.some((item) => item.run.lastFailure)) return { label: "已中断", status: "decision" };
    return { label: "等待推进", status: "queued" };
  }
  const state = currentWorkStatus(undefined, request);
  return { label: state.label, status: state.kind === "finished" ? request.status === "cancelled" ? "cancelled" : "closed"
    : state.kind === "running" ? "running" : state.kind === "queued" ? "queued" : "decision" };
};

export const workItemBoardLabel = (item: WorkItem, progressLabel: string) => {
  if (item.status === "closed" || item.status === "cancelled") return statusLabel[item.status];
  const state = currentWorkStatus(item);
  return ["paused", "stopped", "confirmation", "interrupted"].includes(state.kind) ? state.label : progressLabel;
};
