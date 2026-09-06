import { MoreHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { latestRevision, type AgentRun, type Mission, type Scheduler, type WorkItem, type WorkbenchClient } from "@vermillion/workbench/client";
import type { TaskTarget } from "../workbench-store.js";
import { ContextMenu } from "./ContextMenu.js";
import { missionStatusLabel, statusLabel } from "./task-labels.js";
import { Badge, Button, Card, EmptyState, IconButton, InlineNotice, ListRow, SectionLabel, Stepper, Toggle } from "./ui.js";

const roleLabel: Record<AgentRun["role"], string> = { steward: "管家", worker: "Worker", supervisor: "Supervisor" };
export const isOpenWorkItem = (item: WorkItem) => item.status !== "closed" && item.status !== "cancelled";

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

const SessionLink = ({ sessionId, onOpenSession, children = "会话" }: { sessionId: string; onOpenSession: (sessionId: string) => void; children?: string }) => (
  <Button size="sm" variant="ghost" outlined onClick={() => onOpenSession(sessionId)}>{children}</Button>
);

const WorkItemRow = ({ item, run, waitingFor, compact, muted, busy, onOpenSession, onCancel }: {
  item: WorkItem; run?: AgentRun; waitingFor: string[]; compact: boolean; muted: boolean; busy: boolean;
  onOpenSession: (sessionId: string) => void; onCancel: () => void;
}) => {
  const sessionId = item.run.sessionId ?? run?.sessionId;
  const at = run?.endedAt ?? item.run.heartbeatAt ?? run?.startedAt ?? item.updatedAt;
  const info = waitingFor.length > 0 ? "等待 " + waitingFor.join("、") : run
    ? [!compact && roleLabel[run.role], run.turns + " turn", compact ? relativeTime(at) : new Date(at).toLocaleString("zh-CN")].filter(Boolean).join(" · ")
    : item.run.lastFailure ?? "";
  return (
    <li data-task-id={item.workItemId} className="border-t border-border first:border-t-0">
      <ListRow
        leading={<Badge>{item.risk}</Badge>}
        title={<span title={item.title}>{item.title}</span>}
        titleClassName={muted || !isOpenWorkItem(item) ? "text-faint-foreground" : undefined}
        columns={{
          info: <span title={[info, item.run.lastFailure].filter(Boolean).join(" · ")}>{info}</span>,
          status: <Badge status={item.status} muted={muted}>{statusLabel[item.status]}</Badge>,
          hoverAction: isOpenWorkItem(item) && <IconButton icon={X} size={12} label={"取消工单：" + item.title} disabled={busy} onClick={onCancel} />,
          action: sessionId && <SessionLink sessionId={sessionId} onOpenSession={onOpenSession} />
        }}
      />
    </li>
  );
};

type MissionsSectionProps = {
  client: WorkbenchClient; workspaceId: string; scheduler: Scheduler; missions: Mission[]; workItems: WorkItem[]; runs: AgentRun[];
  onOpenSession: (sessionId: string) => void; compact: boolean; onExpand: () => void;
  /** Task picked from the status bar: keep it visible in the overlay and scroll to it once. */
  taskTarget?: TaskTarget;
};

export const MissionsSection = ({ client, workspaceId, scheduler, missions, workItems, runs, onOpenSession, compact, onExpand, taskTarget }: MissionsSectionProps) => {
  const board = useRef<HTMLDivElement>(null);
  const located = useRef<TaskTarget | undefined>(undefined);
  useEffect(() => {
    if (!taskTarget || located.current === taskTarget) return;
    const item = board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskTarget.id)}"]`);
    if (item) {
      item.scrollIntoView({ block: "start" });
      located.current = taskTarget;
    }
  }, [taskTarget, missions, workItems]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; mission: Mission }>();
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const setScheduler = (value: Partial<Scheduler>) => void perform(() => client.request("scheduler.set", { workspaceId, value: { ...scheduler, ...value } }));
  const cancelMission = (mission: Mission) => perform(async () => {
    for (const item of workItems.filter((w) => w.missionId === mission.missionId && isOpenWorkItem(w))) {
      await client.request("workItem.cancel", { workspaceId, workItemId: item.workItemId });
    }
    await client.request("mission.setStatus", { workspaceId, missionId: mission.missionId, status: "cancelled" });
  });
  const latestRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const standalone = workItems.filter((w) => !w.missionId);
  const visibleMissions = compact ? missions.filter((m) => m.status === "active" || m.missionId === taskTarget?.id) : missions;
  const visibleStandalone = compact ? standalone.filter((w) => isOpenWorkItem(w) || w.workItemId === taskTarget?.id) : standalone;
  const hidden = missions.length - visibleMissions.length + standalone.length - visibleStandalone.length;
  const renderItems = (items: WorkItem[], muted = false) => (
    <ul>{items.map((item) => <WorkItemRow key={item.workItemId} item={item}
      run={latestRuns.find((r) => r.workItemId === item.workItemId && (!item.run.sessionId || r.sessionId === item.run.sessionId))}
      waitingFor={item.status === "queued" ? item.dependsOn.flatMap((id) => {
        const dependency = workItems.find((w) => w.workItemId === id);
        return dependency?.status === "closed" ? [] : [dependency ? dependency.title + (dependency.status === "cancelled" ? "（已取消）" : "") : id];
      }) : []}
      compact={compact} muted={muted} busy={busy} onOpenSession={onOpenSession}
      onCancel={() => void perform(() => client.request("workItem.cancel", { workspaceId, workItemId: item.workItemId }))}
    />)}</ul>
  );
  return (
    <div ref={board}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 text-caption text-muted-foreground">
        <Toggle label="调度" checked={scheduler.enabled} disabled={busy} onChange={(enabled) => setScheduler({ enabled })} />
        <Stepper label="并发" value={scheduler.maxWorkers} min={1} max={8} disabled={busy} onChange={(maxWorkers) => setScheduler({ maxWorkers })} />
        <span className="border-l border-border-strong pl-3 font-mono text-faint-foreground">
          {workItems.filter((w) => w.status === "running").length} 进行中 · {workItems.filter((w) => w.status === "review").length} 待验收 · {workItems.filter((w) => !isOpenWorkItem(w)).length} 已结束
        </span>
        {hidden > 0 && <Button size="sm" variant="ghost" className="ml-auto underline underline-offset-4" onClick={onExpand}>另有 {hidden} 项已结束</Button>}
      </div>
      {error && <InlineNotice tone="error" className="pt-2">{error}</InlineNotice>}
      {visibleMissions.length === 0 && visibleStandalone.length === 0 ? <EmptyState title={compact && hidden > 0 ? "没有进行中的任务" : "还没有任务"} hint={hidden > 0 ? undefined : "去「思考」里和设计伙伴聊出一个。"} /> : (
        <div className="max-w-6xl space-y-4 p-4">
          {visibleMissions.map((mission) => {
            const steward = latestRuns.find((r) => r.role === "steward" && r.missionId === mission.missionId);
            const items = workItems.filter((w) => w.missionId === mission.missionId);
            return <div key={mission.missionId} data-task-id={mission.missionId}>
              <Card compact header={<>
                <Badge tone={mission.status === "active" ? "accent" : "neutral"}>{missionStatusLabel[mission.status]}</Badge>
                <span className="min-w-0 flex-1 truncate text-body font-medium text-strong" title={mission.title}>{mission.title}</span>
                <span className="shrink-0 font-mono text-caption text-faint-foreground" title={new Date(mission.updatedAt).toLocaleString("zh-CN")}>
                  {!compact && <span>{mission.revisions.length} 个 revision · {latestRevision(mission).commit.slice(0, 8)} · </span>}{relativeTime(mission.updatedAt)}
                </span>
                {steward && <SessionLink sessionId={steward.sessionId} onOpenSession={onOpenSession}>管家会话</SessionLink>}
                <IconButton icon={MoreHorizontal} label={"任务菜单：" + mission.title} onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.right - 176, y: rect.bottom, mission });
                }} />
              </>} rows={items.length > 0 && renderItems(items, mission.status !== "active")}>
                {(mission.summary || steward?.note) && <>
                  {mission.summary && <p className="line-clamp-2 text-label text-muted-foreground">{mission.summary}</p>}
                  {steward?.note && <p className="mt-1 truncate text-caption text-faint-foreground" title={steward.note}>管家：{steward.note}</p>}
                </>}
              </Card>
            </div>;
          })}
          {visibleStandalone.length > 0 && <section>
            <SectionLabel className="px-0 pt-0">独立工单</SectionLabel>
            <div className="overflow-hidden rounded-lg border border-border-strong bg-surface-raised">{renderItems(visibleStandalone)}</div>
          </section>}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} items={[{
        key: "cancel", label: "取消任务", disabled: busy || menu.mission.status !== "active", onSelect: () => void cancelMission(menu.mission)
      }]} />}
    </div>
  );
};
