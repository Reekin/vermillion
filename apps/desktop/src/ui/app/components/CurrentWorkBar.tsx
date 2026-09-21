import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import type { WorkRequest, WorkItem, WorkbenchClient, WorkbenchRpcResult } from "@vermillion/workbench/client";
import { Button, DetailSection, InlineNotice, OverflowMenu } from "./ui.js";
import { Modal } from "./Modal.js";
import { currentWorkStatus } from "./task-labels.js";

type Props = {
  client: WorkbenchClient;
  workspaceId: string;
  sourceTitle?: string;
  request?: WorkRequest;
  item?: WorkItem;
  hasDecision?: boolean;
  onOpenWorkItem?: () => void;
  onContinueFrom?: (target: { requestId: string } | { workItemId: string }) => Promise<void>;
  onOpenRelatedWorkItem?: (workItemId: string) => void;
};

export const CurrentWorkBar = ({ client, workspaceId, sourceTitle, request, item: associatedItem, hasDecision, onOpenWorkItem, onContinueFrom, onOpenRelatedWorkItem }: Props) => {
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const item = request && !["ready", "cancelled"].includes(request.status) ? undefined : associatedItem;
  if (!request && !item) return null;
  const title = item?.title || request?.scope?.trim() || sourceTitle || "开工准备";
  const state = currentWorkStatus(item, request, hasDecision);
  const reason = item?.run.lastFailure ?? request?.failure ?? item?.run.waitReason ?? request?.waitReason;
  const preparation = !item || item.status === "preparing";
  const phase = preparation ? "准备" : "执行";
  const finished = state.kind === "finished";
  const label = ["manual", "paused", "interrupted"].includes(state.kind) ? `${phase} · ${state.label}` : state.label;
  const invoke = async (operation: "pause" | "resume" | "retry" | "cancel" | "confirm") => {
    setBusy(true);
    setError(undefined);
    try {
      if (item) await client.request(`workItem.${operation}`, { workspaceId, workItemId: item.workItemId });
      else if (request) await client.request(`work.${operation}`, { workspaceId, requestId: request.requestId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const primary = state.kind === "confirmation" || (item?.run.turnStatus ?? request?.turnStatus) === "unknown" ? { label: "确认状态", operation: "confirm" as const }
    : state.kind === "paused" ? { label: preparation ? "恢复准备" : "恢复本工单", operation: "resume" as const }
    : state.kind === "interrupted" ? { label: "继续", operation: "retry" as const }
    : state.kind === "manual" ? { label: "恢复自动推进", operation: item ? "retry" as const : "resume" as const }
    : finished || state.kind === "decision" ? undefined
    : { label: preparation ? "暂停准备" : "暂停本工单", operation: "pause" as const };
  const retryAt = item?.run.retryAt ?? request?.retryAt;
  const continueFrom = async () => {
    setBusy(true);
    setError(undefined);
    try { await onContinueFrom?.(item ? { workItemId: item.workItemId } : { requestId: request!.requestId }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <section className="vm-current-work" aria-label="当前工作">
      <div className="vm-current-work__summary">
        <ClipboardList size={16} className="text-muted-foreground" aria-hidden="true" />
        <span className="vm-current-work__title" title={title}>{title}</span>
        <span className="vm-current-work__state" data-state={state.kind}>{label}</span>
      </div>
      <div className="vm-current-work__actions">
        {!finished && onContinueFrom && <Button size="sm" variant="ghost" outlined disabled={busy} onClick={() => void continueFrom()}>从此处继续执行</Button>}
        {primary && <Button size="sm" variant="primary" disabled={busy} onClick={() => void invoke(primary.operation)}>{primary.label}</Button>}
        <Button size="sm" variant="ghost" outlined onClick={() => setDetail(true)}>查看</Button>
        {!finished && <OverflowMenu label="更多工作操作" items={[
          ...(state.kind !== "paused" && primary?.operation !== "pause" ? [{ label: preparation ? "暂停准备" : "暂停本工单", disabled: busy, onSelect: () => void invoke("pause") }] : []),
          { label: item ? "取消本工单" : "取消本次工作", disabled: busy, onSelect: () => void invoke("cancel") }
        ]} />}
      </div>
    </section>
    {(item?.run.sessionId ?? request?.workerSessionId) && <PendingWorkMessages
      key={item?.run.sessionId ?? request?.workerSessionId}
      client={client} workspaceId={workspaceId} sessionId={(item?.run.sessionId ?? request?.workerSessionId)!}
      onOpenWorkItem={onOpenRelatedWorkItem} onConfirm={primary?.operation === "confirm" ? undefined : () => invoke("confirm")} confirming={busy} />}
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    {detail && <Modal title={title} width={480} onClose={() => setDetail(false)}>
      <div className="space-y-3 px-4 pb-4">
        <DetailSection title="当前状态">{label}</DetailSection>
        <DetailSection title="操作范围">{preparation ? "本次准备过程" : "当前工单"}</DetailSection>
        {reason && <DetailSection title={state.kind === "interrupted" ? "中断原因" : "当前情况"}>{reason}</DetailSection>}
        {retryAt && <DetailSection title="下一次自动重试">{new Date(retryAt).toLocaleString("zh-CN")}</DetailSection>}
        {state.kind === "manual" && <DetailSection title="下一步">继续发消息手动推进，或恢复自动推进。</DetailSection>}
        {onOpenWorkItem && item && <Button size="sm" variant="ghost" outlined onClick={() => { setDetail(false); onOpenWorkItem(); }}>打开工单</Button>}
      </div>
    </Modal>}
  </>;
};

export const PendingWorkMessages = ({ client, workspaceId, sessionId, onOpenWorkItem, onConfirm, confirming }: {
  client: WorkbenchClient; workspaceId: string; sessionId: string;
  onOpenWorkItem?: (workItemId: string) => void;
  onConfirm?: () => Promise<void>;
  confirming?: boolean;
}) => {
  const [messages, setMessages] = useState<WorkbenchRpcResult<"session.messages.pending">>([]);
  const [error, setError] = useState<string>();
  const [withdrawing, setWithdrawing] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    setMessages([]);
    const refresh = async () => {
      const current = ++generation;
      try {
        const result = await client.request("session.messages.pending", { sessionId });
        if (active && current === generation) { setMessages(result); setError(undefined); }
      } catch (cause) {
        if (active && current === generation) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "session.messages.changed" && event.workspaceId === workspaceId && event.sessionId === sessionId) void refresh();
    });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [client, sessionId, workspaceId, revision]);
  const withdraw = async (messageId: string) => {
    setWithdrawing(messageId);
    try {
      const result = await client.request("session.messages.cancel", { sessionId, messageId });
      if (!result.cancelled) throw new Error("消息已开始发送，无法撤回。");
      setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWithdrawing(undefined); }
  };
  return <>
    {messages.map((message) => <section key={message.messageId} aria-label={message.state === "queued" ? "等待发送" : "等待确认"} className="space-y-2 border-t border-border px-3 py-2">
      <p className="text-label text-foreground">{message.state === "queued" ? "等待发送" : "等待确认"}</p>
      <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-body text-foreground">{message.content}</p>
      {message.attachments?.length ? <ul aria-label="待发送附件" className="space-y-1 text-caption text-muted-foreground">
        {message.attachments.map((attachment) => <li key={attachment.attachmentId}>{attachment.name ?? "附件"}</li>)}
      </ul> : null}
      <p className="text-caption text-muted-foreground">{message.reason ?? "等待执行条件满足"}</p>
      <div className="flex flex-wrap gap-2">
        {message.blockerWorkItemIds?.map((workItemId, index) => onOpenWorkItem && <Button key={workItemId} size="sm" variant="ghost" outlined onClick={() => onOpenWorkItem(workItemId)}>查看阻塞工单{message.blockerWorkItemIds!.length > 1 ? ` ${index + 1}` : ""}</Button>)}
        {message.state === "queued"
          ? <Button size="sm" variant="ghost" outlined disabled={withdrawing === message.messageId} onClick={() => void withdraw(message.messageId)}>撤回</Button>
          : onConfirm && <Button size="sm" variant="ghost" outlined disabled={confirming} onClick={() => void onConfirm()}>确认状态</Button>}
      </div>
    </section>)}
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
  </>;
};
