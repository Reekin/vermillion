import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type AgentRun, type Scheduler, type WorkItem, type WorkbenchClient, type WorkflowAction, type WorkRequest } from "@vermillion/workbench/client";
import type { TaskTarget, WorkbenchState } from "../workbench-store.js";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog.js";
import { WorkItemDialog } from "./WorkItemDialog.js";
import { currentWorkStatus, workItemBoardLabel, workRequestStatus } from "./task-labels.js";
import { Badge, Button, DisclosureCard, EmptyState, IconButton, InlineNotice, ListRow, Stepper, Toggle } from "./ui.js";

import { roleLabel, workItemProgress } from "./workflow-display.js";
import { isOpenWorkItem, workBoardGroups, workBoardCounts, workExpansionKey, type BoardEntry } from "./work-board-display.js";
export { isOpenWorkItem } from "./work-board-display.js";

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

const WorkRequestRow = ({ entry, sourceTitle, open, onToggle, busy, onOpenSession, action, children }: {
  entry: Extract<BoardEntry, { kind: "work" }>; sourceTitle: string; open: boolean; onToggle: () => void; busy: boolean;
  onOpenSession: (sessionId: string, turnId?: string) => void;
  action: (method: "work.pause" | "work.resume" | "work.retry" | "work.cancel" | "work.confirm") => void; children: ReactNode;
}) => {
  const { request, items } = entry;
  const state = workRequestStatus(request, items);
  const paused = request.control === "paused";
  const title = request.scope?.trim() || sourceTitle;
  const finished = !entry.open;
  return <li className="border-t border-border first:border-t-0">
    <ListRow leading={items.length ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : undefined}
      title={<span title={title}>{title}</span>} onClick={items.length ? onToggle : undefined} expanded={items.length ? open : undefined}
      titleClassName={finished ? "text-muted-foreground" : "text-strong"}
      meta={!finished && !items.length ? request.failure ?? request.waitReason : undefined}
      columns={{ controls: true, info: <span title={new Date(entry.updatedAt).toLocaleString("zh-CN")}>{items.length} 工单 · {relativeTime(entry.updatedAt)}</span>,
        status: <Badge status={state.status} muted={finished}>{state.label}</Badge>,
        hoverAction: !finished && <IconButton icon={X} size={12} label={"取消工作：" + title} disabled={busy} onClick={() => action("work.cancel")} />,
        action: request.workerSessionId && <SessionLink sessionId={request.workerSessionId} onOpenSession={onOpenSession} />,
        control: finished ? null : request.waitReason?.includes("受理状态不明") ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => action("work.confirm")}>确认状态</Button>
          : paused ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => action("work.resume")}>恢复</Button>
          : request.status === "failed" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => action("work.retry")}>重试</Button>
          : request.control === "manual" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => action("work.resume")}>恢复自动推进</Button>
          : <Button size="sm" variant="ghost" disabled={busy} onClick={() => action("work.pause")}>暂停</Button> }}
    />
    {open && children}
  </li>;
};

const WorkItemRow = ({ item, run, actions, waitingFor, depth, busy, onOpenSession, onCancel, onPause, onResume, onRetry, onOpen }: {
  item: WorkItem; run?: AgentRun; actions: WorkflowAction[]; waitingFor: string[]; depth: number; busy: boolean;
  onOpenSession: (sessionId: string, turnId?: string) => void; onCancel: () => void; onPause: () => void; onResume: () => void; onRetry: () => void; onOpen: () => void;
}) => {
  const progress = workItemProgress(item, actions, run, waitingFor);
  const sessionId = item.run.sessionId ?? run?.sessionId;
  const info = [run && run.turns + " turn", relativeTime(item.updatedAt)].filter(Boolean).join(" · ");
  const open = isOpenWorkItem(item);
  const state = currentWorkStatus(item);
  const label = workItemBoardLabel(item, progress.shortLabel);
  const meta = open ? waitingFor.length ? "等待 " + waitingFor.join("、") : progress.reason ?? item.run.waitReason : undefined;
  const paused = item.run.pauseReason === "user" || item.run.control === "paused";
  const manual = item.run.control === "manual" && !paused;
  const retryable = item.status === "decision" && !paused && Boolean(item.run.waitReason?.includes("故障") || item.run.waitReason?.includes("工作受阻") || item.run.waitReason?.includes("次数"));
  return (
    <li data-task-id={item.workItemId} className="border-t border-border first:border-t-0">
      <ListRow
        depth={depth}
        leading={<Badge>{item.risk}</Badge>}
        title={<span title={item.title}>{item.title}</span>}
        onClick={onOpen}
        meta={meta}
        titleClassName={!open ? "text-muted-foreground" : undefined}
        columns={{
          controls: true,
          info: <span title={[new Date(item.updatedAt).toLocaleString("zh-CN"), run && roleLabel[run.role]].filter(Boolean).join(" · ")}>{info}</span>,
          status: <Badge status={!open ? item.status : paused || manual || state.kind === "interrupted" ? "decision" : item.status} muted={!open}>{label}</Badge>,
          hoverAction: isOpenWorkItem(item) && <IconButton icon={X} size={12} label={"取消工单：" + item.title} disabled={busy} onClick={onCancel} />,
          control: isOpenWorkItem(item) && (paused ? <Button size="sm" variant="ghost" disabled={busy} onClick={onResume}>恢复</Button>
              : manual && item.status !== "decision" ? <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>恢复自动推进</Button>
              : retryable ? <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>重试</Button>
              : <Button size="sm" variant="ghost" disabled={busy} onClick={onPause}>暂停</Button>),
          action: sessionId && <SessionLink sessionId={sessionId} onOpenSession={onOpenSession} />
        }}
      />
    </li>
  );
};

type WorkItemsSectionProps = {
  sourceTitles: Record<string, string>; client: WorkbenchClient; workspaceId: string; scheduler: Scheduler; workItems: WorkItem[]; workRequests: WorkRequest[]; runs: AgentRun[]; actions: WorkflowAction[];
  onOpenSession: (sessionId: string, turnId?: string) => void; compact: boolean; onExpand: () => void;
  expandedWorkGroups: WorkbenchState["expandedWorkGroups"];
  setWorkGroupExpanded: WorkbenchState["setWorkGroupExpanded"];
  detailTarget?: { workspaceId: string; workItemId: string; nonce: number };
  onDetailTargetConsumed?: () => void;
  onOpenIssue?: (issueId: string) => void;
  /** Task picked from the status bar: keep it visible in the overlay and scroll to it once. */
  taskTarget?: TaskTarget;
};

export const WorkItemsSection = ({ sourceTitles, client, workspaceId, scheduler, workItems, workRequests, runs, actions, onOpenSession, onOpenIssue, compact, onExpand, taskTarget, detailTarget, onDetailTargetConsumed, expandedWorkGroups, setWorkGroupExpanded }: WorkItemsSectionProps) => {
  const board = useRef<HTMLDivElement>(null);
  const located = useRef<TaskTarget | undefined>(undefined);
  const groups = useMemo(() => workBoardGroups(workRequests, workItems), [workRequests, workItems]);
  const counts = workBoardCounts(workRequests, workItems);
  const isExpanded = (key: string) => expandedWorkGroups[workspaceId + "/" + key] !== false;
  const openParents = (id: string) => {
    const group = groups.find((group) => group.entries.some((entry) => entry.kind === "item" ? entry.id === id : entry.items.some((item) => item.workItemId === id)));
    if (!group) return false;
    const work = group.entries.find((entry) => entry.kind === "work" && entry.items.some((item) => item.workItemId === id));
    const keys = [group.id, ...(work ? [workExpansionKey(work.id)] : [])].filter((key) => !isExpanded(key));
    for (const key of keys) setWorkGroupExpanded(workspaceId, key, true);
    return keys.length > 0;
  };
  useEffect(() => {
    if (!taskTarget || located.current === taskTarget) return;
    if (openParents(taskTarget.id)) return;
    const item = board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskTarget.id)}"]`);
    if (item) {
      item.scrollIntoView({ block: "start" });
      located.current = taskTarget;
    }
  }, [taskTarget, groups, expandedWorkGroups, workspaceId, setWorkGroupExpanded]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<{ workspaceId: string; workItemId: string }>();
  useEffect(() => {
    if (!detailTarget || detailTarget.workspaceId !== workspaceId) return;
    if (!workItems.some((item) => item.workItemId === detailTarget.workItemId)) return;
    if (openParents(detailTarget.workItemId)) return;
    board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(detailTarget.workItemId)}"]`)?.scrollIntoView({ block: "nearest" });
    setDetail({ workspaceId, workItemId: detailTarget.workItemId });
    onDetailTargetConsumed?.();
  }, [detailTarget, groups, expandedWorkGroups, onDetailTargetConsumed, setWorkGroupExpanded, workItems, workspaceId]);
  const openDetail = (workItemId: string) => setDetail({ workspaceId, workItemId });
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const setScheduler = (value: Partial<Scheduler>) => void perform(() => client.request("scheduler.set", { workspaceId, value: { ...scheduler, ...value } }));
  const latestRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const visibleGroups = compact ? groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => entry.open ||
    (entry.kind === "item" ? entry.id === taskTarget?.id : entry.items.some((item) => item.workItemId === taskTarget?.id))) })).filter((group) => group.entries.length) : groups;
  const hidden = groups.reduce((n, group) => n + group.entries.length, 0) - visibleGroups.reduce((n, group) => n + group.entries.length, 0);
  const renderItem = (item: WorkItem, depth = 0) => (
    <WorkItemRow key={item.workItemId} item={item} actions={actions}
      run={latestRuns.find((r) => r.workItemId === item.workItemId && (!item.run.sessionId || r.sessionId === item.run.sessionId))}
      waitingFor={item.status === "queued" ? item.dependsOn.flatMap((id) => {
        const dependency = workItems.find((w) => w.workItemId === id);
        return dependency?.status === "closed" ? [] : [dependency ? dependency.title + (dependency.status === "cancelled" ? "（已取消）" : "") : id];
      }) : []}
      depth={depth} busy={busy} onOpenSession={onOpenSession}
      onOpen={() => openDetail(item.workItemId)}
      onCancel={() => void perform(() => client.request("workItem.cancel", { workspaceId, workItemId: item.workItemId }))}
      onPause={() => void perform(() => client.request("workItem.pause", { workspaceId, workItemId: item.workItemId }))}
      onResume={() => void perform(() => client.request("workItem.resume", { workspaceId, workItemId: item.workItemId }))}
      onRetry={() => void perform(() => client.request("workItem.retry", { workspaceId, workItemId: item.workItemId }))}
    />
  );
  return (
    <div ref={board}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 text-caption text-muted-foreground">
        <Button size="sm" onClick={() => setCreating(true)}>创建工单</Button>
        <Toggle label="自动推进" checked={scheduler.enabled} disabled={busy} onChange={(enabled) => setScheduler({ enabled })} />
        <Stepper label="并发" value={scheduler.maxWorkers} min={1} max={8} disabled={busy} onChange={(maxWorkers) => setScheduler({ maxWorkers })} />
        <span className="border-l border-border-strong pl-3 text-caption text-muted-foreground">
          {counts.active} 执行中 · {counts.waiting} 等待中 · {counts.ended} 已结束
        </span>
        {hidden > 0 && <Button size="sm" variant="ghost" className="ml-auto underline underline-offset-4" onClick={onExpand}>另有 {hidden} 项已结束</Button>}
      </div>
      {error && <InlineNotice tone="error" className="pt-2">{error}</InlineNotice>}
      {visibleGroups.length === 0 ? <EmptyState title={hidden ? "没有进行中的工作" : "还没有工作"} hint="在会话中点击开工，或创建一张工单。" /> : (
        <div className="max-w-6xl space-y-3 p-4">
          {visibleGroups.map((group) => {
            const title = group.id === "standalone" ? "独立工单" : sourceTitles[group.id] ?? "来源会话";
            return <DisclosureCard key={group.id} plain title={title} open={isExpanded(group.id)}
              onToggle={() => setWorkGroupExpanded(workspaceId, group.id, !isExpanded(group.id))}
              time={<span title={new Date(group.updatedAt).toLocaleString("zh-CN")}>{relativeTime(group.updatedAt)}</span>}>
              <ul>{group.entries.map((entry) => entry.kind === "item" ? renderItem(entry.item) : <WorkRequestRow key={entry.id}
                entry={entry} sourceTitle={title} open={isExpanded(workExpansionKey(entry.id))}
                onToggle={() => setWorkGroupExpanded(workspaceId, workExpansionKey(entry.id), !isExpanded(workExpansionKey(entry.id)))}
                busy={busy} onOpenSession={onOpenSession}
                action={(method) => void perform(() => client.request(method, { workspaceId, requestId: entry.id }))}>
                <ul>{entry.items.map((item) => renderItem(item, 1))}</ul>
              </WorkRequestRow>)}</ul>
            </DisclosureCard>;
          })}
        </div>
      )}
      {creating && <CreateWorkItemDialog client={client} workspaceId={workspaceId} onClose={() => setCreating(false)} />}
      {detail?.workspaceId === workspaceId && <WorkItemDialog key={workspaceId + "/" + detail.workItemId} client={client} workspaceId={workspaceId}
        workItemId={detail.workItemId} workItems={workItems} runs={runs} actions={actions} onClose={() => setDetail(undefined)} onOpenSession={onOpenSession} onOpenIssue={onOpenIssue} />}
    </div>
  );
};
