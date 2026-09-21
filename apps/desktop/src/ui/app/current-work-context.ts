import type { DecisionCard, WorkflowAction, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { isOpenWorkItem, isPreparingWork } from "./components/work-board-display.js";

type WorkContext = { item?: WorkItem; request?: WorkRequest; transferredSessionId?: string };

/** Current ownership takes precedence over transfer history and completed results. */
export function currentWorkContext(items: readonly WorkItem[], requests: readonly WorkRequest[], sessionId?: string): WorkContext {
  if (!sessionId) return {};
  const item = items.find((entry) => entry.run.sessionId === sessionId && isOpenWorkItem(entry));
  const request = requests.find((entry) => entry.workerSessionId === sessionId && isPreparingWork(entry));
  if (request || item) return { request, item };
  const movedItem = items.filter((entry) => entry.run.migratedFromSessionId === sessionId).at(-1);
  const movedRequest = requests.filter((entry) => entry.migratedFromSessionId === sessionId).at(-1);
  const transferredSessionId = movedItem?.run.sessionId ?? movedRequest?.workerSessionId;
  if (transferredSessionId) return { transferredSessionId };
  const finishedItem = items.filter((entry) => entry.run.sessionId === sessionId).at(-1);
  if (finishedItem) return { item: finishedItem };
  return { request: requests.filter((entry) => entry.workerSessionId === sessionId).at(-1) };
}

/** Decision authorship remains historical; the owning work determines the reply destination. */
export function decisionsForWork(cards: readonly DecisionCard[], actions: readonly WorkflowAction[], context: WorkContext, sessionId?: string): DecisionCard[] {
  if (!sessionId || context.transferredSessionId) return [];
  if (context.item && !isOpenWorkItem(context.item)) return [];
  if (!context.item && context.request && !isPreparingWork(context.request)) return [];
  return cards.filter((card) => {
    if (card.answer || card.withdrawn) return false;
    const itemId = card.workItemId ?? actions.find((action) => action.actionId === card.actionId)?.workItemId;
    if (itemId) return itemId === context.item?.workItemId;
    if (card.requestId) return Boolean(context.request && card.requestId === context.request.requestId && isPreparingWork(context.request));
    return card.sessionId === sessionId;
  });
}
