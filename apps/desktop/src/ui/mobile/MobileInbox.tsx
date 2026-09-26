import { useEffect, useRef, useState } from "react";
import type { InboxItem, WorkbenchClient, WorkItem } from "@vermillion/workbench/client";
import { Badge, Button, Card, CollapsibleDetails, EmptyState, Field, InlineNotice } from "../app/components/ui.js";
import { technicalDetails } from "../app/components/InboxPanel.js";
import { actionStatusText, integrationFailureSummary } from "../app/components/workflow-display.js";
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
    <Badge status={item.kind === "merged" ? "closed" : item.kind === "integration" ? "decision" : undefined}>{item.kind === "decision" ? "决策" : item.kind === "merged" ? "已合入" : "工作受阻"}</Badge>
    {sessionId && <Button className="ml-auto" variant="ghost" outlined onClick={() => openSession(sessionId)}>进入会话</Button>}
  </>}>
    {item.kind === "decision" ? <>
      {item.card.workItemId && <p className="mb-2 break-words text-caption text-muted-foreground">{related?.title ?? item.card.workItemId}</p>}
      <h2 className="break-words text-title-sm font-medium text-strong">{item.card.question}</h2>
      <p className="mt-2 whitespace-pre-wrap break-words text-body text-muted-foreground">{item.card.context}</p>
      {(item.card.adjustments ?? []).map((adjustment) => <p key={adjustment.at} className="mt-2 whitespace-pre-wrap text-body text-foreground">{adjustment.note}</p>)}
      {item.card.answer ? <div className="mt-4 space-y-2">
        <p className="whitespace-pre-wrap break-words text-body text-foreground">{[
          item.card.options.find((option) => option.key === item.card.answer?.key)?.label,
          item.card.answer.note
        ].filter(Boolean).join(" · ")}</p>
        <p className="text-caption text-muted-foreground">{item.card.deliveryPending ? "答复已登记，等待交付" : "答复已送达"}</p>
        {item.card.deliveryFailure && <InlineNotice tone="error" className="px-0">{item.card.deliveryFailure}</InlineNotice>}
        {item.card.deliveryPending && <Button disabled={busy} onClick={() => void run()}>重试送达</Button>}
      </div> : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (choice || note.trim()) void run(); }}>
        <div role="group" aria-label="决策选项" className="space-y-3">
          {item.card.options.map((option) => <div key={option.key}>
            <Button className="w-full justify-start whitespace-normal text-left" aria-pressed={choice === option.key} disabled={busy}
              variant={choice === option.key ? "primary" : "secondary"} onClick={() => setChoice(choice === option.key ? undefined : option.key)}>{option.label}</Button>
            {option.detail && <p className="mt-1 whitespace-pre-wrap break-words text-caption text-muted-foreground">{option.detail}</p>}
            {option.key === item.card.recommended && item.card.recommendation && <p className="mt-1 whitespace-pre-wrap text-caption text-foreground">推荐：{item.card.recommendation}</p>}
          </div>)}
        </div>
        <Field kind="textarea" label="答复说明" placeholder="也可以直接填写答复" rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" variant="primary" disabled={busy || (!choice && !note.trim())}>{busy ? "正在提交" : "提交答复"}</Button>
      </form>}
      {item.card.details && <CollapsibleDetails open={details} onToggle={() => setDetails(!details)}>{item.card.details}</CollapsibleDetails>}
    </> : <>
      <h2 className="break-words text-title-sm font-medium text-strong">{item.workItem.title}</h2>
      {item.kind === "merged" ? <>
        <p className="mt-2 whitespace-pre-wrap break-words text-body text-foreground">{item.workItem.evidence?.summary}</p>
        <ul className="mt-3 space-y-2">{item.workItem.verify?.items.map((entry) => <li key={entry.index} className="whitespace-pre-wrap break-words text-body text-muted-foreground">{entry.evidence}</li>)}</ul>
        <CollapsibleDetails open={details} onToggle={() => setDetails(!details)}>{technicalDetails(item.workItem)}</CollapsibleDetails>
        <Button className="mt-3" variant="primary" disabled={busy} onClick={() => void run()}>知道了</Button>
      </> : <>
        <p className="mt-2 text-body text-foreground">{actionStatusText(item.action, item.workItem)}</p>
        <p className="mt-2 whitespace-pre-wrap break-words text-body text-muted-foreground">{integrationFailureSummary(item.action) ?? item.action.message}</p>
        <CollapsibleDetails open={details} onToggle={() => setDetails(!details)}>{item.action.history.map((entry) => entry.message).join("\n")}</CollapsibleDetails>
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
  if (error) return <EmptyState title="Inbox 加载失败" hint={error} action={<Button onClick={() => void refresh()}>重试</Button>} />;
  if (loading && !items.length) return <EmptyState title="正在读取 Inbox" />;
  if (!items.length) return <EmptyState title="没有待处理事项" />;
  const missing = route.itemKey && !items.some((item) => item.workspaceId === route.workspaceId && inboxKey(item) === route.itemKey);
  return <div className="min-h-0 flex-1 overflow-auto">
    {missing && <InlineNotice className="pt-3">这条消息已处理或不再需要处理。</InlineNotice>}
    <ul className="space-y-3 p-3">{items.map((item) => <li key={item.workspaceId + "/" + inboxKey(item)}
      ref={item.workspaceId === route.workspaceId && inboxKey(item) === route.itemKey ? selected : undefined}>
      <InboxCard item={item} client={client} refresh={refresh} openSession={openSession} />
    </li>)}</ul>
  </div>;
}
