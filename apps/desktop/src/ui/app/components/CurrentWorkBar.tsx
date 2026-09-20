import { useState } from "react";
import { ClipboardList } from "lucide-react";
import type { WorkRequest, WorkItem, WorkbenchClient } from "@vermillion/workbench/client";
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
};

export const CurrentWorkBar = ({ client, workspaceId, sourceTitle, request, item, hasDecision, onOpenWorkItem }: Props) => {
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  const primary = state.kind === "confirmation" ? { label: "确认状态", operation: "confirm" as const }
    : state.kind === "paused" ? { label: preparation ? "恢复准备" : "恢复本工单", operation: "resume" as const }
    : state.kind === "interrupted" ? { label: "继续", operation: "retry" as const }
    : state.kind === "manual" ? { label: "恢复自动推进", operation: item ? "retry" as const : "resume" as const }
    : finished || state.kind === "decision" ? undefined
    : { label: preparation ? "暂停准备" : "暂停本工单", operation: "pause" as const };
  const retryAt = item?.run.retryAt ?? request?.retryAt;
  return <>
    <section className="vm-current-work" aria-label="当前工作">
      <div className="vm-current-work__summary">
        <ClipboardList size={16} className="text-muted-foreground" aria-hidden="true" />
        <span className="vm-current-work__title" title={title}>{title}</span>
        <span className="vm-current-work__state" data-state={state.kind}>{label}</span>
      </div>
      <div className="vm-current-work__actions">
        {primary && <Button size="sm" variant="primary" disabled={busy} onClick={() => void invoke(primary.operation)}>{primary.label}</Button>}
        <Button size="sm" variant="ghost" outlined onClick={() => setDetail(true)}>查看</Button>
        {!finished && <OverflowMenu label="更多工作操作" items={[
          ...(state.kind !== "paused" && primary?.operation !== "pause" ? [{ label: preparation ? "暂停准备" : "暂停本工单", disabled: busy, onSelect: () => void invoke("pause") }] : []),
          { label: item ? "取消本工单" : "取消本次工作", disabled: busy, onSelect: () => void invoke("cancel") }
        ]} />}
      </div>
    </section>
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
