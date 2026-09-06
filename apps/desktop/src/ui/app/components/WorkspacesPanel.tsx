import { CornerDownRight, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { latestRevision, type AgentRun, type DecisionCard, type Mission, type RoleFile, type Scheduler, type WorkItem, type WorkbenchClient } from "@vermillion/workbench/client";
import type { RendererStore } from "../../../store/store.js";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { SessionPane, formatRelativeCompletedTurnAge } from "../../chat-shell/index.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { useSessionSidebar, type SidebarSession } from "../use-session-sidebar.js";
import { cn } from "../lib/cn.js";
import { Badge, Button, Card, EmptyState, Field, IconButton, InlineNotice, ListRow, PanelHeader, SectionLabel, StatusDot } from "./ui.js";

type WorkspacesPanelProps = {
  store: WorkbenchStore;
  transport: DesktopTransport;
  sessionStore: RendererStore;
  pickDirectory: () => Promise<string | undefined>;
  /** Overlay = quick look: the task board lists only active missions and open standalone items. */
  compact: boolean;
};

/** Secondary navigation inside a workspace. Sections without a backing feature yet render a placeholder. */
type Section = "missions" | "sessions" | "domains" | "docs" | "roles" | "issues" | "automation";
const sections: Array<{ id: Section; label: string }> = [
  { id: "missions", label: "任务" },
  { id: "sessions", label: "会话" },
  { id: "domains", label: "Domain" },
  { id: "docs", label: "Docs" },
  { id: "roles", label: "角色" },
  { id: "issues", label: "Issues" },
  { id: "automation", label: "Automation" }
];

/** Domain definitions are plain docs under this folder; the steward reads them all when attaching standards to a work item. */
const DOMAINS_DIR = ".vermillion/docs/domains/";

export const WorkspacesPanel = ({ store, transport, sessionStore, pickDirectory, compact }: WorkspacesPanelProps) => {
  const client = store((s) => s.client);
  const agentSessionId = store((s) => s.agentSessionId);
  const showAgentSession = store((s) => s.showAgentSession);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const view = store((s) => s.view);
  const selectWorkspace = store((s) => s.browseWorkspace);
  const openEditor = store((s) => s.openEditor);
  const [section, setSection] = useState<Section>("missions");
  // A "会话" link elsewhere lands here on the 会话 tab.
  const [seenAgentSessionId, setSeenAgentSessionId] = useState(agentSessionId);
  if (agentSessionId !== seenAgentSessionId) {
    setSeenAgentSessionId(agentSessionId);
    if (agentSessionId) setSection("sessions");
  }
  const [error, setError] = useState<string | undefined>();

  const add = async () => {
    setError(undefined);
    const rootPath = await pickDirectory();
    if (!rootPath) return;
    try {
      const workspace = await client.request("workspace.add", { rootPath });
      selectWorkspace(workspace.workspaceId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const remove = async (workspaceId: string) => {
    await client.request("workspace.remove", { workspaceId });
  };

  return (
    <div className="flex h-full min-h-[360px]">
      <aside className="w-56 shrink-0 border-r border-border">
        <PanelHeader title="Workspaces">
          <IconButton icon={Plus} label="添加 workspace" onClick={() => void add()} />
        </PanelHeader>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <ul>
          {workspaces.map((workspace) => (
            <li key={workspace.workspaceId}>
              <ListRow
                title={workspace.label}
                meta={workspace.rootPath}
                selected={activeWorkspaceId === workspace.workspaceId}
                onClick={() => selectWorkspace(workspace.workspaceId)}
                hoverActions={<IconButton icon={Trash2} label={"移除 " + workspace.label} size={13} onClick={() => void remove(workspace.workspaceId)} />}
              />
            </li>
          ))}
        </ul>
        {workspaces.length === 0 && <InlineNotice>点右上角 + 添加一个目录</InlineNotice>}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {!activeWorkspaceId ? (
          <EmptyState title="选择一个 workspace" />
        ) : (
          <>
            <nav className="flex gap-1 border-b border-border px-3" aria-label="workspace 导航">
              {sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "-mb-px border-b px-2 py-2 text-label text-muted-foreground hover:text-foreground",
                    section === item.id ? "border-accent-strong text-strong" : "border-transparent"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto">
              {section === "missions" && view && (
                <MissionsSection client={client} workspaceId={activeWorkspaceId} scheduler={view.scheduler} missions={view.missions} workItems={view.workItems} runs={view.runs} onOpenSession={(id) => showAgentSession(activeWorkspaceId, id)} compact={compact} />
              )}
              {section === "sessions" && <AgentSessionsSection transport={transport} sessionStore={sessionStore} workspaceId={activeWorkspaceId} selected={agentSessionId} onSelect={(id) => showAgentSession(activeWorkspaceId, id)} />}
              {section === "docs" && <DocsSection docs={view?.docs.map((d) => d.path) ?? []} decisions={view?.decisions ?? []} onOpen={(path) => openEditor({ kind: "doc", path })} />}
              {section === "domains" && (
                <DomainsSection client={client} workspaceId={activeWorkspaceId} docs={view?.docs.map((d) => d.path) ?? []} onOpen={(path) => openEditor({ kind: "doc", path })} />
              )}
              {section === "roles" && (
                <RolesSection
                  client={client}
                  workspaceId={activeWorkspaceId}
                  roles={view?.roles ?? []}
                  onEdit={(roleId) => openEditor({ kind: "role", roleId })}
                />
              )}
              {section === "issues" && <EmptyState title="Issues 尚未提供" hint="来自 IM 和 Maintainer 的议题会在这里汇总，经思考流程转化为任务。" />}
              {section === "automation" && <EmptyState title="Automation 尚未提供" hint="定时任务和自定义触发器会在这里配置，例如每日检查依赖更新、按 webhook 建 issue。" />}
            </div>
          </>
        )}
      </section>
    </div>
  );
};

const agentRoleLabel: Record<string, string> = { steward: "管家", worker: "Worker", supervisor: "Supervisor" };

/**
 * Sessions the workbench started in this workspace (steward / worker / supervisor): a list on the left, the selected
 * session's transcript and composer on the right. Same reading surface as Think, scoped to agents.
 */
const AgentSessionsSection = ({ transport, sessionStore, workspaceId, selected, onSelect }: { transport: DesktopTransport; sessionStore: RendererStore; workspaceId: string; selected: string | undefined; onSelect: (sessionId: string) => void }) => {
  const workspaceIds = useMemo(() => [workspaceId], [workspaceId]);
  const { sessions, hasMore, loading, loadMore } = useSessionSidebar({ transport, store: sessionStore, workspaceIds, kind: "agent" });
  const renderRow = (session: SidebarSession, depth = 0) => (
    <li key={session.sessionId}>
      <ListRow
        depth={depth}
        selected={selected === session.sessionId}
        onClick={() => onSelect(session.sessionId)}
        leading={
          <>
            {depth > 0 && <CornerDownRight size={11} className="shrink-0 text-faint-foreground" aria-label="subagent" />}
            <StatusDot status={session.statusDot} />
            {session.role && <Badge>{agentRoleLabel[session.role] ?? session.role}</Badge>}
          </>
        }
        title={session.role ? session.title.replace(/^[^·]+ · /, "") : session.title}
        trailing={formatRelativeCompletedTurnAge(session.lastCompletedTurnAt ?? session.activityAt)}
      />
      {session.subagents.length > 0 && <ul>{session.subagents.map((child) => renderRow({ ...child, workspaceId, sortAt: session.sortAt }, depth + 1))}</ul>}
    </li>
  );
  return (
    <div className="flex h-full">
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-border">
        {sessions.length === 0 && !loading ? (
          <EmptyState title="还没有 agent 会话" hint="管家、Worker 和 Supervisor 的会话会出现在这里。" />
        ) : (
          <ul className="min-h-0 flex-1 overflow-auto py-1">
            {sessions.map((session) => renderRow(session))}
            {hasMore && <li className="px-3 py-2"><Button size="sm" variant="ghost" className="w-full" disabled={loading} onClick={() => void loadMore()}>{loading ? "加载中…" : "加载更多"}</Button></li>}
          </ul>
        )}
      </aside>
      <main className="relative min-w-0 flex-1">
        {selected ? (
          <SessionPane store={sessionStore} transport={transport} sessionId={selected} createSession={async () => { throw new Error("Agent sessions are started by the workbench."); }} />
        ) : (
          <EmptyState title="选择一个会话" hint="左侧是这个 workspace 里 agent 的会话。" />
        )}
      </main>
    </div>
  );
};

const missionStatusLabel: Record<Mission["status"], string> = { active: "进行中", done: "已完成", cancelled: "已取消" };
const statusLabel: Record<WorkItem["status"], string> = { queued: "排队中", running: "进行中", review: "待验收", decision: "待决策", closed: "已关闭", cancelled: "已取消" };

const roleLabel: Record<AgentRun["role"], string> = { steward: "管家", worker: "Worker", supervisor: "Supervisor" };
const runStatusLabel: Record<AgentRun["status"], string> = { running: "运行中", done: "完成", failed: "失败" };

const SessionLink = ({ sessionId, onOpenSession }: { sessionId: string; onOpenSession: (sessionId: string) => void }) => (
  <Button size="sm" variant="ghost" onClick={() => onOpenSession(sessionId)}>会话</Button>
);

const isOpen = (w: WorkItem) => w.status !== "closed" && w.status !== "cancelled";

/** One work item with the agent runs that touched it, newest first. */
const WorkItemRow = ({ item, runs, waitingFor, onOpenSession, onCancel }: { item: WorkItem; runs: AgentRun[]; waitingFor: string[]; onOpenSession: (sessionId: string) => void; onCancel: () => void }) => (
  <li className="rounded-md border border-border px-3 py-2">
    <div className="flex items-center gap-2">
      <Badge>{item.risk}</Badge>
      <span className="truncate text-label text-strong">{item.title}</span>
      <span className="ml-auto shrink-0 font-mono text-caption text-faint-foreground">{statusLabel[item.status]}{waitingFor.length > 0 ? " · 等待 " + waitingFor.join("、") : ""}{item.rejections.length > 0 ? " · 打回 " + item.rejections.length : ""}{item.run.lastFailure ? " · " + item.run.lastFailure : ""}</span>
      {item.run.sessionId && (item.status === "running" || item.status === "review") && <SessionLink sessionId={item.run.sessionId} onOpenSession={onOpenSession} />}
      {isOpen(item) && <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>}
    </div>
    {runs.length > 0 && (
      <ul className="ml-1 mt-1.5 space-y-1 border-l border-border pl-3">
        {runs.map((run) => (
          <li key={run.runId} className="flex items-center gap-2 text-caption text-muted-foreground">
            <Badge>{roleLabel[run.role]}</Badge>
            <span className="truncate">{run.note ?? ""}</span>
            <span className="ml-auto shrink-0 font-mono text-faint-foreground">{runStatusLabel[run.status]} · {run.turns} turn · {new Date(run.startedAt).toLocaleTimeString()}</span>
            <SessionLink sessionId={run.sessionId} onOpenSession={onOpenSession} />
          </li>
        ))}
      </ul>
    )}
  </li>
);

type MissionsSectionProps = {
  client: WorkbenchClient;
  workspaceId: string;
  scheduler: Scheduler;
  missions: Mission[];
  workItems: WorkItem[];
  runs: AgentRun[];
  onOpenSession: (sessionId: string) => void;
  compact: boolean;
};

const MissionsSection = ({ client, workspaceId, scheduler, missions, workItems, runs, onOpenSession, compact }: MissionsSectionProps) => {
  const setScheduler = (value: Partial<Scheduler>) => void client.request("scheduler.set", { workspaceId, value: { ...scheduler, ...value } });
  const cancelItem = (item: WorkItem) => void client.request("workItem.cancel", { workspaceId, workItemId: item.workItemId });
  /** Cancelling a mission also cancels every open work item under it, so nothing keeps running for a dropped goal. */
  const cancelMission = async (mission: Mission) => {
    for (const item of workItems.filter((w) => w.missionId === mission.missionId && isOpen(w))) {
      await client.request("workItem.cancel", { workspaceId, workItemId: item.workItemId });
    }
    await client.request("mission.setStatus", { workspaceId, missionId: mission.missionId, status: "cancelled" });
  };
  const runsFor = (item: WorkItem) => runs.filter((r) => r.workItemId === item.workItemId);
  const waitingFor = (item: WorkItem) =>
    item.status === "queued"
      ? item.dependsOn.map((id) => workItems.find((w) => w.workItemId === id)).filter((w) => w?.status !== "closed").map((w, i) => (w ? w.title + (w.status === "cancelled" ? "（已取消）" : "") : item.dependsOn[i]!))
      : [];
  const stewardRuns = (mission: Mission) => runs.filter((r) => r.role === "steward" && r.missionId === mission.missionId);
  const standalone = workItems.filter((w) => !w.missionId);
  const visibleMissions = compact ? missions.filter((m) => m.status === "active") : missions;
  const visibleStandalone = compact ? standalone.filter(isOpen) : standalone;
  const hidden = missions.length - visibleMissions.length + (standalone.length - visibleStandalone.length);
  const renderItems = (items: WorkItem[]) => (
    <ul className="mt-3 space-y-1.5">
      {items.map((item) => <WorkItemRow key={item.workItemId} item={item} runs={runsFor(item)} waitingFor={waitingFor(item)} onOpenSession={onOpenSession} onCancel={() => cancelItem(item)} />)}
    </ul>
  );
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Button size="sm" variant={scheduler.enabled ? "accent" : "secondary"} onClick={() => setScheduler({ enabled: !scheduler.enabled })}>{scheduler.enabled ? "调度已开启" : "调度已关闭"}</Button>
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-caption text-muted-foreground">
          并发 Worker
          <Field type="number" min={1} max={8} value={scheduler.maxWorkers} onChange={(e) => setScheduler({ maxWorkers: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} className="w-14 [&>input]:h-7" />
        </label>
        <span className="truncate text-caption text-faint-foreground">开启后新 revision 触发管家拆单，排队工单由 Worker 接手。</span>
        {hidden > 0 && <span className="ml-auto shrink-0 text-caption text-faint-foreground">另有 {hidden} 项已结束，展开为页面查看</span>}
      </div>
      {missions.length === 0 && standalone.length === 0 && <EmptyState title="还没有任务" hint="去「思考」里和设计伙伴聊出一个。" />}
      <ul className="space-y-3 p-4">
        {visibleMissions.map((mission) => {
          const items = workItems.filter((w) => w.missionId === mission.missionId);
          const steward = stewardRuns(mission)[0];
          return (
            <li key={mission.missionId}>
              <Card
                header={
                  <>
                    <Badge tone={mission.status === "active" ? "accent" : "neutral"}>{missionStatusLabel[mission.status]}</Badge>
                    <span className="truncate text-label font-medium text-strong">{mission.title}</span>
                    {steward?.status === "running" && <span className="shrink-0 font-mono text-caption text-muted-foreground">管家处理中</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {steward && <SessionLink sessionId={steward.sessionId} onOpenSession={onOpenSession} />}
                      {mission.status === "active" && <Button size="sm" variant="ghost" onClick={() => void cancelMission(mission)}>取消任务</Button>}
                    </span>
                  </>
                }
              >
                {mission.summary && <p className="line-clamp-3 text-label text-muted-foreground">{mission.summary}</p>}
                <p className="mt-1.5 font-mono text-caption text-faint-foreground">{mission.revisions.length} 个 revision · 最新 {latestRevision(mission).commit.slice(0, 8)} · {new Date(mission.updatedAt).toLocaleString()}</p>
                {steward?.note && <p className="mt-1.5 line-clamp-2 text-label text-muted-foreground">管家：{steward.note}</p>}
                {items.length > 0 && renderItems(items)}
              </Card>
            </li>
          );
        })}
        {visibleStandalone.length > 0 && (
          <li>
            <Card header={<><Badge>不经文档</Badge><span className="text-label font-medium text-strong">独立工单</span></>}>
              {renderItems(visibleStandalone)}
            </Card>
          </li>
        )}
      </ul>
    </div>
  );
};

const DOMAIN_TEMPLATE = `---
standards:
  - .vermillion/docs/<业务>/Standards.md
---
# <领域名>

## 覆盖什么

## 什么样的改动应该考虑它
`;

const DomainsSection = ({ client, workspaceId, docs, onOpen }: { client: WorkbenchClient; workspaceId: string; docs: string[]; onOpen: (path: string) => void }) => {
  const [draft, setDraft] = useState("");
  const domains = docs.filter((p) => p.startsWith(DOMAINS_DIR) && p.endsWith(".md"));
  const create = async () => {
    const id = draft.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!id) return;
    const path = DOMAINS_DIR + id + ".md";
    await client.request("docs.write", { workspaceId, path, content: DOMAIN_TEMPLATE });
    setDraft("");
    onOpen(path);
  };
  return (
    <div>
      <PanelHeader title="Domain">
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="领域 id" className="w-36 [&>input]:h-7" />
          <IconButton icon={Plus} label="新建领域" type="submit" disabled={!draft.trim()} />
        </form>
      </PanelHeader>
      <InlineNotice>每个领域一份 md：正文说明覆盖什么、什么改动该考虑它，头部 standards 列规范路径。管家建单时读全部定义，判断涉及的领域并把规范附进工单。</InlineNotice>
      {domains.length === 0 ? (
        <InlineNotice>还没有领域定义。</InlineNotice>
      ) : (
        <ul>
          {domains.map((path) => (
            <li key={path}><ListRow title={path.slice(DOMAINS_DIR.length, -3)} meta={path} onClick={() => onOpen(path)} /></li>
          ))}
        </ul>
      )}
    </div>
  );
};

const roleSourceLabel: Record<RoleFile["source"], string> = { global: "全局", workspace: "本 workspace" };

const RolesSection = ({ client, workspaceId, roles, onEdit }: { client: WorkbenchClient; workspaceId: string; roles: RoleFile[]; onEdit: (roleId: string) => void }) => (
  <div>
    <SectionLabel>角色 prompt</SectionLabel>
    <InlineNotice>选择角色后，可设置覆盖方式和模型配置并编辑正文。修改保存到本 workspace；override 替换全局正文，append 在全局正文后追加。</InlineNotice>
    <ul>
      {roles.map((role) => (
        <li key={role.roleId}>
          <ListRow
            title={role.title}
            leading={<Badge tone={role.source === "workspace" ? "accent" : "neutral"}>{roleSourceLabel[role.source]}</Badge>}
            meta={role.roleId + ".md"}
            onClick={() => onEdit(role.roleId)}
            hoverActions={
              role.source === "workspace" ? (
                <Button size="sm" variant="ghost" onClick={() => void client.request("role.reset", { workspaceId, roleId: role.roleId })}>恢复全局</Button>
              ) : undefined
            }
          />
        </li>
      ))}
    </ul>
  </div>
);

const DocsSection = ({ docs, decisions, onOpen }: { docs: string[]; decisions: DecisionCard[]; onOpen: (path: string) => void }) => (
  <div>
    <SectionLabel>文档</SectionLabel>
    {docs.length === 0 ? (
      <InlineNotice>.vermillion/docs 下还没有文件。</InlineNotice>
    ) : (
      <ul>
        {docs.map((path) => (
          <li key={path}>
            <ListRow title={path.replace(/^\.vermillion\/docs\//, "")} titleClassName="font-normal text-foreground" onClick={() => onOpen(path)} className="py-1" />
          </li>
        ))}
      </ul>
    )}
    <SectionLabel>决策记录</SectionLabel>
    {decisions.length === 0 ? (
      <InlineNotice>还没有决策卡。</InlineNotice>
    ) : (
      <ul>
        {decisions.map((card) => (
          <li key={card.decisionId}>
            <ListRow title={card.question} titleClassName="font-normal text-foreground" trailing={card.answer ? "→ " + (card.options.find((o) => o.key === card.answer!.key)?.label ?? card.answer.key) : "待回答"} />
          </li>
        ))}
      </ul>
    )}
  </div>
);
