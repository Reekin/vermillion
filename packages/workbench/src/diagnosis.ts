import { z } from "zod";
import { actionNote, effectiveNeeds, actionIsOpen, isUserPaused, zWorkflowAction, zScheduler, zWorkItem, zDecisionCard, type WorkflowAction } from "./contracts.js";
import { text, zServiceText, type ServiceText } from "./service-text.js";
import type { WorkbenchService } from "./workbench-service.js";

export const zDiagnosis = z.object({
  workItemId: z.string(), phase: zWorkItem.shape.status,
  sessionId: z.string().optional(),
  actions: z.array(zWorkflowAction),
  blockers: z.array(z.object({ reason: zServiceText, role: z.string(), sessionId: z.string().optional(), actionId: z.string().optional(), next: zServiceText })),
  dependencies: z.array(z.object({ workItemId: z.string(), status: z.string() })),
  decisions: z.array(zDecisionCard),
  scheduler: zScheduler.extend({ online: z.boolean(), running: z.number() }),
  resources: z.array(z.object({ name: z.string(), workItemId: z.string(), sessionId: z.string().optional() })),
  invalidRefs: z.array(z.object({ path: z.string(), section: z.string().optional(), commit: z.string(), reason: z.string() })),
  lastFailure: zWorkflowAction.optional(),
  waiting: z.array(zServiceText), availableActions: z.array(z.object({ method: z.string(), condition: zServiceText }))
});

const nextFor = (action: WorkflowAction): ServiceText => {
  if (action.kind === "integration" && action.agent) return text("next.workerMerge");
  if (isUserPaused(action)) return text("next.awaitResume");
  if (action.status === "decision") return text("next.decide");
  return text("next.proceed");
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
      reason: isUserPaused(action) ? text("diagnosis.userPaused") : action.failure ?? actionNote(action),
      role: action.kind === "execute" ? "worker" : "workbench",
      sessionId: action.kind === "execute" ? action.sessionId : undefined,
      actionId: action.actionId, next: nextFor(action)
    }));
  for (const dependency of dependencies.filter((d) => d.status !== "closed"))
    blockers.push({ reason: text("diagnosis.dependency", dependency), role: dependency.status === "cancelled" ? "worker" : "workbench",
      next: dependency.status === "cancelled" ? text("next.adjustDependency") : text("next.awaitDependency") });
  for (const card of decisions) blockers.push({ reason: card.question, role: "user", sessionId: card.sessionId, actionId: card.actionId, next: text("next.answerDecision") });
  const occupancy = await service.getExecutionOccupancy(workspaceId);
  const running = occupancy.workItems.filter((i) => i.workItemId !== workItemId);
  const resources = running.flatMap((i) => effectiveNeeds(i).filter((n) => effectiveNeeds(item).includes(n)).map((name) => ({ name, workItemId: i.workItemId, sessionId: i.run.sessionId })));
  const waiting = blockers.map((b) => b.reason);
  if (item.run.turnStatus === "unknown") waiting.push(text("waiting.turnUnknown"));
  if (item.status === "preparing") waiting.push(text("waiting.preparing"));
  const unfinished = !["closed", "cancelled"].includes(item.status) || actions.length > 0;
  if (unfinished) {
    if (!online) waiting.push(text("waiting.offline"));
    else if (!scheduler.enabled) waiting.push(text("waiting.schedulerOff"));
    if (item.status === "queued") {
      const occupied = occupancy.sessionIds.filter((sessionId) => sessionId !== item.run.sessionId).length;
      if (occupied >= scheduler.maxWorkers) waiting.push(text("waiting.concurrency", { occupied, max: scheduler.maxWorkers }));
      if (resources.length) waiting.push(text("waiting.resources", { names: resources.map((r) => r.name).join(", ") }));
      if (!waiting.length) waiting.push(text("waiting.scheduler"));
    }
  }
  const availableActions = [{ method: "workItem.diagnose", condition: text("condition.diagnoseItem") }];
  if (item.run.pendingMessageId) waiting.push(text("waiting.dispatchUnconfirmed"));
  if (decisions.length) availableActions.push({ method: "decision.answer", condition: text("condition.answerDecision") });
  if (item.run.paused) availableActions.push({ method: "workItem.resume", condition: text("condition.resumeItem") });
  if (!item.run.activeTurnId && !item.run.paused && !["closed", "cancelled"].includes(item.status)) availableActions.push({ method: "workItem.retry", condition: text("condition.retryItem") });
  if (!["closed", "cancelled"].includes(item.status)) availableActions.push({ method: "workItem.update", condition: text("condition.updateItem") }, { method: "workItem.cancel", condition: text("condition.cancelItem") });
  const integration = related.find((action): action is Extract<WorkflowAction, { kind: "integration" }> => action.kind === "integration" && action.stage === "merge" && actionIsOpen(action));
  if (integration && !integration.agent && integration.status === "decision") {
    availableActions.push({ method: "workItem.merge.retry", condition: text("condition.retryMerge") }, { method: "workItem.merge.takeover", condition: text("condition.takeoverMerge") });
  }
  for (const ref of invalidRefs) waiting.push(text("waiting.invalidRef", { ref: ref.path + (ref.section ? "#" + ref.section : ""), reason: ref.reason }));
  return { workItemId, phase: item.status, sessionId: item.run.sessionId, actions, blockers, dependencies, decisions, invalidRefs,
    scheduler: { ...scheduler, online, running: occupancy.sessionIds.length }, resources, waiting, availableActions,
    lastFailure: related.filter((a) => a.failure).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] };
}
