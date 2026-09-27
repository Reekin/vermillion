import { actionIsOpen, actionNote, isUserPaused, type AgentRun, type DecisionCard, type Execution, type WorkflowAction, type WorkItem, type WorkRequest } from "@vermillion/workbench/client";
import { t } from "../../../i18n/index.js";
import { formatClock, joinList } from "../../../i18n/format.js";
import { isOpenWorkItem, isOpenWorkRequest, isPreparingWork, statusLabel, workSessionLabel } from "./task-labels.js";
import type { Step } from "./ui.js";

/** Display name of a session role; undefined for roles without one. */
export const roleLabel = (role: string): string | undefined => {
  switch (role) {
    case "worker": return t("work.role.worker");
    case "supervisor": return t("work.role.supervisor");
    case "workbench": return t("work.role.workbench");
    case "design-partner": return t("work.role.designPartner");
    case "maintainer": return t("work.role.maintainer");
    case "liaison": return t("work.role.liaison");
    default: return undefined;
  }
};
export const actionStatusLabel = (status: WorkflowAction["status"]): string => t(`work.action.status.${status}`);
export const actionKindLabel = (kind: WorkflowAction["kind"]): string => t(`work.action.kind.${kind}`);
const stages = new Set<string>(["open", "deliver", "execute", "merge", "rollback"] satisfies WorkflowAction["stage"][]);
const stageLabel = (stage: WorkflowAction["stage"]): string => t(`work.stage.${stage}`);
export const actionRoleLabel = (action: WorkflowAction) => action.kind === "execute" || (action.kind === "integration" && action.agent) ? t("work.role.worker") : t("work.role.workbench");

export const integrationProgress = (action: WorkflowAction, item?: WorkItem): string | undefined => {
  if (action.kind !== "integration") return undefined;
  if (!actionIsOpen(action)) return actionStatusLabel(action.status);
  if (action.agent) {
    if (item?.run.paused) return t("work.integration.userPaused");
    if (item?.run.lastFailure) return t("work.integration.workerBlocked");
    return item?.run.activeTurnId ? t("work.integration.workerMerging") : t("work.integration.awaitingWorker");
  }
  if (action.status === "decision") return t("work.integration.blocked");
  if (action.status === "running") return t("work.integration.inProgress");
  if (action.status === "pending") return t("work.state.awaitingMerge");
  return actionStatusLabel(action.status);
};

export const integrationShortStatus = (action: WorkflowAction, item?: WorkItem): string | undefined => {
  if (action.kind !== "integration") return undefined;
  if (action.agent) return integrationProgress(action, item);
  if (action.status === "decision") return t("work.action.status.decision");
  if (action.status === "running") return t("work.integration.merging");
  if (action.status === "pending") return t("work.state.awaitingMerge");
  return actionStatusLabel(action.status);
};

export const integrationFailureSummary = (action: WorkflowAction): string | undefined => {
  if (action.kind !== "integration" || !action.failure) return undefined;
  const files = action.failure.match(/following files would be overwritten by merge:\s*([\s\S]*?)(?:\r?\nPlease|$)/i)?.[1]
    ?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (files?.length) return t("work.failure.dirtyMain", { files: joinList(files) });
  if (/outside repository/i.test(action.failure)) return t("work.failure.outsideRepo");
  if (/Worker must commit its worktree/i.test(action.failure)) return t("work.failure.workerUncommitted");
  if (/conflict/i.test(action.failure)) return t("work.failure.conflictSummary");
  const error = action.failure.split(/\r?\n/).find((line) => /^error:/i.test(line))?.replace(/^error:\s*/i, "").trim();
  const summary = error || action.failure.split(/\r?\n/).find(Boolean)?.trim();
  if (!summary) return undefined;
  return summary.length > 160 ? summary.slice(0, 157) + "…" : summary;
};

export const actionStatusText = (action: WorkflowAction, item?: WorkItem) => integrationProgress(action, item) ?? actionStatusLabel(action.status);

export const dispositionSummary = (action: WorkflowAction): string[] => action.history.flatMap((entry) => {
  const stage = entry.event.startsWith("failed:") ? entry.event.slice(7) : "";
  if (stages.has(stage)) return [t("work.disposition.attempted", { stage: stageLabel(stage as WorkflowAction["stage"]) })];
  if (["contract.updated", "dependency.updated", "resolved"].includes(entry.event)) return [entry.message.split("\n")[0]!];
  return [];
});

export const waitingActions = (actions: WorkflowAction[], item: WorkItem) => actions.filter((action) =>
  action.workItemId === item.workItemId && actionIsOpen(action) && action.status === "decision"
).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const waitingReason = (action: WorkflowAction) => {
  if (action.kind === "integration" && action.agent) return integrationProgress(action)!;
  if (isUserPaused(action)) return t("work.waiting.userPaused");
  if (action.status === "decision") return t("work.waiting.blocked", { kind: actionKindLabel(action.kind) });
  return action.kind === "execute" ? t("work.waiting.resumeExecution") : t("work.waiting.stage", { stage: stageLabel(action.stage) });
};

export const recoveryCondition = (action: WorkflowAction) => {
  if (action.kind === "integration" && action.agent) return t("work.recovery.agent");
  if (isUserPaused(action)) return t("work.recovery.userPaused");
  if (action.status === "decision") return t("work.recovery.decision");
  return action.kind === "execute" ? t("work.recovery.execute") : t("work.recovery.stage", { stage: stageLabel(action.stage) });
};

export type WorkItemProgress = {
  shortLabel: string;
  title: string;
  reason?: string;
  handler: string;
  next: string;
  userAction?: string;
  at?: string;
};

export type WorkItemEvent = {
  at: string;
  title: string;
  detail?: string;
};

const latestAction = (actions: WorkflowAction[], kind: WorkflowAction["kind"], workItemId: string) => actions
  .filter((action) => action.workItemId === workItemId && action.kind === kind)
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

const rejectionSummary = (reason: string) => {
  const line = reason.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? reason;
  if (/Worker must commit its worktree/i.test(reason)) return t("work.failure.workerUncommitted");
  if (/outside repository/i.test(reason)) return t("work.failure.outsideRepo");
  if (/conflict/i.test(reason)) return t("work.failure.conflictSummary");
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
};

// The patterns below match Chinese text produced by the workbench service, written as escapes:
// handedOffNote = "工单已进入 <status>", unrecoverable = "进程重启|无法恢复", noSubmission = "多轮未提交",
// failedResolution = "转回原 Worker|冲突|失败|未通过", nextHint = "下一步[:：]".
const handedOffNote = /\u5de5\u5355\u5df2\u8fdb\u5165\s+\w+/i;
const unrecoverable = /\u8fdb\u7a0b\u91cd\u542f|\u65e0\u6cd5\u6062\u590d/;
const noSubmission = /\u591a\u8f6e\u672a\u63d0\u4ea4/;
const failedResolution = /\u8f6c\u56de\u539f Worker|\u51b2\u7a81|\u5931\u8d25|\u672a\u901a\u8fc7/i;
const nextHint = /\s*\u4e0b\u4e00\u6b65[:\uff1a]/;

const readableRunNote = (note?: string) => !note || /^(done|completed|ok)$/i.test(note.trim()) ? undefined
  : handedOffNote.test(note) ? t("work.runNote.handedOff") : note;

const truncate = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + "…" : value;

export type ReadableFailure = { title: string; next: string; command?: string };

/** Turns an engine, Git or scheduler failure into a cause and next step; the raw text stays in technical detail. */
export const readableFailure = (text: string): ReadableFailure => {
  if (/is archived/i.test(text)) return { title: t("work.failure.archived"), next: t("work.failure.archivedNext"), command: text.match(/`(codex unarchive [^`]+)`/)?.[1] };
  if (/Historical execution is paused/i.test(text)) return { title: t("work.failure.historicalPaused"), next: t("work.failure.historicalPausedNext") };
  if (unrecoverable.test(text)) return { title: t("work.failure.unrecoverable"), next: t("work.failure.unrecoverableNext") };
  if (/turn interrupted/i.test(text)) return { title: t("work.failure.interrupted"), next: t("work.failure.interruptedNext") };
  if (noSubmission.test(text)) return { title: t("work.failure.noSubmission"), next: t("work.failure.noSubmissionNext") };
  if (/turn failed/i.test(text)) {
    const message = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    return { title: message ? t("work.failure.modelWithMessage", { message: truncate(message.replace(/\\(.)/g, "$1"), 80) }) : t("work.failure.model"), next: t("work.failure.modelNext") };
  }
  if (/conflict/i.test(text)) return { title: t("work.failure.conflict"), next: t("work.failure.conflictNext") };
  if (/Worker must commit its worktree/i.test(text)) return { title: t("work.failure.workerUncommitted"), next: t("work.failure.workerUncommittedNext") };
  if (/Command failed:\s*git/i.test(text)) return { title: t("work.failure.git"), next: t("work.failure.gitNext") };
  return { title: t("work.failure.unknown"), next: t("work.failure.unknownNext") };
};

/** A rejected board action as one readable sentence: drops the RPC method prefix and the CLI's "下一步" hint. */
export const readableActionError = (caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  const text = message.replace(/^\s*\[[\w.]+\]\s*/, "").split(nextHint)[0]!.trim();
  return text || t("work.failure.actionFailed");
};

/** What the user can do right from the board: resume, retry, answer or inspect in detail, or open the session. */
export type AttentionAction = "resume" | "retry" | "decision" | "detail" | "session";
export type Attention = ReadableFailure & { action?: AttentionAction; raw?: string };

const isPending = (card: DecisionCard) => !card.answer && !card.withdrawn;

export const pendingItemDecisions = (item: WorkItem, decisions: DecisionCard[], actions: WorkflowAction[]) => decisions.filter((card) => isPending(card)
  && (card.workItemId === item.workItemId || item.decisions.includes(card.decisionId)
    || actions.some((action) => action.actionId === card.actionId && action.workItemId === item.workItemId)));

export const pendingRequestDecisions = (request: WorkRequest, decisions: DecisionCard[]) =>
  decisions.filter((card) => isPending(card) && card.requestId === request.requestId && !card.workItemId);

const decisionAttention = (card: DecisionCard): Attention => ({
  title: t("work.labelValue", { label: t("work.attention.awaitingAnswer"), value: card.question }), next: t("work.attention.decisionNext"), action: "decision"
});

/** Why an open work item cannot continue without the user; undefined while it can proceed on its own. */
export const workItemAttention = (item: WorkItem, actions: WorkflowAction[], decisions: DecisionCard[]): Attention | undefined => {
  if (!isOpenWorkItem(item) || item.status === "preparing") return undefined;
  const card = pendingItemDecisions(item, decisions, actions)[0];
  if (card) return decisionAttention(card);
  if (item.run.paused) {
    const known = item.run.waitReason && /Historical execution is paused/i.test(item.run.waitReason) ? readableFailure(item.run.waitReason) : undefined;
    return { ...(known ?? { title: t("work.state.paused"), next: t("work.attention.pausedNext") }), action: "resume", raw: known ? item.run.waitReason : undefined };
  }
  if (item.run.userStopped && !item.run.activeTurnId) return { title: t("work.attention.stopped"), next: t("work.attention.stoppedNext"), action: "resume" };
  const blocked = actions.find((action) => action.workItemId === item.workItemId && action.kind === "integration" && actionIsOpen(action) && action.status === "decision" && !action.agent);
  if (blocked) return {
    title: t("work.labelValue", { label: t("work.integration.blocked"), value: integrationFailureSummary(blocked) ?? t("work.attention.mergeBlockedDefault") }),
    next: recoveryCondition(blocked), action: "detail", raw: blocked.kind === "integration" ? blocked.failure : undefined
  };
  if (item.run.lastFailure && !item.run.activeTurnId) return { ...readableFailure(item.run.lastFailure), action: "retry", raw: item.run.lastFailure };
  if (item.run.turnStatus === "unknown") return { title: t("work.state.unconfirmed"), next: t("work.attention.unconfirmedNext"), action: "session" };
  return undefined;
};

/** Work-level attention: preparation problems, or the whole work paused. Item problems are reported per item. */
export const workRequestAttention = (request: WorkRequest, items: WorkItem[], decisions: DecisionCard[]): Attention | undefined => {
  if (!isOpenWorkRequest(request, items)) return undefined;
  const stopped = request.paused || (request.userStopped && !request.activeTurnId);
  if (isPreparingWork(request)) {
    const card = pendingRequestDecisions(request, decisions)[0];
    if (card) return decisionAttention(card);
    if (request.failure) return { ...readableFailure(request.failure), action: stopped ? "resume" : "retry", raw: request.failure };
    if (request.paused) {
      const known = request.waitReason && /Historical execution is paused/i.test(request.waitReason) ? readableFailure(request.waitReason) : undefined;
      return { ...(known ?? { title: t("work.attention.preparationPaused"), next: t("work.attention.preparationNext") }), action: "resume", raw: known ? request.waitReason : undefined };
    }
    if (stopped) return { title: t("work.attention.preparationStopped"), next: t("work.attention.preparationNext"), action: "resume" };
    if (request.status === "failed") return { title: t("work.attention.preparationFailed"), next: t("work.attention.preparationFailedNext"), action: "retry" };
    if (request.turnStatus === "unknown") return { title: t("work.state.unconfirmed"), next: t("work.attention.preparationUnconfirmedNext"), action: "session" };
    return undefined;
  }
  if (request.paused) return { title: t("work.attention.workPaused"), next: t("work.attention.workPausedNext"), action: "resume" };
  return undefined;
};

/** Stage time: HH:MM today, otherwise prefixed with M/D so stages across days read in order. */
const clock = (value?: string, now = new Date()) => {
  if (!value) return undefined;
  const date = new Date(value);
  const hm = formatClock(date);
  return date.toDateString() === now.toDateString() ? hm : (date.getMonth() + 1) + "/" + date.getDate() + " " + hm;
};
const earliest = (values: Array<string | undefined>) => values.filter((value): value is string => Boolean(value)).sort()[0];
const latest = (values: Array<string | undefined>) => values.filter((value): value is string => Boolean(value)).sort().at(-1);

/** When the item first started executing, was last submitted for merge, and closed. */
const workItemMilestones = (item: WorkItem, actions: WorkflowAction[], runs: AgentRun[]) => {
  const own = actions.filter((action) => action.workItemId === item.workItemId);
  const integrations = own.filter((action) => action.kind === "integration").map((action) => action.createdAt);
  return {
    queued: item.createdAt,
    running: earliest([
      ...runs.filter((run) => run.workItemId === item.workItemId).map((run) => run.startedAt),
      ...own.flatMap((action) => action.kind === "execute" ? [action.startedAt] : [])
    ]),
    merging: earliest(integrations),
    lastSubmitted: latest(integrations),
    closed: item.status === "closed" ? item.merge?.mergedAt ?? item.updatedAt : undefined
  };
};

/** From the first execution to the last submission; an item still executing counts up to `now`. */
export const executionDuration = (item: WorkItem, actions: WorkflowAction[], runs: AgentRun[], now = Date.now()) => {
  const reached = workItemMilestones(item, actions, runs);
  if (!reached.running) return undefined;
  const end = item.status === "running" || item.status === "preparing" ? now
    : Date.parse(reached.lastSubmitted ?? (item.status === "cancelled" ? item.updatedAt : reached.running));
  const total = end - Date.parse(reached.running);
  return total > 0 ? total : undefined;
};

/** Lifecycle for the detail header: queued → executing → merging → closed, with times of passed stages. */
export const workItemSteps = (item: WorkItem, actions: WorkflowAction[], runs: AgentRun[], attention?: Attention, waitNote?: string): Step[] => {
  const reached = workItemMilestones(item, actions, runs);
  const steps = (["queued", "running", "merging", "closed"] as const).map((status) => [status, statusLabel(status)] as const);
  const cancelled = item.status === "cancelled";
  const currentIndex = item.status === "closed" ? 3 : cancelled
    ? (reached.merging ? 2 : reached.running ? 1 : 0)
    : Math.max(0, steps.findIndex(([status]) => status === item.status));
  return steps.map(([status, label], index) => {
    const time = clock(reached[status]);
    if (index < currentIndex || item.status === "closed") return { label, time, state: "done" };
    if (index > currentIndex) return { label, state: "pending" };
    if (cancelled) return { label, time, state: "current", tone: "failed", note: t("work.status.cancelled") };
    return { label, time, state: "current", tone: attention ? (attention.action === "retry" ? "failed" : "attention") : "running",
      // A wait note that only repeats the stage name adds nothing.
      note: attention?.title ?? (item.status === "preparing" ? t("work.state.preparing") : waitNote && waitNote !== label ? waitNote : undefined) };
  });
};

const matchingRun = (item: WorkItem, run?: AgentRun) => run && (!item.run.sessionId || run.sessionId === item.run.sessionId) ? run : undefined;

/** One deterministic user-facing explanation shared by the board row and the detail panel. */
export const workItemProgress = (item: WorkItem, actions: WorkflowAction[], run?: AgentRun, unresolvedDependencies: string[] = item.dependsOn): WorkItemProgress => {
  const execute = latestAction(actions, "execute", item.workItemId) as Execution | undefined;
  const integration = latestAction(actions, "integration", item.workItemId) as Extract<WorkflowAction, { kind: "integration" }> | undefined;
  const rejection = item.rejections.at(-1);
  const activeRun = matchingRun(item, run);

  if (item.run.paused) return {
    shortLabel: t("work.integration.userPaused"), title: t("work.progress.pausedTitle"), handler: t("work.role.you"), next: t("work.progress.pausedNext"),
    userAction: t("work.progress.pausedAction"), at: item.updatedAt
  };
  if (item.status === "closed") return {
    shortLabel: statusLabel("closed"), title: t("work.progress.closedTitle"), reason: [
      item.evidence?.summary,
      item.merge?.commit ? t("work.labelValue", { label: t("work.progress.mergeCommit"), value: item.merge.commit }) : undefined,
      item.verify ? t("work.progress.acceptance", { passed: item.verify.items.filter((entry) => entry.status === "pass").length, total: item.acceptance.length }) : undefined
    ].filter(Boolean).join(" · ") || undefined,
    handler: t("work.role.done"), next: item.merge?.commit ? t("work.progress.closedNextCommit") : t("work.progress.closedNext"), at: item.merge?.mergedAt ?? item.updatedAt
  };
  if (item.status === "cancelled") return {
    shortLabel: statusLabel("cancelled"), title: t("work.progress.cancelledTitle"), handler: t("work.role.done"), next: t("work.progress.cancelledNext"), at: item.updatedAt
  };
  if (item.run.userStopped && !item.run.activeTurnId) return {
    shortLabel: t("work.state.userStopped"), title: t("work.progress.stoppedTitle"), handler: t("work.role.you"), next: t("work.progress.stoppedNext"), at: item.updatedAt
  };
  if (item.status === "merging" && integration) return {
    shortLabel: integrationShortStatus(integration, item) ?? t("work.state.awaitingMerge"),
    title: integration.status === "running" ? t("work.progress.mergingTitle") : t("work.progress.acceptedTitle"),
    reason: integrationFailureSummary(integration), handler: integration.agent ? "Agent" : t("work.role.workbench"),
    next: integration.agent ? t("work.progress.agentMergeNext") : integration.status === "decision" ? recoveryCondition(integration) : t("work.progress.workbenchMergeNext"),
    at: integration.updatedAt
  };
  if (item.status === "queued" && unresolvedDependencies.length) return {
    shortLabel: t("work.progress.waitingDependencies"), title: t("work.progress.waitingDependenciesTitle"), handler: t("work.role.workbench"),
    next: t("work.progress.waitingDependenciesNext"), at: item.updatedAt
  };
  if (item.run.lastFailure && !item.run.activeTurnId) return {
    shortLabel: t("work.progress.executionBlocked"), title: readableFailure(item.run.lastFailure).title, reason: undefined,
    handler: t("work.role.you"), next: readableFailure(item.run.lastFailure).next, at: item.updatedAt
  };
  if (item.status === "queued" && rejection && execute && (execute.status === "running" || execute.stage === "execute")) {
    return {
      shortLabel: t("work.progress.returned"), title: t("work.progress.returnedTitle"), reason: rejectionSummary(rejection.reason), handler: t("work.role.currentWorker"),
      next: t("work.progress.returnedNext"), userAction: t("work.progress.noAction"), at: rejection.at
    };
  }
  if (item.status === "queued" && execute?.status === "pending" && (execute.stage === "deliver" || execute.notices.length > 0)) {
    const returned = !!rejection;
    const active = activeRun?.status === "running";
    return {
      shortLabel: returned ? (active ? t("work.progress.returned") : t("work.progress.waitingReschedule")) : t("work.progress.waitingContinue"),
      title: returned ? t("work.progress.returnedTitle") : t("work.progress.waitingWorkerTitle"),
      reason: returned ? rejectionSummary(rejection.reason) : undefined,
      handler: active ? t("work.role.currentWorker") : t("work.role.workbench"),
      next: active ? t("work.progress.returnedNext") : t("work.progress.rescheduleNext"),
      userAction: t("work.progress.noAction"), at: returned ? rejection.at : item.updatedAt
    };
  }
  if (item.status === "queued") return {
    shortLabel: t("work.progress.queued"), title: t("work.progress.queuedTitle"), handler: t("work.role.workbench"), next: t("work.progress.queuedNext"), at: item.updatedAt
  };
  if (item.status === "running") return {
    shortLabel: statusLabel("running"), title: workSessionLabel(item), reason: execute ? actionNote(execute) || undefined : undefined,
    handler: t("work.role.worker"), next: t("work.progress.runningNext"), at: execute?.updatedAt ?? item.updatedAt
  };
  return {
    shortLabel: statusLabel(item.status), title: t("work.progress.preparingTitle"), handler: t("work.role.workbench"), next: t("work.progress.preparingNext"), at: item.updatedAt
  };
};

const eventFromHistory = (entry: { at: string; event: string; message: string }, kind: WorkflowAction["kind"]): WorkItemEvent | undefined => {
  if (entry.event === "created") return { at: entry.at, title: kind === "integration" ? t("work.event.mergeStarted") : t("work.event.workerStarted"), detail: entry.message.split("\n")[0] };
  if (entry.event.startsWith("failed:")) return { at: entry.at, title: kind === "integration" ? t("work.event.mergeCheckFailed") : t("work.event.workerProblem"), detail: rejectionSummary(entry.message) };
  if (entry.event === "resolved") {
    if (kind === "integration" && failedResolution.test(entry.message)) return { at: entry.at, title: t("work.event.mergeCheckFailed"), detail: rejectionSummary(entry.message) };
    const detail = kind === "execute" && handedOffNote.test(entry.message) ? t("work.runNote.handedOff") : entry.message.split("\n")[0];
    return { at: entry.at, title: kind === "integration" ? t("work.event.mergeHandled") : t("work.event.turnEnded"), detail };
  }
  if (["contract.updated", "dependency.updated"].includes(entry.event)) return { at: entry.at, title: t("work.event.contractChanged"), detail: entry.message.split("\n")[0] };
  return undefined;
};

/** Converts durable workflow facts into a compact, chronological progress history. */
export const workItemEvents = (item: WorkItem, actions: WorkflowAction[], runs: AgentRun[]): WorkItemEvent[] => {
  const events: WorkItemEvent[] = [];
  const execute = latestAction(actions, "execute", item.workItemId) as Execution | undefined;
  const integrations = actions.filter((action) => action.workItemId === item.workItemId && action.kind === "integration");
  if (execute) for (const entry of execute.history) {
    const event = eventFromHistory(entry, "execute");
    if (event) events.push(event);
  }
  for (const integration of integrations) for (const entry of integration.history) {
    const event = eventFromHistory(entry, "integration");
    if (event) events.push(event);
  }
  for (const rejection of item.rejections) events.push({ at: rejection.at, title: t("work.progress.returnedTitle"), detail: rejectionSummary(rejection.reason) });
  for (const notice of execute?.notices ?? []) events.push(notice.kind === "rejected"
    ? { at: notice.at, title: t("work.event.returnPending"), detail: t("work.event.returnPendingDetail") }
    : { at: notice.at, title: t("work.event.continuePending"), detail: t("work.event.continuePendingDetail") });
  for (const run of runs.filter((entry) => entry.workItemId === item.workItemId)) {
    events.push({ at: run.startedAt, title: t("work.event.workerStarted"), detail: run.turns ? t("work.event.turns", { count: run.turns }) : undefined });
    if (run.endedAt) events.push({ at: run.endedAt, title: t("work.event.turnEnded"), detail: readableRunNote(run.note) });
  }
  if (execute?.deliveredAt && item.rejections.some((entry) => entry.at <= execute.deliveredAt!)) events.push({ at: execute.deliveredAt, title: t("work.event.returnDelivered"), detail: t("work.event.returnDeliveredDetail") });
  if (item.merge?.mergedAt) events.push({ at: item.merge.mergedAt, title: t("work.event.merged"), detail: item.merge.commit ? t("work.event.mergedDetail", { commit: item.merge.commit.slice(0, 7) }) : undefined });
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.at}|${event.title}|${event.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => right.at.localeCompare(left.at));
};
