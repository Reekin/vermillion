import { useState } from "react";
import { ClipboardList } from "lucide-react";
import type { WorkRequest, WorkItem, WorkbenchClient } from "@vermillion/workbench/client";
import { serviceText } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";
import { Button, DetailSection, InlineNotice, OverflowMenu } from "./ui.js";
import { Modal } from "./Modal.js";
import { currentWorkStatus, workPhaseLabel, workSessionLabel } from "./task-labels.js";
import { SupervisorDetails } from "./SupervisorDetails.js";

type Props = {
  client: WorkbenchClient;
  workspaceId: string;
  sourceTitle?: string;
  request?: WorkRequest;
  item?: WorkItem;
  hasDecision?: boolean;
  onOpenWorkItem?: () => void;
  onOpenSession: (sessionId: string) => void;
};

export const CurrentWorkBar = ({ client, workspaceId, sourceTitle, request, item: associatedItem, hasDecision, onOpenWorkItem, onOpenSession }: Props) => {
  const t = useT();
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const item = request && !["ready", "cancelled"].includes(request.status) ? undefined : associatedItem;
  if (!request && !item) return null;
  const title = item?.title || request?.scope?.trim() || sourceTitle || t("work.preparation");
  const state = currentWorkStatus(item, request, hasDecision);
  const reason = serviceText(item?.run.lastFailure ?? request?.failure ?? item?.run.waitReason ?? request?.waitReason);
  const phase = workPhaseLabel(item, request);
  const activity = workSessionLabel(item, request);
  const finished = state.kind === "finished";
  const invoke = async (operation: "pause" | "resume" | "retry" | "cancel") => {
    setBusy(true);
    setError(undefined);
    try {
      if (item) await client.request(`workItem.${operation}`, { workspaceId, workItemId: item.workItemId });
      else if (request) await client.request(`work.${operation}`, { workspaceId, requestId: request.requestId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const pauseLabel = item ? t("work.bar.pauseItem") : t("work.bar.pausePreparation");
  const primary = state.kind === "paused" || state.kind === "stopped" ? { label: t("work.bar.resumeTask"), operation: "resume" as const }
    : state.kind === "interrupted" ? { label: t("work.bar.continue"), operation: "retry" as const }
    : finished ? undefined : { label: pauseLabel, operation: "pause" as const };
  return <>
    <section className="vm-current-work" aria-label={t("work.bar.label")}>
      <div className="vm-current-work__summary">
        <ClipboardList size={16} className="text-muted-foreground" aria-hidden="true" />
        <span className="vm-current-work__title" title={title}>{title}</span>
        <span className="vm-current-work__state" data-state={state.kind}>{phase}</span>
        <span className="text-caption text-muted-foreground">{activity}{state.kind === "paused" ? " · " + t("work.state.paused") : hasDecision ? " · " + t("work.state.awaitingDecision") : ""}</span>
      </div>
      <div className="vm-current-work__actions">
        {primary && <Button size="sm" variant="primary" disabled={busy} onClick={() => void invoke(primary.operation)}>{primary.label}</Button>}
        <Button size="sm" variant="ghost" outlined onClick={() => setDetail(true)}>{t("work.bar.view")}</Button>
        {!finished && <OverflowMenu label={t("work.bar.moreActions")} items={[
          ...(state.kind !== "paused" && primary?.operation !== "pause" ? [{ label: pauseLabel, disabled: busy, onSelect: () => void invoke("pause") }] : []),
          { label: item ? t("work.bar.cancelItem") : t("work.bar.cancelWork"), disabled: busy, onSelect: () => void invoke("cancel") }
        ]} />}
      </div>
    </section>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    {detail && <Modal title={title} width={480} onClose={() => setDetail(false)}>
      <div className="space-y-3 px-4 pb-4">
        <DetailSection title={t("work.bar.phase")}>{phase}</DetailSection>
        <DetailSection title={t("work.bar.activity")}>{activity}</DetailSection>
        <DetailSection title={t("work.bar.status")}>{state.label}</DetailSection>
        {reason && <DetailSection title={t("work.bar.situation")}>{reason}</DetailSection>}
        {request && <SupervisorDetails request={request} client={client} workspaceId={workspaceId} onOpenSession={onOpenSession} />}
        {onOpenWorkItem && item && <Button size="sm" variant="ghost" outlined onClick={() => { setDetail(false); onOpenWorkItem(); }}>{t("work.bar.openItem")}</Button>}
      </div>
    </Modal>}
  </>;
};
