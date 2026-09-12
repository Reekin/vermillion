import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentRun, type Scheduler, type WorkItem, type WorkbenchClient, type WorkflowAction } from "@vermillion/workbench/client";
import type { TaskTarget, WorkbenchState } from "../workbench-store.js";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog.js";
import { WorkItemDialog } from "./WorkItemDialog.js";
import { statusLabel } from "./task-labels.js";
import { Badge, Button, DisclosureCard, EmptyState, IconButton, InlineNotice, ListRow, Stepper, Toggle } from "./ui.js";

import { roleLabel, actionRoleLabel, actionStatusText, integrationShortStatus, waitingActions, waitingReason } from "./workflow-display.js";
export const isOpenWorkItem = (item: WorkItem) => item.status !== "closed" && item.status !== "cancelled";
const workItemPriority = (item: WorkItem) => item.status === "running" ? 0 : isOpenWorkItem(item) ? 1 : 2;
const prioritizeWorkItems = (items: WorkItem[]) => [0, 1, 2].flatMap((priority) => items.filter((item) => workItemPriority(item) === priority));

const relativeTime = (iso: string) => {
  const date = new Date(iso);
  const now = new Date();
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return Math.floor(minutes / 60) + " 小时前";
  if (date.toDateString() === yesterday.toDateString()) return "昨天 " + time;
  return date.toLocaleDateString("zh-CN") + " " + time;
};

const SessionLink = ({ sessionId, onOpenSession, children = "会话" }: { sessionId: string; onOpenSession: (sessionId: string, turnId?: string) => void; children?: string }) => (
  <Button size="sm" variant="ghost" outlined onClick={() => onOpenSession(sessionId)}>{children}</Button>
);

const WorkItemRow = ({ item, run, actions, waitingFor, compact, muted, busy, onOpenSession, onCancel, onOpen }: {
  item: WorkItem; run?: AgentRun; actions: WorkflowAction[]; waitingFor: string[]; compact: boolean; muted: boolean; busy: boolean;
  onOpenSession: (sessionId: string, turnId?: string) => void; onCancel: () => void; onOpen: () => void;
}) => {
  const blockers = waitingActions(actions, item);
  const integration = actions.filter((action): action is Extract<WorkflowAction, { kind: "integration" }> =>
    action.kind === "integration" && action.workItemId === item.workItemId && action.stage === "merge" && action.status !== "done" && action.status !== "cancelled")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const userPaused = item.run.pauseReason === "user";
  const sessionId = item.run.sessionId ?? run?.sessionId;
  const at = run?.endedAt ?? item.run.heartbeatAt ?? run?.startedAt ?? item.updatedAt;
  const info = [run && [!compact && roleLabel[run.role], run.turns + " turn", compact ? relativeTime(at) : new Date(at).toLocaleString("zh-CN")].filter(Boolean).join(" · "),
    integration && (integration.status === "retry" ? `自动重试 ${Math.min(integration.attempts, 4)}/4` : integration.status === "decision" ? "自动重试已用尽" : undefined)].filter(Boolean).join(" · ");
  return (
    <li data-task-id={item.workItemId} className="border-t border-border first:border-t-0">
      <ListRow
        leading={<Badge>{item.risk}</Badge>}
        title={<span title={item.title}>{item.title}</span>}
        onClick={onOpen}
        meta={userPaused ? undefined : blockers.length ? blockers.map((action) => <div key={action.actionId}>{waitingReason(action)} · {actionRoleLabel(action)}</div>) : waitingFor.length ? "等待 " + waitingFor.join("、") + " · 工作台" : undefined}
        titleClassName={muted || !isOpenWorkItem(item) ? "text-faint-foreground" : undefined}
        columns={{
          info: info && <span title={[info, item.run.lastFailure].filter(Boolean).join(" · ")}>{info}</span>,
          status: <Badge status={item.status} muted={muted}>{userPaused ? "用户暂停" : integration ? integrationShortStatus(integration, item) : statusLabel[item.status]}</Badge>,
          hoverAction: isOpenWorkItem(item) && <IconButton icon={X} size={12} label={"取消工单：" + item.title} disabled={busy} onClick={onCancel} />,
          action: sessionId && <SessionLink sessionId={sessionId} onOpenSession={onOpenSession} />
        }}
      />
    </li>
  );
};

type WorkItemsSectionProps = {
  sourceTitles: Record<string, string>; client: WorkbenchClient; workspaceId: string; scheduler: Scheduler; workItems: WorkItem[]; runs: AgentRun[]; actions: WorkflowAction[];
  onOpenSession: (sessionId: string, turnId?: string) => void; compact: boolean; onExpand: () => void;
  expandedWorkGroups: WorkbenchState["expandedWorkGroups"];
  setWorkGroupExpanded: WorkbenchState["setWorkGroupExpanded"];
  detailTarget?: { workspaceId: string; workItemId: string; nonce: number };
  onDetailTargetConsumed?: () => void;
  onOpenIssue?: (issueId: string) => void;
  /** Task picked from the status bar: keep it visible in the overlay and scroll to it once. */
  taskTarget?: TaskTarget;
};

export const WorkItemsSection = ({ sourceTitles, client, workspaceId, scheduler, workItems, runs, actions, onOpenSession, onOpenIssue, compact, onExpand, taskTarget, detailTarget, onDetailTargetConsumed, expandedWorkGroups, setWorkGroupExpanded }: WorkItemsSectionProps) => {
  const board = useRef<HTMLDivElement>(null);
  const located = useRef<TaskTarget | undefined>(undefined);
  useEffect(() => {
    if (!taskTarget || located.current === taskTarget) return;
    const groupId = workItems.find((item) => item.workItemId === taskTarget.id)?.treeId ?? "standalone";
    if (expandedWorkGroups[workspaceId + "/" + groupId] === false) {
      setWorkGroupExpanded(workspaceId, groupId, true);
      return;
    }
    const item = board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskTarget.id)}"]`);
    if (item) {
      item.scrollIntoView({ block: "start" });
      located.current = taskTarget;
    }
  }, [taskTarget, workItems, expandedWorkGroups, workspaceId, setWorkGroupExpanded]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<{ workspaceId: string; workItemId: string }>();
  useEffect(() => {
    if (!detailTarget || detailTarget.workspaceId !== workspaceId) return;
    if (!workItems.some((item) => item.workItemId === detailTarget.workItemId)) return;
    const groupId = workItems.find((item) => item.workItemId === detailTarget.workItemId)?.treeId ?? "standalone";
    if (expandedWorkGroups[workspaceId + "/" + groupId] === false) {
      setWorkGroupExpanded(workspaceId, groupId, true);
      return;
    }
    setDetail({ workspaceId, workItemId: detailTarget.workItemId });
    onDetailTargetConsumed?.();
  }, [detailTarget, expandedWorkGroups, onDetailTargetConsumed, setWorkGroupExpanded, workItems, workspaceId]);
  const openDetail = (workItemId: string) => setDetail({ workspaceId, workItemId });
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const setScheduler = (value: Partial<Scheduler>) => void perform(() => client.request("scheduler.set", { workspaceId, value: { ...scheduler, ...value } }));
  const latestRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const visible = compact ? workItems.filter((item) => isOpenWorkItem(item) || item.workItemId === taskTarget?.id) : workItems;
  const hidden = workItems.length - visible.length;
  const groups = new Map<string, WorkItem[]>();
  for (const item of visible) {
    const key = item.treeId ?? "standalone";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const groupedItems = [...groups].map(([groupId, items]) => [groupId, prioritizeWorkItems(items)] as const);
  const orderedGroups = [0, 1, 2].flatMap((priority) => groupedItems.filter(([, items]) => Math.min(...items.map(workItemPriority)) === priority));
  const renderItems = (items: WorkItem[], muted = false) => (
    <ul>{items.map((item) => <WorkItemRow key={item.workItemId} item={item} actions={actions}
      run={latestRuns.find((r) => r.workItemId === item.workItemId && (!item.run.sessionId || r.sessionId === item.run.sessionId))}
      waitingFor={item.status === "queued" ? item.dependsOn.flatMap((id) => {
        const dependency = workItems.find((w) => w.workItemId === id);
        return dependency?.status === "closed" ? [] : [dependency ? dependency.title + (dependency.status === "cancelled" ? "（已取消）" : "") : id];
      }) : []}
      compact={compact} muted={muted} busy={busy} onOpenSession={onOpenSession}
      onOpen={() => openDetail(item.workItemId)}
      onCancel={() => void perform(() => client.request("workItem.cancel", { workspaceId, workItemId: item.workItemId }))}
    />)}</ul>
  );
  return (
    <div ref={board}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 text-caption text-muted-foreground">
        <Button size="sm" onClick={() => setCreating(true)}>创建工单</Button>
        <Toggle label="调度" checked={scheduler.enabled} disabled={busy} onChange={(enabled) => setScheduler({ enabled })} />
        <Stepper label="并发" value={scheduler.maxWorkers} min={1} max={8} disabled={busy} onChange={(maxWorkers) => setScheduler({ maxWorkers })} />
        <span className="border-l border-border-strong pl-3 text-caption text-muted-foreground">
          {workItems.filter((w) => w.status === "running").length} 进行中 · {workItems.filter((w) => !isOpenWorkItem(w)).length} 已结束
        </span>
        {hidden > 0 && <Button size="sm" variant="ghost" className="ml-auto underline underline-offset-4" onClick={onExpand}>另有 {hidden} 项已结束</Button>}
      </div>
      {error && <InlineNotice tone="error" className="pt-2">{error}</InlineNotice>}
      {visible.length === 0 ? <EmptyState title={hidden ? "没有进行中的工单" : "还没有工单"} hint="在会话中点击开工，或创建一张工单。" /> : (
        <div className="max-w-6xl space-y-3 p-4">
          {orderedGroups.map(([groupId, items]) => <DisclosureCard key={groupId}
            title={groupId === "standalone" ? "独立工单" : sourceTitles[groupId] ?? "来源会话"}
            open={expandedWorkGroups[workspaceId + "/" + groupId] !== false}
            onToggle={() => setWorkGroupExpanded(workspaceId, groupId, expandedWorkGroups[workspaceId + "/" + groupId] === false)}
            progress={<>工单 {items.filter((item) => item.status === "closed").length} / {items.length}</>}>
            {renderItems(items)}
          </DisclosureCard>)}
        </div>
      )}
      {creating && <CreateWorkItemDialog client={client} workspaceId={workspaceId} onClose={() => setCreating(false)} />}
      {detail?.workspaceId === workspaceId && <WorkItemDialog key={workspaceId + "/" + detail.workItemId} client={client} workspaceId={workspaceId}
        workItemId={detail.workItemId} workItems={workItems} runs={runs} actions={actions} onClose={() => setDetail(undefined)} onOpenSession={onOpenSession} onOpenIssue={onOpenIssue} />}
    </div>
  );
};
