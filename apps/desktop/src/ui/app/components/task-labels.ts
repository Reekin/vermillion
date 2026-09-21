import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { isPreparingWork } from "./work-board-display.js";

export const statusLabel: Record<WorkItem["status"], string> = { preparing: "准备中", queued: "排队中", running: "进行中", merging: "等待合入", decision: "等待用户", closed: "已关闭", cancelled: "已取消" };

export type CurrentWorkState = "running" | "queued" | "manual" | "paused" | "interrupted" | "confirmation" | "decision" | "finished";

/** Work summaries aggregate child outcomes without repeating their individual labels. */
export const workRequestStatus = (request: WorkRequest, items: WorkItem[]): { label: string; status: WorkItem["status"] } => {
  if (isPreparingWork(request)) {
    const state = currentWorkStatus(undefined, request);
    return { label: request.status === "ready" ? "准备收尾" : state.label,
      status: request.activeTurnId && request.turnStatus !== "unknown" ? "running" : state.kind === "queued" ? "queued" : "decision" };
  }
  const open = items.filter((item) => item.status !== "closed" && item.status !== "cancelled");
  if (items.length && !open.length) {
    const closed = items.filter((item) => item.status === "closed").length;
    return { label: closed === items.length ? "已完成" : closed ? "部分完成" : "已取消", status: closed ? "closed" : "cancelled" };
  }
  if (open.length) {
    if (open.some((item) => item.run.activeTurnId && item.run.turnStatus !== "unknown")) return { label: "执行中", status: "running" };
    if (open.every((item) => item.run.control === "paused" || item.run.pauseReason === "user")) return { label: "已暂停", status: "decision" };
    if (open.some((item) => item.run.turnStatus === "unknown")) return { label: "等待确认", status: "decision" };
    if (open.some((item) => item.status === "decision" && item.run.control !== "paused" && item.run.pauseReason !== "user")) return { label: "等待用户", status: "decision" };
    if (open.some((item) => item.run.lastFailure || item.run.retryAt)) return { label: "已中断", status: "decision" };
    if (open.some((item) => item.run.control === "manual")) return { label: "人工接管", status: "decision" };
    return { label: "等待推进", status: "queued" };
  }
  const state = currentWorkStatus(undefined, request);
  return { label: state.label, status: state.kind === "finished" ? (request.status === "cancelled" ? "cancelled" : "closed")
    : request.activeTurnId && request.turnStatus !== "unknown" ? "running" : state.kind === "queued" ? "queued" : "decision" };
};

export const workItemBoardLabel = (item: WorkItem, progressLabel: string) => {
  if (item.status === "closed" || item.status === "cancelled") return statusLabel[item.status];
  const state = currentWorkStatus(item);
  if (["paused", "manual", "confirmation"].includes(state.kind)) return state.label;
  if (state.kind === "interrupted" && item.status !== "queued" && item.status !== "merging") return state.label;
  return progressLabel;
};

/** Fault causes stay in details; the work bar presents one lifecycle state. */
export const currentWorkStatus = (item?: WorkItem, request?: WorkRequest, hasDecision = false): { kind: CurrentWorkState; label: string } => {
  const status = item?.status ?? request?.status;
  const run = item?.run ?? request;
  if (status === "closed" || status === "cancelled" || (!item && status === "ready"))
    return { kind: "finished", label: status === "cancelled" ? "已取消" : status === "ready" ? "已交接" : "已完成" };
  if (run?.control === "paused" || item?.run.pauseReason === "user") return { kind: "paused", label: "已暂停" };
  if (hasDecision) return { kind: "decision", label: "等待决策" };
  if (run?.turnStatus === "unknown" || (run?.pendingMessageId && run.waitReason)) return { kind: "confirmation", label: "等待确认" };
  const failure = item?.run.lastFailure ?? request?.failure;
  if (status === "failed" || run?.retryAt || (failure && status === "decision"))
    return { kind: "interrupted", label: "已中断" };
  if (run?.control === "manual") return { kind: "manual", label: "人工接管" };
  if (status === "decision") return { kind: "decision", label: "等待决策" };
  if (status === "running" || status === "preparing") return { kind: "running", label: status === "preparing" ? "准备中" : "执行中" };
  return { kind: "queued", label: status === "merging" ? "等待合入" : status === "pending" ? "等待准备" : "排队中" };
};
