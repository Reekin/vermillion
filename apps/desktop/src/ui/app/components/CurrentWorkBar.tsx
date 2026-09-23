import { useState } from "react";
import { ClipboardList } from "lucide-react";
import type { WorkRequest, WorkItem, WorkbenchClient } from "@vermillion/workbench/client";
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
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const item = request && !["ready", "cancelled"].includes(request.status) ? undefined : associatedItem;
  if (!request && !item) return null;
  const title = item?.title || request?.scope?.trim() || sourceTitle || "开工准备";
  const state = currentWorkStatus(item, request, hasDecision);
  const reason = item?.run.lastFailure ?? request?.failure ?? item?.run.waitReason ?? request?.waitReason;
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
  const primary = state.kind === "paused" || state.kind === "stopped" ? { label: "恢复任务", operation: "resume" as const }
    : state.kind === "interrupted" ? { label: "继续", operation: "retry" as const }
    : finished ? undefined : { label: item ? "暂停本工单" : "暂停准备", operation: "pause" as const };
  return <>
    <section className="vm-current-work" aria-label="当前工作">
      <div className="vm-current-work__summary">
        <ClipboardList size={16} className="text-muted-foreground" aria-hidden="true" />
        <span className="vm-current-work__title" title={title}>{title}</span>
        <span className="vm-current-work__state" data-state={state.kind}>{phase}</span>
        <span className="text-caption text-muted-foreground">{activity}{state.kind === "paused" ? " · 已暂停" : hasDecision ? " · 等待决策" : ""}</span>
      </div>
      <div className="vm-current-work__actions">
        {primary && <Button size="sm" variant="primary" disabled={busy} onClick={() => void invoke(primary.operation)}>{primary.label}</Button>}
        <Button size="sm" variant="ghost" outlined onClick={() => setDetail(true)}>查看</Button>
        {!finished && <OverflowMenu label="更多工作操作" items={[
          ...(state.kind !== "paused" && primary?.operation !== "pause" ? [{ label: item ? "暂停本工单" : "暂停准备", disabled: busy, onSelect: () => void invoke("pause") }] : []),
          { label: item ? "取消本工单" : "取消本次工作", disabled: busy, onSelect: () => void invoke("cancel") }
        ]} />}
      </div>
    </section>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    {detail && <Modal title={title} width={480} onClose={() => setDetail(false)}>
      <div className="space-y-3 px-4 pb-4">
        <DetailSection title="任务阶段">{phase}</DetailSection>
        <DetailSection title="会话活动">{activity}</DetailSection>
        <DetailSection title="任务状态">{state.label}</DetailSection>
        {reason && <DetailSection title="当前情况">{reason}</DetailSection>}
        {request && <SupervisorDetails request={request} client={client} workspaceId={workspaceId} onOpenSession={onOpenSession} />}
        {onOpenWorkItem && item && <Button size="sm" variant="ghost" outlined onClick={() => { setDetail(false); onOpenWorkItem(); }}>打开工单</Button>}
      </div>
    </Modal>}
  </>;
};
