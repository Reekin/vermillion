import { useState, type FormEvent } from "react";
import type { WorkbenchClient, WorkflowAction, WorkItem } from "@vermillion/workbench/client";
import { useT } from "../../../i18n/react.js";
import { actionStatusText, integrationFailureSummary } from "./workflow-display.js";
import { Badge, Button, Field, InlineNotice, OverflowMenu } from "./ui.js";

type IntegrationAction = Extract<WorkflowAction, { kind: "integration" }>;

export const IntegrationControls = ({ client, workspaceId, workItemId, action, item, showStatus = true }: {
  client: WorkbenchClient;
  workspaceId: string;
  workItemId: string;
  action?: IntegrationAction;
  item?: WorkItem;
  showStatus?: boolean;
}) => {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  if (!action || action.stage !== "merge" || action.status === "done" || action.status === "cancelled") return null;

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await task(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const canAct = !action.agent && action.status === "decision";
  const retry = () => void run(() => client.request("workItem.integration.retry", { workspaceId, workItemId }));
  const takeover = (event: FormEvent) => {
    event.preventDefault();
    void run(() => client.request("workItem.integration.takeover", { workspaceId, workItemId, note: note.trim() || undefined }));
  };
  return <div className="mt-3 space-y-2 border-t border-border pt-3">
    {showStatus && <div className="flex flex-wrap items-center gap-2">
      <Badge>{actionStatusText(action, item)}</Badge>
    </div>}
    {integrationFailureSummary(action) && <InlineNotice tone="error" className="px-0">{t("work.labelValue", { label: t("work.merge.lastFailure"), value: integrationFailureSummary(action)! })}</InlineNotice>}
    {action.status === "decision" && <p className="text-caption text-muted-foreground">{t("work.merge.blockedHint")}</p>}
    {action.agent && item?.run.lastFailure && <InlineNotice tone="error" className="px-0">{t("work.labelValue", { label: t("work.merge.executionFailed"), value: item.run.lastFailure })}</InlineNotice>}
    {action.agent && <p className="whitespace-pre-wrap text-caption text-muted-foreground">{action.agent.note ? t("work.labelValue", { label: t("work.merge.userNote"), value: action.agent.note }) : t("work.merge.workerWillHandle")}</p>}
    {canAct && !takeoverOpen && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={retry}>{t("work.merge.retryNow")}</Button>
      <Button size="sm" disabled={busy} onClick={() => setTakeoverOpen(true)}>{t("work.merge.handToAgent")}</Button>
      <OverflowMenu label={t("work.merge.moreActions")} items={[{ label: t("work.board.cancelItem"), disabled: busy, onSelect: () => void run(() => client.request("workItem.cancel", { workspaceId, workItemId })) }]} />
    </div>}
    {canAct && takeoverOpen && <form className="space-y-2" onSubmit={takeover}>
      <Field kind="textarea" label={t("work.merge.agentNote")} rows={2} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} autoFocus />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={busy}>{t("work.merge.confirmHandToAgent")}</Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setTakeoverOpen(false)}>{t("common.cancel")}</Button>
      </div>
    </form>}
    {error && <InlineNotice tone="error" className="px-0 whitespace-pre-wrap">{error}</InlineNotice>}
  </div>;
};
