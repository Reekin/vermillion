import { useState, type FormEvent } from "react";
import type { WorkbenchClient, WorkflowAction } from "@vermillion/workbench/client";
import { actionStatusText, integrationFailureSummary, integrationProgress } from "./workflow-display.js";
import { Badge, Button, Field, InlineNotice, OverflowMenu } from "./ui.js";

type IntegrationAction = Extract<WorkflowAction, { kind: "integration" }>;

export const IntegrationControls = ({ client, workspaceId, workItemId, action, showStatus = true }: {
  client: WorkbenchClient;
  workspaceId: string;
  workItemId: string;
  action?: IntegrationAction;
  showStatus?: boolean;
}) => {
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
  const canAct = !action.agent && ["retry", "decision"].includes(action.status);
  const canRetryDelivery = !!action.agent && !action.agent.deliveredAt;
  const retry = () => void run(() => client.request("workItem.integration.retry", { workspaceId, workItemId }));
  const takeover = (event: FormEvent) => {
    event.preventDefault();
    void run(() => client.request("workItem.integration.takeover", { workspaceId, workItemId, note: note.trim() || undefined }));
  };
  return <div className="mt-3 space-y-2 border-t border-border pt-3">
    {showStatus && <div className="flex flex-wrap items-center gap-2">
      <Badge>{actionStatusText(action)}</Badge>
      {action.attempts > 0 && <span className="text-caption text-muted-foreground">已失败 {action.attempts} 次</span>}
    </div>}
    {!showStatus && action.attempts > 0 && <p className="text-caption text-muted-foreground">已失败 {action.attempts} 次</p>}
    {integrationFailureSummary(action) && <InlineNotice tone="error" className="px-0">最近失败：{integrationFailureSummary(action)}</InlineNotice>}
    {action.status === "retry" && <p className="text-caption text-muted-foreground">{integrationProgress(action)}；下次：{action.retryAt ? new Date(action.retryAt).toLocaleString("zh-CN") : "未安排"}</p>}
    {action.status === "decision" && <p className="text-caption text-muted-foreground">自动重试已用尽，可以立即再试或交给 Agent 处理。</p>}
    {action.agent && <p className="whitespace-pre-wrap text-caption text-muted-foreground">{action.agent.note ? "用户说明：" + action.agent.note : "原 Worker 将处理本次合入。"}</p>}
    {canAct && !takeoverOpen && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={retry}>立即重试</Button>
      <Button size="sm" disabled={busy} onClick={() => setTakeoverOpen(true)}>交给 Agent 合入</Button>
      <OverflowMenu label="更多合入处置" items={[{ label: "取消工单", disabled: busy, onSelect: () => void run(() => client.request("workItem.cancel", { workspaceId, workItemId })) }]} />
    </div>}
    {canRetryDelivery && <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void run(() => client.request("workItem.integration.takeover", { workspaceId, workItemId }))}>重新发送给 Agent</Button></div>}
    {canAct && takeoverOpen && <form className="space-y-2" onSubmit={takeover}>
      <Field kind="textarea" label="给 Agent 的说明（可选）" rows={2} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} autoFocus />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={busy}>确认交给 Agent</Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setTakeoverOpen(false)}>取消</Button>
      </div>
    </form>}
    {error && <InlineNotice tone="error" className="px-0 whitespace-pre-wrap">{error}</InlineNotice>}
  </div>;
};
