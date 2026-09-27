import { useState } from "react";
import type { InboxItem, WorkItem } from "@vermillion/workbench/client";
import { serviceText, t } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { useWorkflowContext } from "../use-workflow-context.js";
import { WorkItemDialog } from "./WorkItemDialog.js";
import { actionStatusText, dispositionSummary, actionRoleLabel } from "./workflow-display.js";
import { IntegrationControls } from "./IntegrationControls.js";
import { statusLabel } from "./task-labels.js";
import { Badge, Button, Card, CollapsibleDetails, EmptyState, Field, InlineNotice, DetailSection, ListRow } from "./ui.js";

type InboxPanelProps = { store: WorkbenchStore; includeProcessed?: boolean };

const labelled = (label: string, value: string) => t("work.labelValue", { label, value });
const verificationLabel = (status: string) => {
  switch (status) {
    case "pass": return t("work.verify.pass");
    case "defect": return t("work.verify.defect");
    case "blocked": return t("work.verify.blocked");
    case "incomplete": return t("work.verify.incomplete");
    default: return t("work.verify.failed");
  }
};

export const InboxPanel = ({ store, includeProcessed = false }: InboxPanelProps) => {
  useT();
  const inbox = store((s) => includeProcessed ? s.inboxHistory : s.inbox);
  const inboxError = store((s) => s.inboxError);
  if (inboxError) {
    return <EmptyState title={t("work.inbox.loadFailed")} hint={inboxError} />;
  }
  if (inbox.length === 0) {
    return <EmptyState title={includeProcessed ? t("work.inbox.noMessages") : t("work.inbox.nothingPending")} hint={t("work.inbox.emptyHint")} />;
  }
  return (
    <ul className="mx-auto w-full max-w-4xl space-y-3 p-4">
      {inbox.map((item) => (
        <li key={item.workspaceId + "/" + (item.kind === "decision" ? item.card.decisionId : item.workItem.workItemId)}>
          {item.kind === "decision" ? <DecisionCard store={store} item={item} /> : item.kind === "integration" ? <IntegrationCard store={store} item={item} /> : <MergedCard store={store} item={item} />}
        </li>
      ))}
    </ul>
  );
};

const DecisionCard = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "decision" }> }) => {
  useT();
  const client = store((s) => s.client);
  const showAgentSession = store((s) => s.showAgentSession);
  const [busy, setBusy] = useState(false);
  const showDetails = store((s) => s.expandedInboxDetails[item.workspaceId + "/" + item.card.decisionId] ?? false);
  const toggleDetails = store((s) => s.toggleInboxDetails);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const { data, error: contextError } = useWorkflowContext(client, item.workspaceId);
  const [detailId, setDetailId] = useState<string>();
  const card = data?.decisions.find((entry) => entry.decisionId === item.card.decisionId) ?? item.card;
  const action = data?.actions.find((entry) => entry.actionId === card.actionId);
  const dispositions = action ? dispositionSummary(action) : [];
  const relatedIds = [...new Set([...(action ? [action.workItemId] : []), ...(card.workItemId ? [card.workItemId] : [])])];
  const sessionId = card.sessionId ?? data?.workItems.find((entry) => entry.workItemId === card.workItemId)?.run.sessionId;
  const answered = !!card.answer;
  const adjustments = card.adjustments ?? [];
  const answer = async (key?: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.request("decision.answer", { workspaceId: item.workspaceId, decisionId: item.card.decisionId,
        key: card.answer?.key ?? key, note: card.answer ? card.answer.note : note.trim() || undefined });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  if (card.withdrawn && !answered) return null;
  return (
    <>
    <Card
      header={
        <>
          <Badge tone="accent">{answered ? t("work.detail.answered") : t("work.inbox.decision")}</Badge>
          {sessionId && <Button size="sm" variant="ghost" outlined className="ml-auto" onClick={() => showAgentSession(item.workspaceId, sessionId)}>{t("work.inbox.enterSession")}</Button>}
        </>
      }
    >
      <p className="text-label font-medium text-strong">{serviceText(card.question)}</p>
      {card.context && <p className="mt-1.5 whitespace-pre-wrap text-body text-muted-foreground">{serviceText(card.context)}</p>}
      {adjustments.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-input px-3 py-2">
          <div className="eyebrow mb-1">{t("work.inbox.adjusted")}</div>
          <ul className="space-y-1">
            {adjustments.map((a) => (
              <li key={a.at} className="whitespace-pre-wrap text-label text-foreground">{a.note}</li>
            ))}
          </ul>
        </div>
      )}
      {!answered && <>
      <ul className="mt-3 space-y-2">
        {card.options.map((option) => {
          const recommended = option.key === card.recommended;
          return (
            <li key={option.key} className="flex items-start gap-3">
              <Button variant={recommended ? "primary" : "secondary"} disabled={busy} className="shrink-0" onClick={() => void answer(option.key)}>
                {serviceText(option.label)}
              </Button>
              <div className="min-w-0 pt-1.5 text-caption text-muted-foreground">
                {option.detail && <span>{option.detail}</span>}
                {recommended && card.recommendation && <span className="block text-caption text-muted-foreground">{labelled(t("work.inbox.recommended"), card.recommendation)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim()) void answer();
        }}
      >
        <Field kind="textarea" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("work.inbox.note")} className="min-w-0 flex-1" />
        <Button type="submit" disabled={busy || !note.trim()} className="shrink-0">{t("work.inbox.answerWithNote")}</Button>
      </form>
      </>}
      {answered && <DetailSection title={t("work.inbox.answerResult")}>
        <p>{[serviceText(card.options.find((option) => option.key === card.answer?.key)?.label), card.answer?.note].filter(Boolean).join(" · ")}</p>
        <p>{card.deliveryPending ? t("work.inbox.answerSaved") : t("work.inbox.answerDelivered")}</p>
        {card.deliveryFailure && <InlineNotice tone="error" className="px-0">{card.deliveryFailure}</InlineNotice>}
        {card.deliveryPending && <Button size="sm" disabled={busy} onClick={() => void answer()}>{t("work.inbox.retryDelivery")}</Button>}
      </DetailSection>}
      {action && <DetailSection title={answered ? t("work.inbox.currentHandling") : t("work.inbox.attemptedHandling")}>
        <p>{actionRoleLabel(action)} · {actionStatusText(action)}</p>
        {dispositions.length ? dispositions.slice(-5).map((summary, index) => <p key={index}>{summary}</p>) : <p>{t("work.inbox.noHandling")}</p>}
      </DetailSection>}
      {relatedIds.length > 0 && <DetailSection title={t("work.inbox.relatedItems")}>{relatedIds.map((id) => {
        const related = data?.workItems.find((entry) => entry.workItemId === id);
        return <ListRow key={id} title={related?.title ?? id} leading={related && <Badge>{related.risk}</Badge>}
          trailing={related && <Badge>{statusLabel(related.status)}</Badge>} onClick={() => setDetailId(id)} />;
      })}</DetailSection>}
      {contextError && <InlineNotice tone="error">{contextError}</InlineNotice>}
      {error && <InlineNotice tone="error" className="mt-3 whitespace-pre-wrap break-words">{error}</InlineNotice>}
      {(card.details || action?.history.length) && (
        <CollapsibleDetails open={showDetails} onToggle={() => toggleDetails(item.workspaceId, card.decisionId)}>{[card.details, action?.history.map((entry) => entry.at + " " + serviceText(entry.message)).join("\n")].filter(Boolean).join("\n\n")}</CollapsibleDetails>
      )}
    </Card>
    {detailId && data && <WorkItemDialog client={client} workspaceId={item.workspaceId} workItemId={detailId} workItems={data.workItems} runs={data.runs} actions={data.actions} onClose={() => setDetailId(undefined)} onOpenSession={(id, turnId) => showAgentSession(item.workspaceId, id, turnId)} />}
    </>
  );
};

const IntegrationCard = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "integration" }> }) => {
  useT();
  const client = store((s) => s.client);
  const showAgentSession = store((s) => s.showAgentSession);
  const showDetails = store((s) => s.expandedInboxDetails[item.workspaceId + "/" + item.workItem.workItemId] ?? false);
  const toggleDetails = store((s) => s.toggleInboxDetails);
  const { data, error: contextError } = useWorkflowContext(client, item.workspaceId);
  const [detailId, setDetailId] = useState<string>();
  const workItem = data?.workItems.find((entry) => entry.workItemId === item.workItem.workItemId) ?? item.workItem;
  const action = data?.actions.find((entry) => entry.actionId === item.action.actionId);
  const currentAction = action?.kind === "integration" ? action : item.action;
  const sessionId = workItem.run.sessionId;
  return <>
    <Card header={<><Badge tone="accent">{t("work.integration.blocked")}</Badge>{sessionId && <Button size="sm" variant="ghost" outlined className="ml-auto" onClick={() => showAgentSession(item.workspaceId, sessionId)}>{t("work.inbox.enterSession")}</Button>}</>}>
      <p className="break-words text-label font-medium text-strong">{workItem.title}</p>
      <IntegrationControls client={client} workspaceId={item.workspaceId} workItemId={workItem.workItemId} action={currentAction} item={workItem} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" outlined onClick={() => setDetailId(workItem.workItemId)}>{t("work.inbox.viewItem")}</Button>
      </div>
      <CollapsibleDetails open={showDetails} onToggle={() => toggleDetails(item.workspaceId, item.workItem.workItemId)}>{currentAction.history.map((entry) => entry.at + " " + serviceText(entry.message)).join("\n")}</CollapsibleDetails>
      {contextError && <InlineNotice tone="error">{contextError}</InlineNotice>}
    </Card>
    {detailId && data && <WorkItemDialog client={client} workspaceId={item.workspaceId} workItemId={detailId} workItems={data.workItems} runs={data.runs} actions={data.actions} onClose={() => setDetailId(undefined)} onOpenSession={(id, turnId) => showAgentSession(item.workspaceId, id, turnId)} />}
  </>;
};

const technicalDetails = (item: WorkItem): string => {
  const { merge, evidence, verify } = item;
  return [
    merge && [t("work.inbox.merge"), "commit: " + (merge.commit ?? t("work.inbox.noCodeChanges")), t("work.inbox.time", { time: merge.mergedAt }), t("work.inbox.diffSummary"), merge.diffStat || t("work.inbox.noFileChanges")].join("\n"),
    evidence && [t("work.inbox.commandOutput"), ...evidence.commands.map((entry) => "$ " + entry.command + "\n" + entry.output)].join("\n\n"),
    [t("work.inbox.reviewHandling"), ...item.review.map((entry) => labelled(entry.decision === "accepted" ? t("work.inbox.reviewAccepted") : t("work.inbox.reviewRejected"), entry.comment)
      + "\n" + labelled(t("work.detail.reason"), entry.reason))].join("\n\n"),
    verify && [t("work.inbox.acceptanceRun", { time: verify.verifiedAt }), ...verify.items.map((entry) => [
      (entry.index + 1) + ". " + (item.acceptance[entry.index]?.text ?? t("work.inbox.acceptanceItem")),
      labelled(verificationLabel(entry.status), entry.evidence)
    ].join("\n"))].join("\n\n"),
    evidence?.assumptions.length && t("work.detail.assumptions") + "\n" + evidence.assumptions.join("\n"),
    evidence?.untested.length && t("work.detail.untested") + "\n" + evidence.untested.join("\n"),
    evidence?.outOfScopeFindings.length && t("work.detail.outOfScopeFindings") + "\n" + evidence.outOfScopeFindings.join("\n"),
    evidence?.attachments.length && t("work.detail.attachments") + "\n" + evidence.attachments.join("\n")
  ].filter(Boolean).join("\n\n");
};

const MergedCard = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "merged" }> }) => {
  useT();
  const client = store((s) => s.client);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [reason, setReason] = useState("");
  const { workItem } = item;
  const showDetails = store((s) => s.expandedInboxDetails[item.workspaceId + "/" + workItem.workItemId] ?? false);
  const toggleDetails = store((s) => s.toggleInboxDetails);
  const showAgentSession = store((s) => s.showAgentSession);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      header={
        <>
          <Badge>{workItem.merge?.acknowledgedAt ? t("work.inbox.handled") : t("work.state.merged")}</Badge>
          <span className="ml-auto truncate text-caption text-muted-foreground">{t("work.inbox.workItem")}</span>
        </>
      }
      footer={
        workItem.merge?.acknowledgedAt ? (
          workItem.run.sessionId && <Button variant="ghost" size="sm" outlined onClick={() => showAgentSession(item.workspaceId, workItem.run.sessionId!)}>{t("work.detail.session")}</Button>
        ) : rollingBack ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim()) return;
              void run(() => client.request("workItem.rollback", { workspaceId: item.workspaceId, workItemId: workItem.workItemId, reason: reason.trim() }));
            }}
          >
            <Field kind="textarea" rows={2} label={t("work.inbox.rollbackReason")} autoFocus disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("work.inbox.rollbackPlaceholder")} className="w-full" />
            <Button variant="primary" type="submit" disabled={busy || !reason.trim()}>{t("work.inbox.confirmRollback")}</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setRollingBack(false)}>{t("common.cancel")}</Button>
          </form>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void run(() => client.request("inbox.acknowledge", { workspaceId: item.workspaceId, workItemId: workItem.workItemId }))}>{t("work.inbox.acknowledge")}</Button>
            {workItem.merge?.commit && <Button disabled={busy} onClick={() => setRollingBack(true)}>{t("work.inbox.rollback")}</Button>}
            {workItem.run.sessionId && <Button variant="ghost" size="sm" outlined className="ml-auto" onClick={() => showAgentSession(item.workspaceId, workItem.run.sessionId!)}>{t("work.detail.session")}</Button>}
          </>
        )
      }
    >
      <p className="break-words text-label font-medium text-strong">{workItem.title}</p>
      {workItem.evidence && (
        <p className="mt-2 whitespace-pre-wrap break-words text-body text-foreground">{workItem.evidence.summary}</p>
      )}
      {workItem.verify && (
        <ul className="mt-3 space-y-1">
          {workItem.verify.items.map((v) => (
            <li key={v.index} className="flex gap-2 text-label">
              <Badge>{verificationLabel(v.status)}</Badge>
              <span className="min-w-0 whitespace-pre-wrap break-words text-muted-foreground">{v.evidence}</span>
            </li>
          ))}
        </ul>
      )}
      <CollapsibleDetails open={showDetails} onToggle={() => toggleDetails(item.workspaceId, workItem.workItemId)}>{technicalDetails(workItem)}</CollapsibleDetails>
      {error && <InlineNotice tone="error" className="mt-3 whitespace-pre-wrap break-words">{error}</InlineNotice>}
    </Card>
  );
};
