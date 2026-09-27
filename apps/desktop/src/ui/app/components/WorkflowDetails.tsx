import { actionNote, isUserPaused, type WorkflowAction, type WorkItem } from "@vermillion/workbench/client";
import { formatDateTime } from "../../../i18n/format.js";
import { serviceText } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";
import { Badge, Button, DetailSection } from "./ui.js";
import { actionKindLabel, actionStatusText, recoveryCondition, actionRoleLabel } from "./workflow-display.js";

export const WorkflowDetails = ({ actions, item, onOpenSession }: { actions: WorkflowAction[]; item: WorkItem; onOpenSession: (id: string) => void }) => {
  const t = useT();
  return <>
  {actions.map((action) => <DetailSection key={action.actionId} title={actionKindLabel(action.kind)}>
    <div className="flex flex-wrap items-center gap-2">
      {!isUserPaused(action) && <Badge>{actionStatusText(action, item)}</Badge>}<span>{actionRoleLabel(action)}</span>
      {action.kind === "execute" && action.sessionId && <Button variant="ghost" outlined size="sm" onClick={() => onOpenSession(action.sessionId!)}>{t("work.flow.session")}</Button>}
    </div>
    <DetailSection title={t("work.flow.problem")}>{serviceText(actionNote(action))}</DetailSection>
    {action.status !== "done" && action.status !== "cancelled" && !(action.kind === "integration" && action.agent) && <>
      <DetailSection title={t("work.flow.waitingOn")}>{recoveryCondition(action)}</DetailSection>
    </>}
    {!isUserPaused(action) && <DetailSection title={t("work.flow.latest")}>{serviceText(action.history.at(-1)?.message) ?? t("work.flow.awaitingHandler")}</DetailSection>}
    {!isUserPaused(action) && action.history.length > 0 && <DetailSection title={t("work.flow.history")}>{action.history.map((entry, index) => <div key={index} className="mb-2">
      <span className="font-mono text-caption text-muted-foreground">{formatDateTime(entry.at)}</span>
      <p>{serviceText(entry.message)}</p>
    </div>)}</DetailSection>}
  </DetailSection>)}
  </>;
};
