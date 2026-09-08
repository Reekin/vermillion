import { useState } from "react";
import type { InboxItem, WorkItem } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { useWorkflowContext } from "../use-workflow-context.js";
import { WorkItemDialog } from "./WorkItemDialog.js";
import { actionStatusLabel, dispositionSummary, roleLabel } from "./workflow-display.js";
import { statusLabel } from "./task-labels.js";
import { Badge, Button, Card, CollapsibleDetails, EmptyState, Field, InlineNotice, DetailSection, ListRow } from "./ui.js";

type InboxPanelProps = { store: WorkbenchStore };

export const InboxPanel = ({ store }: InboxPanelProps) => {
  const pending = store((s) => s.inbox);
  const receipts = store((s) => s.inboxReceipts);
  const inbox = [...pending, ...receipts.filter((receipt) => !pending.some((entry) => entry.kind === "decision" && entry.workspaceId === receipt.workspaceId && entry.card.decisionId === receipt.card.decisionId))];
  const inboxError = store((s) => s.inboxError);
  if (inboxError) {
    return <EmptyState title="Inbox 加载失败" hint={inboxError} />;
  }
  if (inbox.length === 0) {
    return <EmptyState title="没有待处理事项" hint="决策卡和已合入通知会出现在这里。" />;
  }
  return (
    <ul className="mx-auto w-full max-w-4xl space-y-3 p-4">
      {inbox.map((item) => (
        <li key={item.kind === "decision" ? item.card.decisionId : item.workItem.workItemId}>
          {item.kind === "decision" ? <DecisionCard store={store} item={item} /> : <MergedCard store={store} item={item} />}
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
  const { data, error: contextError } = useWorkflowContext(client, item.workspaceId);
  const [detailId, setDetailId] = useState<string>();
  const card = data?.decisions.find((entry) => entry.decisionId === item.card.decisionId) ?? item.card;
  const action = data?.actions.find((entry) => entry.actionId === card.actionId);
  const dispositions = action ? dispositionSummary(action) : [];
  const relatedIds = [...new Set([...(action?.workItemIds ?? []), ...(card.workItemId ? [card.workItemId] : [])])];
  const sessionId = card.sessionId ?? data?.workItems.find((entry) => entry.workItemId === card.workItemId)?.run.sessionId;
  const retainDecision = store((s) => s.retainDecision);
  const dismissDecision = store((s) => s.dismissDecision);
  const answered = !!card.answer;
  const adjustments = card.adjustments ?? [];
  // Keep the card mounted while the pending-list event arrives, then show the persisted answer.
  const answer = async (key?: string) => {
    setBusy(true);
    setError(null);
    retainDecision(item);
    try {
      await client.request("decision.answer", { workspaceId: item.workspaceId, decisionId: item.card.decisionId, key, note: note.trim() || undefined });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  if (card.withdrawn) return null;
  return (
    <>
    <Card
      header={
        <>
          <Badge tone="accent">{answered ? "已答复" : "决策"}</Badge>
          {sessionId && <Button size="sm" variant="ghost" outlined className="ml-auto" onClick={() => showAgentSession(item.workspaceId, sessionId)}>进入会话</Button>}
        </>
      }
    >
      <p className="text-label font-medium text-strong">{card.question}</p>
      {card.context && <p className="mt-1.5 whitespace-pre-wrap text-body text-muted-foreground">{card.context}</p>}
      {adjustments.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-input px-3 py-2">
          <div className="eyebrow mb-1">等待答复期间工单已调整</div>
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
                {option.label}
              </Button>
              <div className="min-w-0 pt-1.5 text-caption text-muted-foreground">
                {option.detail && <span>{option.detail}</span>}
                {recommended && card.recommendation && <span className="block text-caption text-muted-foreground">推荐：{card.recommendation}</span>}
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
        <Field kind="textarea" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注" className="min-w-0 flex-1" />
        <Button type="submit" disabled={busy || !note.trim()} className="shrink-0">仅以备注答复</Button>
      </form>
      </>}
      {answered && <DetailSection title="答复结果">
        <p>{[card.options.find((option) => option.key === card.answer?.key)?.label, card.answer?.note].filter(Boolean).join(" · ")}</p>
        <p>{card.deliveryPending ? "答复已保存，等待送达 Worker" : "答复已送达 Worker"}</p>
        <Button size="sm" variant="ghost" onClick={() => dismissDecision(item.workspaceId, card.decisionId)}>知道了</Button>
      </DetailSection>}
      {action && <DetailSection title={answered ? "当前处置" : "已尝试的处置"}>
        <p>{roleLabel[action.role]} · {actionStatusLabel[action.status]}</p>
        {dispositions.length ? dispositions.slice(-5).map((summary, index) => <p key={index}>{summary}</p>) : <p>尚无已执行的自动处置。</p>}
      </DetailSection>}
      {relatedIds.length > 0 && <DetailSection title="相关工单">{relatedIds.map((id) => {
        const related = data?.workItems.find((entry) => entry.workItemId === id);
        return <ListRow key={id} title={related?.title ?? id} leading={related && <Badge>{related.risk}</Badge>}
          trailing={related && <Badge status={related.status}>{statusLabel[related.status]}</Badge>} onClick={() => setDetailId(id)} />;
      })}</DetailSection>}
      {contextError && <InlineNotice tone="error">{contextError}</InlineNotice>}
      {error && <InlineNotice tone="error" className="mt-3 whitespace-pre-wrap break-words">{error}</InlineNotice>}
      {(card.details || action?.history.length) && (
        <CollapsibleDetails open={showDetails} onToggle={() => toggleDetails(item.workspaceId, card.decisionId)}>{[card.details, action?.history.map((entry) => entry.at + " " + entry.message).join("\n")].filter(Boolean).join("\n\n")}</CollapsibleDetails>
      )}
    </Card>
    {detailId && data && <WorkItemDialog client={client} workspaceId={item.workspaceId} workItemId={detailId} workItems={data.workItems} runs={data.runs} actions={data.actions} onClose={() => setDetailId(undefined)} onOpenSession={(id, turnId) => showAgentSession(item.workspaceId, id, turnId)} />}
    </>
  );
};

const technicalDetails = (item: WorkItem): string => {
  const { merge, evidence, verify } = item;
  return [
    merge && ["合入", "commit: " + (merge.commit ?? "无代码改动"), "时间: " + merge.mergedAt, "Diff 概况", merge.diffStat || "无文件变更"].join("\n"),
    evidence && ["命令输出", ...evidence.commands.map((entry) => "$ " + entry.command + "\n" + entry.output)].join("\n\n"),
    ["Review 处置", ...item.review.map((entry) => (entry.decision === "accepted" ? "采纳：" : "拒绝：") + entry.comment + "\n理由：" + entry.reason)].join("\n\n"),
    verify && ["验收过程 · " + verify.verifiedAt, ...verify.items.map((entry) => [
      (entry.index + 1) + ". " + (item.acceptance[entry.index]?.text ?? "验收项"),
      (entry.pass ? "通过：" : "未通过：") + entry.evidence
    ].join("\n"))].join("\n\n"),
    evidence?.assumptions.length && "假设\n" + evidence.assumptions.join("\n"),
    evidence?.untested.length && "未测\n" + evidence.untested.join("\n"),
    evidence?.outOfScopeFindings.length && "范围外发现\n" + evidence.outOfScopeFindings.join("\n"),
    evidence?.attachments.length && "附件\n" + evidence.attachments.join("\n")
  ].filter(Boolean).join("\n\n");
};

const MergedCard = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "merged" }> }) => {
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
          <Badge>已合入</Badge>
          <span className="ml-auto truncate text-caption text-muted-foreground">工单</span>
        </>
      }
      footer={
        rollingBack ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim()) return;
              void run(() => client.request("workItem.rollback", { workspaceId: item.workspaceId, workItemId: workItem.workItemId, reason: reason.trim() }));
            }}
          >
            <Field kind="textarea" rows={2} label="回滚理由" autoFocus disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明需要修改的地方，Worker 会据此继续处理" className="w-full" />
            <Button variant="primary" type="submit" disabled={busy || !reason.trim()}>确认回滚并续做</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setRollingBack(false)}>取消</Button>
          </form>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void run(() => client.request("inbox.acknowledge", { workspaceId: item.workspaceId, workItemId: workItem.workItemId }))}>知道了</Button>
            {workItem.merge?.commit && <Button disabled={busy} onClick={() => setRollingBack(true)}>附理由回滚</Button>}
            {workItem.run.sessionId && <Button variant="ghost" size="sm" outlined className="ml-auto" onClick={() => showAgentSession(item.workspaceId, workItem.run.sessionId!)}>会话</Button>}
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
              <Badge>{v.pass ? "通过" : "未通过"}</Badge>
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
