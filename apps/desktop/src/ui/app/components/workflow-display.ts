import { actionIsOpen, actionNote, isUserPaused, type AgentRun, type Execution, type WorkflowAction, type WorkItem } from "@vermillion/workbench/client";
import { statusLabel } from "./task-labels.js";

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
  if (/Worker must commit its worktree/i.test(reason)) return "Worker worktree 仍有未提交修改。";
  if (/outside repository/i.test(reason)) return "交付路径包含仓库外文件，无法进行 Git 合入。";
  if (/conflict/i.test(reason)) return "合入发生冲突，需要处理后继续。";
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
};

const matchingRun = (item: WorkItem, run?: AgentRun) => run && (!item.run.sessionId || run.sessionId === item.run.sessionId) ? run : undefined;

/** One deterministic user-facing explanation shared by the board row and the detail panel. */
export const workItemProgress = (item: WorkItem, actions: WorkflowAction[], run?: AgentRun, unresolvedDependencies: string[] = item.dependsOn): WorkItemProgress => {
  const execute = latestAction(actions, "execute", item.workItemId) as Execution | undefined;
  const integration = latestAction(actions, "integration", item.workItemId) as Extract<WorkflowAction, { kind: "integration" }> | undefined;
  const rejection = item.rejections.at(-1);
  const activeRun = matchingRun(item, run);

  if (item.run.pauseReason === "user") return {
    shortLabel: "用户暂停", title: "等待你恢复执行", handler: "你", next: "恢复后，Worker 从原会话继续执行。", userAction: "点击“恢复执行”。", at: item.updatedAt
  };
  if (item.status === "closed") return {
    shortLabel: "已关闭", title: "工单已合入并关闭", reason: [
      item.evidence?.summary,
      item.merge?.commit ? "合入 commit：" + item.merge.commit : undefined,
      item.verify ? "验收：" + item.verify.items.filter((entry) => entry.status === "pass").length + " / " + item.acceptance.length + " 通过" : undefined
    ].filter(Boolean).join(" · ") || undefined,
    handler: "已完成", next: item.merge?.commit ? "可查看合入 commit 和历史进展。" : "可查看验收结果和历史进展。", at: item.merge?.mergedAt ?? item.updatedAt
  };
  if (item.status === "cancelled") return {
    shortLabel: "已取消", title: "工单已取消", handler: "已完成", next: "保留已有记录，可查看取消前的进展。", at: item.updatedAt
  };
  if (item.status === "decision") return {
    shortLabel: "等待用户", title: "等待你的决定", reason: item.run.lastFailure ? rejectionSummary(item.run.lastFailure) : undefined,
    handler: "你", next: "答复决策后，当前处理者会从未完成的动作继续。", userAction: "在 Inbox 回复决策。", at: item.updatedAt
  };
  if (item.status === "merging" && integration) return {
    shortLabel: integrationShortStatus(integration, item) ?? "等待合入",
    title: integration.status === "running" ? "工作台正在合入成果" : "验收已通过，等待合入",
    reason: integrationFailureSummary(integration), handler: integration.agent ? "Agent" : "工作台",
    next: integration.agent ? "Agent 处理合入后登记结果。" : integration.status === "retry" ? recoveryCondition(integration) : "工作台完成合入检查并更新结果。",
    at: integration.updatedAt
  };
  if (item.status === "queued" && unresolvedDependencies.length) return {
    shortLabel: "等待前置工单", title: "等待前置工单完成", handler: "工作台",
    next: "全部前置工单关闭后，调度器会继续安排本单。", at: item.updatedAt
  };
  if (item.status === "queued" && execute?.status === "retry") return {
    shortLabel: "等待重试", title: "执行失败，等待自动重试", reason: execute.failure ? rejectionSummary(execute.failure) : undefined,
    handler: "工作台", next: recoveryCondition(execute), at: execute.retryAt ?? execute.updatedAt
  };
  if (item.status === "queued" && execute?.status === "decision") return {
    shortLabel: "等待用户", title: "执行恢复需要你的决定", reason: execute.failure ? rejectionSummary(execute.failure) : undefined,
    handler: "你", next: recoveryCondition(execute), userAction: "在 Inbox 回复决策。", at: execute.updatedAt
  };
  if (item.status === "queued" && rejection && execute && (execute.status === "running" || execute.stage === "execute")) {
    return {
      shortLabel: "退回待续做", title: "提交已退回", reason: rejectionSummary(rejection.reason), handler: "当前 Worker 会话",
      next: "当前 turn 结束后，工作台会把处理说明送回 Worker。", userAction: "无需操作。", at: rejection.at
    };
  }
  if (item.status === "queued" && execute?.status === "pending" && (execute.stage === "deliver" || execute.notices.length > 0)) {
    const returned = !!rejection;
    const active = activeRun?.status === "running";
    return {
      shortLabel: returned ? (active ? "退回待续做" : "等待调度续接") : "等待续做",
      title: returned ? "提交已退回" : "等待 Worker 续做",
      reason: returned ? rejectionSummary(rejection.reason) : undefined,
      handler: active ? "当前 Worker 会话" : "工作台",
      next: active ? "当前 turn 结束后，工作台会把处理说明送回 Worker。" : "调度器会恢复原 Worker 会话并送达处理说明。",
      userAction: "无需操作。", at: returned ? rejection.at : item.updatedAt
    };
  }
  if (item.status === "queued") return {
    shortLabel: "排队中", title: "等待调度", handler: "工作台", next: "满足调度条件后，工作台会安排 Worker 执行。", at: item.updatedAt
  };
  if (item.status === "running") return {
    shortLabel: "进行中", title: "Worker 正在执行", reason: execute ? actionNote(execute) || undefined : undefined,
    handler: "Worker", next: "Worker 完成实现、检查和验收后提交成果。", at: execute?.updatedAt ?? item.updatedAt
  };
  return {
    shortLabel: statusLabel[item.status], title: "工单正在准备", handler: "工作台", next: "准备完成后进入调度队列。", at: item.updatedAt
  };
};

const eventFromHistory = (entry: { at: string; event: string; message: string }, kind: WorkflowAction["kind"]): WorkItemEvent | undefined => {
  if (entry.event === "created") return { at: entry.at, title: kind === "integration" ? "提交验收通过，开始合入" : "Worker 开始执行", detail: entry.message.split("\n")[0] };
  if (entry.event.startsWith("failed:")) return { at: entry.at, title: kind === "integration" ? "合入检查未通过" : "Worker 执行遇到问题", detail: rejectionSummary(entry.message) };
  if (entry.event === "resolved") {
    if (kind === "integration" && /转回原 Worker|冲突|失败|未通过/i.test(entry.message)) return { at: entry.at, title: "合入检查未通过", detail: rejectionSummary(entry.message) };
    return { at: entry.at, title: kind === "integration" ? "合入处置完成" : "本轮执行结束", detail: entry.message.split("\n")[0] };
  }
  if (["contract.updated", "dependency.updated"].includes(entry.event)) return { at: entry.at, title: "合同或依赖已调整", detail: entry.message.split("\n")[0] };
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
  for (const rejection of item.rejections) events.push({ at: rejection.at, title: "提交已退回", detail: rejectionSummary(rejection.reason) });
  for (const notice of execute?.notices ?? []) events.push({ at: notice.at, title: notice.kind === "rejected" ? "退回说明等待送达" : "续做消息等待送达", detail: notice.kind === "rejected" ? "退回原因已记录，等待交给 Worker。" : "续做说明已记录，等待送达。" });
  for (const run of runs.filter((entry) => entry.workItemId === item.workItemId)) {
    events.push({ at: run.startedAt, title: "Worker 开始执行", detail: run.turns ? `${run.turns} 个 turn` : undefined });
    if (run.endedAt) events.push({ at: run.endedAt, title: "本轮执行结束", detail: run.note });
  }
  if (execute?.deliveredAt && item.rejections.some((entry) => entry.at <= execute.deliveredAt!)) events.push({ at: execute.deliveredAt, title: "退回后的执行消息已送达", detail: "Worker 已收到处理说明。" });
  if (item.merge?.mergedAt) events.push({ at: item.merge.mergedAt, title: "合入完成", detail: item.merge.commit ? `成果已进入主分支 · ${item.merge.commit.slice(0, 8)}` : undefined });
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.at}|${event.title}|${event.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => right.at.localeCompare(left.at));
};
