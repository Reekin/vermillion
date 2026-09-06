import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { InboxItem } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, Card, EmptyState, Field, InlineNotice } from "./ui.js";

type InboxPanelProps = { store: WorkbenchStore };

export const InboxPanel = ({ store }: InboxPanelProps) => {
  const inbox = store((s) => s.inbox);
  const inboxError = store((s) => s.inboxError);
  if (inboxError) {
    return <EmptyState title="Inbox 加载失败" hint={inboxError} />;
  }
  if (inbox.length === 0) {
    return <EmptyState title="没有待处理事项" hint="决策卡和待验收的工单会出现在这里。" />;
  }
  return (
    <ul className="space-y-3 p-4">
      {inbox.map((item) => (
        <li key={item.kind === "decision" ? item.card.decisionId : item.workItem.workItemId}>
          {item.kind === "decision" ? <DecisionCard store={store} item={item} /> : <ReviewCard store={store} item={item} />}
        </li>
      ))}
    </ul>
  );
};

const DecisionCard = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "decision" }> }) => {
  const client = store((s) => s.client);
  const showAgentSession = store((s) => s.showAgentSession);
  const [busy, setBusy] = useState(false);
  const showDetails = store((s) => s.expandedInboxDetails[item.workspaceId + "/" + item.card.decisionId] ?? false);
  const toggleDetails = store((s) => s.toggleInboxDetails);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const missionTitle = store((s) => s.view?.workspaceId === item.workspaceId ? s.view.missions.find((m) => m.missionId === item.card.missionId)?.title : undefined);
  const { card } = item;
  const answer = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.request("decision.answer", { workspaceId: item.workspaceId, decisionId: item.card.decisionId, key, note: note.trim() || undefined });
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
          <Badge tone="accent">决策</Badge>
          {missionTitle && <span className="truncate text-caption text-muted-foreground">{missionTitle}</span>}
          {card.sessionId && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => showAgentSession(item.workspaceId, card.sessionId!)}>进入会话</Button>}
        </>
      }
    >
      <p className="text-title-sm font-medium text-strong">{card.question}</p>
      {card.context && <p className="mt-1.5 whitespace-pre-wrap text-body text-muted-foreground">{card.context}</p>}
      <Field value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注（可选，随选项一起送达）" className="mt-3" />
      <ul className="mt-3 space-y-2">
        {card.options.map((option) => {
          const recommended = option.key === card.recommended;
          return (
            <li key={option.key} className="flex items-start gap-3">
              <Button variant={recommended ? "primary" : "secondary"} disabled={busy} className="shrink-0" onClick={() => void answer(option.key)}>
                {option.label}
              </Button>
              <div className="min-w-0 pt-1.5 text-label text-muted-foreground">
                {option.detail && <span>{option.detail}</span>}
                {recommended && card.recommendation && <span className="block text-caption text-faint-foreground">推荐：{card.recommendation}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <InlineNotice tone="error" className="mt-3 whitespace-pre-wrap break-words">{error}</InlineNotice>}
      {card.details && (
        <div className="mt-3">
          <button type="button" className="flex items-center gap-1 text-caption text-muted-foreground hover:text-strong" onClick={() => toggleDetails(item.workspaceId, card.decisionId)}>
            {showDetails ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            技术详情
          </button>
          {showDetails && <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-input px-3 py-2 font-mono text-caption leading-relaxed text-muted-foreground">{card.details}</pre>}
        </div>
      )}
    </Card>
  );
};

const ReviewCard = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "review" }> }) => {
  const client = store((s) => s.client);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { workItem } = item;
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
  const rejected = workItem.review.filter((r) => r.decision === "rejected");
  return (
    <Card
      header={
        <>
          <Badge tone="accent">验收</Badge>
          <Badge>{workItem.risk}</Badge>
          {workItem.rejections.length > 0 && <Badge>第 {workItem.rejections.length + 1} 轮</Badge>}
          <span className="ml-auto truncate text-caption text-muted-foreground">{item.mission ? "任务：" + item.mission.title : "独立工单"}</span>
        </>
      }
      footer={
        rejecting ? (
          <form
            className="flex flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim()) return;
              void run(() => client.request("workItem.reject", { workspaceId: item.workspaceId, workItemId: workItem.workItemId, reason: reason.trim() }));
            }}
          >
            <Field autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="打回原因（会写进工单）" className="min-w-0 flex-1" />
            <Button variant="primary" type="submit" disabled={busy || !reason.trim()}>确认打回</Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>取消</Button>
          </form>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void run(() => client.request("workItem.approve", { workspaceId: item.workspaceId, workItemId: workItem.workItemId }))}>通过</Button>
            <Button disabled={busy} onClick={() => setRejecting(true)}>打回</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => client.request("workItem.cancel", { workspaceId: item.workspaceId, workItemId: workItem.workItemId }))}>不做</Button>
          </>
        )
      }
    >
      <p className="text-title-sm font-medium text-strong">{workItem.title}</p>
      {workItem.evidence && (
        <div className="mt-3 rounded-md border border-border bg-input px-3 py-2">
          <div className="eyebrow mb-1">证据</div>
          <p className="whitespace-pre-wrap text-label text-foreground">{workItem.evidence.summary}</p>
          {workItem.evidence.assumptions.length > 0 && <p className="mt-1 text-caption text-muted-foreground">假设：{workItem.evidence.assumptions.join("；")}</p>}
          {workItem.evidence.untested.length > 0 && <p className="mt-1 text-caption text-muted-foreground">未测：{workItem.evidence.untested.join("；")}</p>}
        </div>
      )}
      {workItem.verify && (
        <ul className="mt-3 space-y-1">
          {workItem.verify.items.map((v) => (
            <li key={v.index} className="flex gap-2 text-label">
              <span className="w-9 shrink-0 font-mono text-caption text-accent-strong">{v.pass ? "PASS" : "FAIL"}</span>
              <span className="text-muted-foreground">{workItem.acceptance[v.index]?.text ?? "#" + v.index}</span>
            </li>
          ))}
        </ul>
      )}
      {rejected.length > 0 && (
        <p className="mt-2 text-caption text-faint-foreground">已拒绝的 review 意见：{rejected.map((r) => r.comment + "（" + r.reason + "）").join("；")}</p>
      )}
      {error && <InlineNotice tone="error" className="mt-3 whitespace-pre-wrap break-words">{error}</InlineNotice>}
    </Card>
  );
};
