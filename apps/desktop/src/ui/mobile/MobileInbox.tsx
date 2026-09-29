import { useEffect, useRef, useState } from "react";
import type { InboxItem, WorkbenchClient, WorkItem } from "@vermillion/workbench/client";
import { Badge, Button, Card, CollapsibleDetails, EmptyState, Field, InlineNotice } from "../app/components/ui.js";
import { technicalDetails } from "../app/components/InboxPanel.js";
import { actionStatusText, integrationFailureSummary } from "../app/components/workflow-display.js";
import { serviceText, t } from "../../i18n/index.js";
import type { MobileRoute } from "./navigation.js";

export const inboxKey = (item: InboxItem) => item.kind === "decision" ? item.card.decisionId : item.workItem.workItemId;

function InboxCard({ item, client, refresh, openSession }: {
  item: InboxItem; client: WorkbenchClient; refresh: () => Promise<void>; openSession: (id: string) => void;
}) {
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<string>();
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [related, setRelated] = useState<WorkItem>();
  useEffect(() => {
    if (item.kind !== "decision" || !item.card.workItemId) return;
    let active = true;
    void client.request("workItem.get", { workspaceId: item.workspaceId, workItemId: item.card.workItemId })
      .then((value) => { if (active) setRelated(value); })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [client, item.workspaceId, item.kind === "decision" ? item.card.workItemId : undefined]);
  const sessionId = item.kind === "decision" ? item.card.sessionId ?? related?.run.sessionId : item.workItem.run.sessionId;
  const run = async () => {
    setBusy(true); setError(undefined);
    try {
      if (item.kind === "decision") await client.request("decision.answer", {
        workspaceId: item.workspaceId, decisionId: item.card.decisionId,
        key: item.card.answer ? item.card.answer.key : choice,
        note: item.card.answer ? item.card.answer.note : note.trim() || undefined
      });
      else if (item.kind === "merged") await client.request("inbox.acknowledge", { workspaceId: item.workspaceId, workItemId: item.workItem.workItemId });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Card header={<>
    <Badge tone={item.kind === "merged" ? "neutral" : "accent"}>{item.kind === "decision" ? t("work.inbox.decision") : item.kind === "merged" ? t("work.state.merged") : t("work.integration.blocked")}</Badge>
    {sessionId && <Button className="ml-auto" variant="ghost" outlined onClick={() => openSession(sessionId)}>{t("work.inbox.enterSession")}</Button>}
  </>}>
    {item.kind === "decision" ? <>
      {item.card.workItemId && <p className="mb-2 break-words text-caption text-muted-foreground">{related?.title ?? item.card.workItemId}</p>}
      <h2 className="break-words text-title-sm font-medium text-strong">{serviceText(item.card.question)}</h2>
      <p className="mt-2 whitespace-pre-wrap break-words text-body text-muted-foreground">{serviceText(item.card.context)}</p>
      {(item.card.adjustments ?? []).map((adjustment) => <p key={adjustment.at} className="mt-2 whitespace-pre-wrap text-body text-foreground">{adjustment.note}</p>)}
      {item.card.answer ? <div className="mt-4 space-y-2">
        <p className="whitespace-pre-wrap break-words text-body text-foreground">{[
          serviceText(item.card.options.find((option) => option.key === item.card.answer?.key)?.label),
          item.card.answer.note
        ].filter(Boolean).join(" · ")}</p>
        <p className="text-caption text-muted-foreground">{item.card.deliveryPending ? t("work.inbox.answerSaved") : t("work.inbox.answerDelivered")}</p>
        {item.card.deliveryFailure && <InlineNotice tone="error" className="px-0">{serviceText(item.card.deliveryFailure)}</InlineNotice>}
        {item.card.deliveryPending && <Button disabled={busy} onClick={() => void run()}>{t("work.inbox.retryDelivery")}</Button>}
      </div> : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (choice || note.trim()) void run(); }}>
        <div role="group" aria-label={t("mobile.decisionOptions")} className="space-y-3">
          {item.card.options.map((option) => <div key={option.key}>
            <Button className="w-full justify-start whitespace-normal text-left" aria-pressed={choice === option.key} disabled={busy}
              variant={choice === option.key ? "primary" : "secondary"} onClick={() => setChoice(choice === option.key ? undefined : option.key)}>{serviceText(option.label)}</Button>
            {option.detail && <p className="mt-1 whitespace-pre-wrap break-words text-caption text-muted-foreground">{serviceText(option.detail)}</p>}
            {option.key === item.card.recommended && item.card.recommendation && <p className="mt-1 whitespace-pre-wrap text-caption text-foreground">{t("mobile.recommendation", { reason: serviceText(item.card.recommendation) })}</p>}
          </div>)}
        </div>
        <Field kind="textarea" label={t("mobile.answerNote")} placeholder={t("mobile.answerPlaceholder")} rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" variant="primary" disabled={busy || (!choice && !note.trim())}>{busy ? t("mobile.submitting") : t("mobile.submitAnswer")}</Button>
      </form>}
      {item.card.details && <CollapsibleDetails open={details} onToggle={() => setDetails(!details)}>{item.card.details}</CollapsibleDetails>}
    </> : <>
      <h2 className="break-words text-title-sm font-medium text-strong">{item.workItem.title}</h2>
      {item.kind === "merged" ? <>
        <p className="mt-2 whitespace-pre-wrap break-words text-body text-foreground">{item.workItem.evidence?.summary}</p>
        <ul className="mt-3 space-y-2">{item.workItem.verify?.items.map((entry) => <li key={entry.index} className="whitespace-pre-wrap break-words text-body text-muted-foreground">{entry.evidence}</li>)}</ul>
        <CollapsibleDetails open={details} onToggle={() => setDetails(!details)}>{technicalDetails(item.workItem)}</CollapsibleDetails>
        <Button className="mt-3" variant="primary" disabled={busy} onClick={() => void run()}>{t("work.inbox.acknowledge")}</Button>
      </> : <>
        <p className="mt-2 text-body text-foreground">{actionStatusText(item.action, item.workItem)}</p>
        <p className="mt-2 whitespace-pre-wrap break-words text-body text-muted-foreground">{integrationFailureSummary(item.action) ?? serviceText(item.action.message)}</p>
        <CollapsibleDetails open={details} onToggle={() => setDetails(!details)}>{item.action.history.map((entry) => serviceText(entry.message)).join("\n")}</CollapsibleDetails>
      </>}
    </>}
    {error && <InlineNotice tone="error" className="mt-3 px-0 break-words">{error}</InlineNotice>}
  </Card>;
}

export function MobileInbox({ items, error, loading, route, client, refresh, openSession }: {
  items: InboxItem[]; error?: string; loading: boolean; route: Extract<MobileRoute, { page: "inbox" }>;
  client: WorkbenchClient; refresh: () => Promise<void>; openSession: (id: string) => void;
}) {
  const selected = useRef<HTMLLIElement>(null);
  useEffect(() => { selected.current?.scrollIntoView({ block: "start" }); }, [route.workspaceId, route.itemKey, loading]);
  if (error) return <EmptyState title={t("work.inbox.loadFailed")} hint={error} action={<Button onClick={() => void refresh()}>{t("common.retry")}</Button>} />;
  if (loading && !items.length) return <EmptyState title={t("mobile.loadingInbox")} />;
  if (!items.length) return <EmptyState title={t("work.inbox.nothingPending")} />;
  const missing = route.itemKey && !items.some((item) => item.workspaceId === route.workspaceId && inboxKey(item) === route.itemKey);
  return <div className="min-h-0 flex-1 overflow-auto">
    {missing && <InlineNotice className="pt-3">{t("mobile.itemHandled")}</InlineNotice>}
    <ul className="space-y-3 p-3">{items.map((item) => <li key={item.workspaceId + "/" + inboxKey(item)}
      ref={item.workspaceId === route.workspaceId && inboxKey(item) === route.itemKey ? selected : undefined}>
      <InboxCard item={item} client={client} refresh={refresh} openSession={openSession} />
    </li>)}</ul>
  </div>;
}
