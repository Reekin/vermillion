import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { latestRevision, type AgentRun, type DecisionCard, type Mission, type RoleFile, type Scheduler, type WorkItem, type WorkbenchClient } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { Badge, Button, Empty, SectionLabel } from "./ui.js";

type WorkspacesPanelProps = {
  store: WorkbenchStore;
  pickDirectory: () => Promise<string | undefined>;
  /** Opens a session in the think page (used to look into agent runs). */
  onOpenSession: (sessionId: string) => void;
};

/** Secondary navigation inside a workspace. Sections without a backing feature yet render a placeholder. */
type Section = "missions" | "domains" | "docs" | "roles" | "issues" | "automation";
const sections: Array<{ id: Section; label: string }> = [
  { id: "missions", label: "任务" },
  { id: "domains", label: "Domain" },
  { id: "docs", label: "Docs" },
  { id: "roles", label: "角色" },
  { id: "issues", label: "Issues" },
  { id: "automation", label: "Automation" }
];

/** Domain definitions are plain docs under this folder; the steward reads them all when attaching standards to a work item. */
const DOMAINS_DIR = ".vermillion/docs/domains/";

export const WorkspacesPanel = ({ store, pickDirectory, onOpenSession }: WorkspacesPanelProps) => {
  const client = store((s) => s.client);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const view = store((s) => s.view);
  const selectWorkspace = store((s) => s.browseWorkspace);
  const openEditor = store((s) => s.openEditor);
  const [section, setSection] = useState<Section>("missions");
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
        <div className="flex items-center pr-2">
          <SectionLabel>Workspaces</SectionLabel>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void add()} title="添加 workspace"><Plus size={14} /></Button>
        </div>
        {error && <p className="px-4 pb-2 text-caption text-muted-foreground">{error}</p>}
        <ul>
          {workspaces.map((workspace) => (
            <li key={workspace.workspaceId} className="group flex items-center">
              <button
                type="button"
                onClick={() => selectWorkspace(workspace.workspaceId)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col px-4 py-1.5 text-left hover:bg-surface-hover",
                  activeWorkspaceId === workspace.workspaceId && "bg-surface-selected"
                )}
              >
                <span className="truncate text-label text-strong">{workspace.label}</span>
                <span className="truncate font-mono text-micro text-faint-foreground">{workspace.rootPath}</span>
              </button>
              <button type="button" aria-label={"移除 " + workspace.label} className="mr-2 hidden rounded-md p-1 text-faint-foreground hover:bg-surface-hover hover:text-strong group-hover:block" onClick={() => void remove(workspace.workspaceId)}><Trash2 size={13} /></button>
            </li>
          ))}
          {workspaces.length === 0 && <li className="px-4 py-2 text-caption text-muted-foreground">点右上角 + 添加一个目录</li>}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {!activeWorkspaceId ? (
          <Empty title="选择一个 workspace" />
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
                <MissionsSection client={client} workspaceId={activeWorkspaceId} scheduler={view.scheduler} missions={view.missions} workItems={view.workItems} runs={view.runs} onOpenSession={onOpenSession} />
              )}
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
              {section === "issues" && <Empty title="Issues 尚未提供" hint="来自 IM 和 Maintainer 的议题会在这里汇总，经思考流程转化为任务。" />}
              {section === "automation" && <Empty title="Automation 尚未提供" hint="定时任务和自定义触发器会在这里配置，例如每日检查依赖更新、按 webhook 建 issue。" />}
            </div>
          </>
        )}
      </section>
    </div>
  );
};

const missionStatusLabel: Record<Mission["status"], string> = { active: "进行中", done: "已完成", cancelled: "已取消" };
const statusLabel: Record<WorkItem["status"], string> = { queued: "排队中", running: "进行中", review: "待验收", decision: "待决策", closed: "已关闭", cancelled: "已取消" };

const roleLabel: Record<AgentRun["role"], string> = { steward: "管家", worker: "Worker", supervisor: "Supervisor" };
const runStatusLabel: Record<AgentRun["status"], string> = { running: "运行中", done: "完成", failed: "失败" };

const SessionLink = ({ sessionId, onOpenSession }: { sessionId: string; onOpenSession: (sessionId: string) => void }) => (
  <button type="button" className="shrink-0 text-micro text-muted-foreground underline-offset-2 hover:text-strong hover:underline" onClick={() => onOpenSession(sessionId)}>会话</button>
);

/** One work item with the agent runs that touched it, newest first. */
const WorkItemRow = ({ item, runs, waitingFor, onOpenSession }: { item: WorkItem; runs: AgentRun[]; waitingFor: string[]; onOpenSession: (sessionId: string) => void }) => (
  <li className="text-caption">
    <div className="flex items-center gap-2">
      <Badge>{item.risk}</Badge>
      <span className="truncate text-foreground">{item.title}</span>
      {item.run.sessionId && (item.status === "running" || item.status === "review") && <SessionLink sessionId={item.run.sessionId} onOpenSession={onOpenSession} />}
      <span className="ml-auto shrink-0 font-mono text-micro text-faint-foreground">{statusLabel[item.status]}{waitingFor.length > 0 ? " · 等待 " + waitingFor.join("、") : ""}{item.rejections.length > 0 ? " · 打回 " + item.rejections.length : ""}{item.run.lastFailure ? " · " + item.run.lastFailure : ""}</span>
    </div>
    {runs.length > 0 && (
      <ul className="ml-2 mt-1 space-y-0.5 border-l border-border pl-3">
        {runs.map((run) => (
          <li key={run.runId} className="flex items-center gap-2 text-micro text-muted-foreground">
            <span className="font-mono uppercase tracking-[0.12em]">{roleLabel[run.role]}</span>
            <span className="truncate">{run.note ?? ""}</span>
            <SessionLink sessionId={run.sessionId} onOpenSession={onOpenSession} />
            <span className="ml-auto shrink-0 font-mono text-faint-foreground">{runStatusLabel[run.status]} · {run.turns} turn · {new Date(run.startedAt).toLocaleTimeString()}</span>
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
};

const MissionsSection = ({ client, workspaceId, scheduler, missions, workItems, runs, onOpenSession }: MissionsSectionProps) => {
  const setScheduler = (value: Partial<Scheduler>) => void client.request("scheduler.set", { workspaceId, value: { ...scheduler, ...value } });
  const runsFor = (item: WorkItem) => runs.filter((r) => r.workItemId === item.workItemId);
  const titleById = new Map(workItems.map((w) => [w.workItemId, w.title]));
  const waitingFor = (item: WorkItem) =>
    item.status === "queued"
      ? item.dependsOn.map((id) => workItems.find((w) => w.workItemId === id)).filter((w) => w?.status !== "closed").map((w, i) => (w ? w.title + (w.status === "cancelled" ? "（已取消）" : "") : item.dependsOn[i]!))
      : [];
  const stewardRuns = (mission: Mission) => runs.filter((r) => r.role === "steward" && r.missionId === mission.missionId);
  const standalone = workItems.filter((w) => !w.missionId);
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Button size="sm" variant={scheduler.enabled ? "accent" : "secondary"} onClick={() => setScheduler({ enabled: !scheduler.enabled })}>{scheduler.enabled ? "调度已开启" : "调度已关闭"}</Button>
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-caption text-muted-foreground">
          并发 Worker
          <input type="number" min={1} max={8} value={scheduler.maxWorkers} onChange={(e) => setScheduler({ maxWorkers: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} className="w-12 border border-border bg-input px-1.5 py-0.5 text-label text-foreground outline-none" />
        </label>
        <span className="truncate text-caption text-faint-foreground">开启后新 revision 触发管家拆单，排队工单由 Worker 接手。</span>
      </div>
      {missions.length === 0 && standalone.length === 0 && <p className="px-4 py-3 text-caption text-muted-foreground">还没有任务。去「思考」里和设计伙伴聊出一个。</p>}
      <ul>
        {missions.map((mission) => {
          const items = workItems.filter((w) => w.missionId === mission.missionId);
          const stewards = stewardRuns(mission);
          return (
            <li key={mission.missionId} className="border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="truncate text-label text-strong">{mission.title}</span>
                <Badge tone={mission.status === "active" ? "accent" : "neutral"}>{missionStatusLabel[mission.status]}</Badge>
                {stewards[0] && <SessionLink sessionId={stewards[0].sessionId} onOpenSession={onOpenSession} />}
                {stewards[0]?.status === "running" && <span className="font-mono text-micro text-muted-foreground">管家处理中</span>}
              </div>
              {mission.summary && <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">{mission.summary}</p>}
              <p className="mt-1 font-mono text-micro text-faint-foreground">{mission.revisions.length} 个 revision · 最新 {latestRevision(mission).commit.slice(0, 8)} · {new Date(mission.updatedAt).toLocaleString()}</p>
              {stewards[0]?.note && <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">管家：{stewards[0].note}</p>}
              {items.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {items.map((item) => <WorkItemRow key={item.workItemId} item={item} runs={runsFor(item)} waitingFor={waitingFor(item)} onOpenSession={onOpenSession} />)}
                </ul>
              )}
            </li>
          );
        })}
        {standalone.length > 0 && (
          <li className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-label text-strong">独立工单</span>
              <Badge>不经文档</Badge>
            </div>
            <ul className="mt-2 space-y-1.5">
              {standalone.map((item) => <WorkItemRow key={item.workItemId} item={item} runs={runsFor(item)} waitingFor={waitingFor(item)} onOpenSession={onOpenSession} />)}
            </ul>
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
      <div className="flex items-center pr-2">
        <SectionLabel>Domain</SectionLabel>
        <form className="ml-auto flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="新领域 id，如 ui-ux" className="w-40 border border-border bg-input px-1.5 py-0.5 text-label text-foreground outline-none" />
          <Button size="sm" variant="ghost" type="submit" disabled={!draft.trim()} title="新建领域"><Plus size={14} /></Button>
        </form>
      </div>
      <p className="px-4 pb-2 text-caption text-muted-foreground">每个领域一份 md：正文说明覆盖什么、什么改动该考虑它，头部 standards 列规范路径。管家建单时读全部定义，判断涉及的领域并把规范附进工单。</p>
      {domains.length === 0 ? (
        <p className="px-4 pb-3 text-caption text-muted-foreground">还没有领域定义。</p>
      ) : (
        <ul>
          {domains.map((path) => (
            <li key={path}>
              <button type="button" onClick={() => onOpen(path)} className="block w-full truncate px-4 py-1.5 text-left text-label text-foreground hover:bg-surface-hover">{path.slice(DOMAINS_DIR.length, -3)}</button>
            </li>
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
    <p className="px-4 pb-2 text-caption text-muted-foreground">全局版本在 ~/.vermillion/roles；在这里编辑会写入本 workspace 的 .vermillion/roles 作为覆盖。</p>
    <ul>
      {roles.map((role) => (
        <li key={role.roleId} className="group flex items-center gap-2 border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-label text-strong">{role.title}</span>
              <Badge tone={role.source === "workspace" ? "accent" : "neutral"}>{roleSourceLabel[role.source]}</Badge>
            </div>
            <span className="font-mono text-micro text-faint-foreground">{role.roleId}.md</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onEdit(role.roleId)}>{role.source === "workspace" ? "编辑" : "覆盖"}</Button>
          {role.source === "workspace" && (
            <Button size="sm" variant="ghost" onClick={() => void client.request("role.reset", { workspaceId, roleId: role.roleId })}>恢复全局</Button>
          )}
        </li>
      ))}
    </ul>
  </div>
);

const DocsSection = ({ docs, decisions, onOpen }: { docs: string[]; decisions: DecisionCard[]; onOpen: (path: string) => void }) => (
  <div>
    <SectionLabel>文档</SectionLabel>
    {docs.length === 0 ? (
      <p className="px-4 pb-2 text-caption text-muted-foreground">.vermillion/docs 下还没有文件。</p>
    ) : (
      <ul>
        {docs.map((path) => (
          <li key={path}>
            <button type="button" onClick={() => onOpen(path)} className="block w-full truncate px-4 py-1 text-left font-mono text-caption text-foreground hover:bg-surface-hover">{path.replace(/^\.vermillion\/docs\//, "")}</button>
          </li>
        ))}
      </ul>
    )}
    <SectionLabel>决策记录</SectionLabel>
    {decisions.length === 0 ? (
      <p className="px-4 pb-3 text-caption text-muted-foreground">还没有决策卡。</p>
    ) : (
      <ul>
        {decisions.map((card) => (
          <li key={card.decisionId} className="px-4 py-1.5 text-caption">
            <span className="text-foreground">{card.question}</span>
            <span className="ml-2 font-mono text-micro text-faint-foreground">{card.answer ? "→ " + (card.options.find((o) => o.key === card.answer!.key)?.label ?? card.answer.key) : "待回答"}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);
