import { useState, type FormEvent } from "react";
import type { WorkbenchClient, WorkflowAction, WorkItem } from "@vermillion/workbench/client";
import { actionStatusText, integrationFailureSummary } from "./workflow-display.js";
import { Badge, Button, Field, InlineNotice, OverflowMenu } from "./ui.js";

type IntegrationAction = Extract<WorkflowAction, { kind: "integration" }>;

export const IntegrationControls = ({ client, workspaceId, workItemId, action, item, showStatus = true }: {
  client: WorkbenchClient;
  workspaceId: string;
  workItemId: string;
  action?: IntegrationAction;
  item?: WorkItem;
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
  const canAct = !action.agent && action.status === "decision";
  const retry = () => void run(() => client.request("workItem.integration.retry", { workspaceId, workItemId }));
  const takeover = (event: FormEvent) => {
    event.preventDefault();
    void run(() => client.request("workItem.integration.takeover", { workspaceId, workItemId, note: note.trim() || undefined }));
  };
  return <div className="mt-3 space-y-2 border-t border-border pt-3">
    {showStatus && <div className="flex flex-wrap items-center gap-2">
      <Badge>{actionStatusText(action, item)}</Badge>
    </div>}
    {integrationFailureSummary(action) && <InlineNotice tone="error" className="px-0">最近失败：{integrationFailureSummary(action)}</InlineNotice>}
    {action.status === "decision" && <p className="text-caption text-muted-foreground">合入受阻，可以立即重试或交给原 Worker 处理。</p>}
    {action.agent && item?.run.lastFailure && <InlineNotice tone="error" className="px-0">执行失败：{item.run.lastFailure}</InlineNotice>}
    {action.agent && <p className="whitespace-pre-wrap text-caption text-muted-foreground">{action.agent.note ? "用户说明：" + action.agent.note : "原 Worker 将处理本次合入。"}</p>}
    {canAct && !takeoverOpen && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={retry}>立即重试</Button>
      <Button size="sm" disabled={busy} onClick={() => setTakeoverOpen(true)}>交给 Agent 合入</Button>
      <OverflowMenu label="更多合入处置" items={[{ label: "取消工单", disabled: busy, onSelect: () => void run(() => client.request("workItem.cancel", { workspaceId, workItemId })) }]} />
    </div>}
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
