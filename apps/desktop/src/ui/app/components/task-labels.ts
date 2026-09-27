import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { t } from "../../../i18n/index.js";
import type { StatusTone } from "./ui.js";

export const isOpenWorkItem = (item: WorkItem) => item.status !== "closed" && item.status !== "cancelled";
export const isPreparingWork = (request: WorkRequest) => request.status !== "cancelled" && (request.status !== "ready" || Boolean(request.activeTurnId));
export const isOpenWorkRequest = (request: WorkRequest, items: WorkItem[]) => isPreparingWork(request) || items.some(isOpenWorkItem);

export const statusLabel = (status: WorkItem["status"]): string => t(`work.status.${status}`);
export type CurrentWorkState = "running" | "queued" | "paused" | "stopped" | "interrupted" | "confirmation" | "decision" | "finished";

export const workPhaseLabel = (item?: WorkItem, request?: WorkRequest) => item ? statusLabel(item.status)
  : request?.status === "cancelled" ? t("work.status.cancelled") : request?.status === "ready" ? t("work.state.handedOff") : t("work.status.preparing");

export const workSessionLabel = (item?: WorkItem, request?: WorkRequest) => {
  const run = item?.run ?? request;
  if (run?.turnStatus === "unknown") return t("work.state.unconfirmed");
  if (run?.activeTurnId) return t("work.state.sessionRunning");
  if (run?.userStopped) return t("work.state.userStopped");
  if (item?.run.lastFailure || request?.failure) return t("work.state.sessionFailed");
  if (item?.status === "running" || request?.status === "preparing") return t("work.state.endedUndelivered");
  return t("work.state.noActiveTurn");
};

export const currentWorkStatus = (item?: WorkItem, request?: WorkRequest, hasDecision = false): { kind: CurrentWorkState; label: string } => {
  const status = item?.status ?? request?.status;
  const run = item?.run ?? request;
  if (status === "closed" || status === "cancelled" || (!item && status === "ready" && !run?.activeTurnId))
    return { kind: "finished", label: status === "cancelled" ? t("work.status.cancelled") : status === "ready" ? t("work.state.handedOff") : t("work.state.completed") };
  if (run?.paused) return { kind: "paused", label: t("work.state.paused") };
  if (hasDecision) return { kind: "decision", label: t("work.state.awaitingDecision") };
  if (run?.turnStatus === "unknown") return { kind: "confirmation", label: t("work.state.unconfirmed") };
  if (run?.activeTurnId) return { kind: "running", label: t("work.state.sessionRunning") };
  if (run?.userStopped) return { kind: "stopped", label: t("work.state.userStopped") };
  if (status === "failed" || item?.run.lastFailure || request?.failure) return { kind: "interrupted", label: t("work.state.interrupted") };
  return { kind: "queued", label: status === "running" || status === "preparing" ? t("work.state.notDelivered")
    : status === "merging" ? t("work.state.awaitingMerge") : t("work.state.awaitingProgress") };
};

export const workRequestStatus = (request: WorkRequest, items: WorkItem[]): { label: string; status: WorkItem["status"] | "decision" } => {
  if (!isOpenWorkRequest(request, items)) {
    if (!items.length) return request.status === "cancelled" ? { label: t("work.status.cancelled"), status: "cancelled" } : { label: t("work.state.handedOff"), status: "closed" };
    const closed = items.filter((item) => item.status === "closed").length;
    return { label: closed === items.length ? t("work.state.completed") : closed ? t("work.state.partlyCompleted") : t("work.status.cancelled"), status: closed ? "closed" : "cancelled" };
  }
  if (request.paused) return { label: t("work.state.paused"), status: "decision" };
  if (!isPreparingWork(request) && items.length) {
    const open = items.filter(isOpenWorkItem);
    if (open.some((item) => item.run.activeTurnId && item.run.turnStatus !== "unknown")) return { label: t("work.state.sessionRunning"), status: "running" };
    if (open.every((item) => item.run.paused)) return { label: t("work.state.paused"), status: "decision" };
    if (open.some((item) => item.run.turnStatus === "unknown")) return { label: t("work.state.unconfirmed"), status: "decision" };
    if (open.some((item) => item.run.lastFailure)) return { label: t("work.state.interrupted"), status: "decision" };
    return { label: t("work.state.awaitingProgress"), status: "queued" };
  }
  const state = currentWorkStatus(undefined, request);
  return { label: state.label, status: state.kind === "finished" ? request.status === "cancelled" ? "cancelled" : "closed"
    : state.kind === "running" ? "running" : state.kind === "queued" ? "queued" : "decision" };
};

/** State colour for a board status: needing the user is attention, finished work is done or neutral. */
export const statusTone = (status: WorkItem["status"] | "decision"): StatusTone =>
  status === "running" ? "running" : status === "decision" ? "attention" : status === "closed" ? "done" : status === "cancelled" ? "neutral" : "waiting";

/** Board status for an open item's current state: anything the user must resolve reads as needing attention. */
export const currentWorkTone = (kind: CurrentWorkState): WorkItem["status"] | "decision" =>
  kind === "running" ? "running" : kind === "queued" ? "queued" : kind === "finished" ? "closed" : "decision";

export const workItemBoardLabel = (item: WorkItem, progressLabel: string) => {
  if (item.status === "closed" || item.status === "cancelled") return statusLabel(item.status);
  const state = currentWorkStatus(item);
  return ["paused", "stopped", "confirmation", "interrupted"].includes(state.kind) ? state.label : progressLabel;
};
