import { useState } from "react";
import type { InboxItem, WorkItem } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, Card, CollapsibleDetails, EmptyState, Field, InlineNotice } from "./ui.js";

type InboxPanelProps = { store: WorkbenchStore };

export const InboxPanel = ({ store }: InboxPanelProps) => {
  const inbox = store((s) => s.inbox);
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
  const missionTitle = store((s) => s.view?.workspaceId === item.workspaceId ? s.view.missions.find((m) => m.missionId === item.card.missionId)?.title : undefined);
  const { card } = item;
  const adjustments = card.adjustments ?? [];
  // An option with the note attached, or the note alone as a free answer; both reach the worker the same way.
  const answer = async (key?: string) => {
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
      {error && <InlineNotice tone="error" className="mt-3 whitespace-pre-wrap break-words">{error}</InlineNotice>}
      {card.details && (
        <CollapsibleDetails open={showDetails} onToggle={() => toggleDetails(item.workspaceId, card.decisionId)}>{card.details}</CollapsibleDetails>
      )}
    </Card>
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
          <span className="ml-auto truncate text-caption text-muted-foreground">{item.mission ? "任务：" + item.mission.title : "独立工单"}</span>
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
            <Button disabled={busy} onClick={() => setRollingBack(true)}>附理由回滚</Button>
            {workItem.run.sessionId && <Button variant="ghost" size="sm" outlined className="ml-auto" onClick={() => showAgentSession(item.workspaceId, workItem.run.sessionId!)}>会话</Button>}
          </>
        )
      }
    >
      <p className="break-words text-title-sm font-medium text-strong">{workItem.title}</p>
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
