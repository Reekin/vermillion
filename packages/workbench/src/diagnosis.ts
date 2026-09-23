import { z } from "zod";
import { actionNote, effectiveNeeds, actionIsOpen, isUserPaused, zWorkflowAction, zScheduler, zWorkItem, zDecisionCard, type WorkflowAction } from "./contracts.js";
import type { WorkbenchService } from "./workbench-service.js";

export const zDiagnosis = z.object({
  workItemId: z.string(), phase: zWorkItem.shape.status,
  sessionId: z.string().optional(),
  actions: z.array(zWorkflowAction),
  blockers: z.array(z.object({ reason: z.string(), role: z.string(), sessionId: z.string().optional(), actionId: z.string().optional(), next: z.string() })),
  dependencies: z.array(z.object({ workItemId: z.string(), status: z.string() })),
  decisions: z.array(zDecisionCard),
  scheduler: zScheduler.extend({ online: z.boolean(), running: z.number() }),
  resources: z.array(z.object({ name: z.string(), workItemId: z.string(), sessionId: z.string().optional() })),
  invalidRefs: z.array(z.object({ path: z.string(), section: z.string().optional(), commit: z.string(), reason: z.string() })),
  lastFailure: zWorkflowAction.optional(),
  waiting: z.array(z.string()), availableActions: z.array(z.object({ method: z.string(), condition: z.string() }))
});

const nextFor = (action: WorkflowAction): string => {
  if (action.kind === "integration" && action.agent) return "原 Worker 处理合入，通过业务入口登记结果。";
  if (isUserPaused(action)) return "等待用户明确恢复。";
  if (action.status === "decision") return "核对阻塞原因后，由用户或监工明确处置。";
  return "按当前业务条件推进。";
};

/** Read-only projection of the same persisted actions used by the scheduler. */
export async function diagnose(service: WorkbenchService, workspaceId: string, workItemId: string, online: boolean): Promise<z.infer<typeof zDiagnosis>> {
  const item = await service.getWorkItem(workspaceId, workItemId);
  const [items, allActions, cards, scheduler, invalidRefs] = await Promise.all([
    service.listWorkItems(workspaceId), service.listActions(workspaceId),
    service.listDecisions(workspaceId), service.getScheduler(workspaceId), service.invalidWorkItemRefs(workspaceId, workItemId)
  ]);
  const related = allActions.filter((a) => a.workItemId === workItemId);
  const actions = related.filter(actionIsOpen);
  const decisions = cards.filter((c) => !c.answer && !c.withdrawn && (c.workItemId === workItemId || actions.some((a) => a.actionId === c.actionId)));
  const dependencies = item.dependsOn.map((id) => ({ workItemId: id, status: items.find((i) => i.workItemId === id)?.status ?? "missing" }));
  const blockers: z.infer<typeof zDiagnosis>["blockers"] = actions
    .filter((action) => action.kind === "integration" || action.status === "decision" || isUserPaused(action))
    .map((action) => ({
      reason: isUserPaused(action) ? "用户已暂停" : action.failure ?? actionNote(action),
      role: action.kind === "execute" ? "worker" : "workbench",
      sessionId: action.kind === "execute" ? action.sessionId : undefined,
      actionId: action.actionId, next: nextFor(action)
    }));
  for (const dependency of dependencies.filter((d) => d.status !== "closed"))
    blockers.push({ reason: `前置 ${dependency.workItemId}: ${dependency.status}`, role: dependency.status === "cancelled" ? "worker" : "workbench", next: dependency.status === "cancelled" ? "用户调整依赖或取消。" : "等待前置关闭。" });
  for (const card of decisions) blockers.push({ reason: card.question, role: "user", sessionId: card.sessionId, actionId: card.actionId, next: "用户答复 decision.answer。" });
  const occupancy = await service.getExecutionOccupancy(workspaceId);
  const running = occupancy.workItems.filter((i) => i.workItemId !== workItemId);
  const resources = running.flatMap((i) => effectiveNeeds(i).filter((n) => effectiveNeeds(item).includes(n)).map((name) => ({ name, workItemId: i.workItemId, sessionId: i.run.sessionId })));
  const waiting = blockers.map((b) => b.reason);
  if (item.run.turnStatus === "unknown") waiting.push("执行轮次状态等待确认");
  if (item.status === "preparing") waiting.push("等待开工准备轮完成工单与执行目录登记。");
  const unfinished = !["closed", "cancelled"].includes(item.status) || actions.length > 0;
  if (unfinished) {
    if (!online) waiting.push("桌面调度器不在线，等待启动；保存的记录尚未派发。");
    else if (!scheduler.enabled) waiting.push("调度开关关闭，等待启用。");
    if (item.status === "queued") {
      const occupied = occupancy.sessionIds.filter((sessionId) => sessionId !== item.run.sessionId).length;
      if (occupied >= scheduler.maxWorkers) waiting.push(`等待 Worker 并发空位（${occupied}/${scheduler.maxWorkers}）。`);
      if (resources.length) waiting.push("等待共享资源释放：" + resources.map((r) => r.name).join("、"));
      if (!waiting.length) waiting.push("等待调度器接手排队动作。");
    }
  }
  const availableActions = [{ method: "workItem.diagnose", condition: "随时查询当前状态。" }];
  if (item.run.pendingMessageId) waiting.push("业务派发受理状态未确认；继续操作将先核对原回执。");
  if (decisions.length) availableActions.push({ method: "decision.answer", condition: "获得用户实际答复后选择重试、取消或给出具体说明。" });
  if (item.run.paused) availableActions.push({ method: "workItem.resume", condition: "确认继续执行时，从原会话恢复。" });
  if (!item.run.activeTurnId && !item.run.paused && !["closed", "cancelled"].includes(item.status)) availableActions.push({ method: "workItem.retry", condition: "检查当前条件后明确继续原 Worker。" });
  if (!["closed", "cancelled"].includes(item.status)) availableActions.push({ method: "workItem.update", condition: "调整合同或 dependsOn；并在 note 说明修改。" }, { method: "workItem.cancel", condition: "取消当前工作。" });
  const integration = related.find((action): action is Extract<WorkflowAction, { kind: "integration" }> => action.kind === "integration" && action.stage === "merge" && actionIsOpen(action));
  if (integration && !integration.agent && integration.status === "decision") {
    availableActions.push({ method: "workItem.integration.retry", condition: "立即重试当前合入。" }, { method: "workItem.integration.takeover", condition: "附说明交给原 Worker 处理合入。" });
  }
  for (const ref of invalidRefs) waiting.push(`引用定位失效：${ref.path}${ref.section ? "#" + ref.section : ""}（${ref.reason}）`);
  return { workItemId, phase: item.status, sessionId: item.run.sessionId, actions, blockers, dependencies, decisions, invalidRefs,
    scheduler: { ...scheduler, online, running: occupancy.sessionIds.length }, resources, waiting, availableActions,
    lastFailure: related.filter((a) => a.failure).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] };
}
