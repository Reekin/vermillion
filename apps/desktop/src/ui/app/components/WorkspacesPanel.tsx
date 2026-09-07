import { ChevronDown, CornerDownRight, Pin, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { type DecisionCard, type RoleFile, type WorkbenchClient } from "@vermillion/workbench/client";
import type { RendererStore } from "../../../store/store.js";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { SessionPane, formatRelativeCompletedTurnAge } from "../../chat-shell/index.js";
import type { WorkbenchStore, WorkspaceSection } from "../workbench-store.js";
import { useSessionSidebar, type SidebarSession } from "../use-session-sidebar.js";
import { useSessionActions } from "../use-session-actions.js";
import { SessionActionFeedback } from "./SessionActionFeedback.js";
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ListRow, PanelHeader, SectionLabel, StatusDot, Tabs } from "./ui.js";
import { ContextMenu } from "./ContextMenu.js";
import { isOpenWorkItem, MissionsSection } from "./MissionsSection.js";

type WorkspacesPanelProps = {
  store: WorkbenchStore;
  transport: DesktopTransport;
  sessionStore: RendererStore;
  pickDirectory: () => Promise<string | undefined>;
  /** Overlay = quick look: the task board lists only active missions and open standalone items. */
  compact: boolean;
  onExpand: () => void;
};

/** Secondary navigation inside a workspace. Sections without a backing feature yet render a placeholder. */
const sections: Array<{ id: WorkspaceSection; label: string }> = [
  { id: "missions", label: "任务" },
  { id: "sessions", label: "会话" },
  { id: "docs", label: "Docs" },
  { id: "domains", label: "Domain" },
  { id: "roles", label: "角色" },
  { id: "issues", label: "Issues" },
  { id: "automation", label: "Automation" }
];

/** Domain definitions are plain docs under this folder; the steward reads them all when attaching standards to a work item. */
const DOMAINS_DIR = ".vermillion/docs/domains/";

export const WorkspacesSwitcher = ({ store }: { store: WorkbenchStore }) => {
  const workspaces = store((s) => s.workspaces);
  const selected = store((s) => s.browsingWorkspaceId);
  const browseWorkspace = store((s) => s.browseWorkspace);
  return <Field kind="select" compact aria-label="切换 workspace" className="min-w-0 max-w-md flex-1" value={selected ?? ""} onChange={(e) => browseWorkspace(e.target.value)}>
    {!selected && <option value="">选择 workspace</option>}
    {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.label} · {workspace.rootPath}</option>)}
  </Field>;
};

export const WorkspacesPanel = ({ store, transport, sessionStore, pickDirectory, compact, onExpand }: WorkspacesPanelProps) => {
  const client = store((s) => s.client);
  const agentSessionId = store((s) => s.agentSessionId);
  const taskTarget = store((s) => s.taskTarget);
  const showAgentSession = store((s) => s.showAgentSession);
  const selectAgentSession = store((s) => s.selectAgentSession);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const view = store((s) => s.view);
  const viewError = store((s) => s.viewError);
  const selectWorkspace = store((s) => s.browseWorkspace);
  const openEditor = store((s) => s.openEditor);
  const section = store((s) => s.workspaceSection);
  const setSection = store((s) => s.setWorkspaceSection);
  const [more, setMore] = useState<{ x: number; y: number }>();
  const [error, setError] = useState<string | undefined>();
  const taskCount = view ? view.missions.filter((m) => m.status === "active").length + view.workItems.filter((w) => !w.missionId && isOpenWorkItem(w)).length : 0;
  const sessionCount = new Set(view?.runs.filter((r) => r.status === "running").map((r) => r.sessionId)).size;
  const mainSections = sections.filter((s) => ["missions", "sessions", "docs", "issues"].includes(s.id));
  const moreSections = sections.filter((s) => !mainSections.includes(s));

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
      {!compact && <aside className="w-56 shrink-0 overflow-auto border-r border-border">
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
                hoverActions={<IconButton icon={X} label={"移除 " + workspace.label} size={13} onClick={() => void remove(workspace.workspaceId)} />}
              />
            </li>
          ))}
        </ul>
        {workspaces.length === 0 && <InlineNotice>点右上角 + 添加一个目录</InlineNotice>}
      </aside>}
      <section className="flex min-w-0 flex-1 flex-col">
        {!activeWorkspaceId ? (
          <EmptyState title="选择一个 workspace" action={<Button onClick={() => void add()}>添加 workspace</Button>} />
        ) : (
          <>
            <Tabs items={(compact ? mainSections : sections).map((item) => ({ ...item, count: item.id === "missions" ? taskCount : item.id === "sessions" ? sessionCount : undefined }))} selected={section} onSelect={(id) => setSection(id as WorkspaceSection)}>
              {compact && <button type="button" className="ml-auto flex items-center gap-1" aria-haspopup="menu" aria-expanded={!!more} aria-current={moreSections.some((s) => s.id === section) ? "page" : undefined} onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMore({ x: rect.right - 176, y: rect.bottom });
              }}>{moreSections.find((s) => s.id === section)?.label ?? "更多"}<ChevronDown size={12} /></button>}
            </Tabs>
            {more && <ContextMenu {...more} onClose={() => setMore(undefined)} items={moreSections.map((item) => ({ key: item.id, label: item.label, onSelect: () => setSection(item.id) }))} />}
            <div className="min-h-0 flex-1 overflow-auto">
              {section === "missions" && viewError ? <EmptyState title="任务加载失败" hint={viewError} /> : section === "missions" && view && (
                <MissionsSection key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} scheduler={view.scheduler} missions={view.missions} workItems={view.workItems} runs={view.runs} onOpenSession={(id) => showAgentSession(activeWorkspaceId, id)} compact={compact} onExpand={onExpand} taskTarget={taskTarget?.workspaceId === activeWorkspaceId ? taskTarget : undefined} />
              )}
              {section === "sessions" && <AgentSessionsSection transport={transport} sessionStore={sessionStore} workspaceId={activeWorkspaceId} selected={agentSessionId} onSelect={selectAgentSession} compact={compact} />}
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
const AgentSessionsSection = ({ transport, sessionStore, workspaceId, selected, onSelect, compact }: { transport: DesktopTransport; sessionStore: RendererStore; workspaceId: string; selected: string | undefined; onSelect: (sessionId: string | undefined) => void; compact: boolean }) => {
  const workspaceIds = useMemo(() => [workspaceId], [workspaceId]);
  const { sessions, hasMore, loading, loadMore, reload, findSession } = useSessionSidebar({ transport, store: sessionStore, workspaceIds, kind: "agent" });
  const [reloadSignal, setReloadSignal] = useState(0);
  const actions = useSessionActions({
    transport,
    reloadSidebar: reload,
    onArchived: (id) => { if (selected === id || (selected && findSession(selected)?.sessionId === id)) onSelect(undefined); },
    onResumed: () => setReloadSignal((n) => n + 1)
  });
  const renderRow = (session: SidebarSession, depth = 0) => (
    <li key={session.sessionId}>
      <ListRow
        depth={depth}
        selected={selected === session.sessionId || Boolean(selected && session.memberSessionIds?.includes(selected))}
        onClick={() => onSelect(session.sessionId)}
        onContextMenu={(event) => void actions.openMenu(event, session.sessionId)}
        leading={
          <>
            {depth > 0 && <CornerDownRight size={11} className="shrink-0 text-faint-foreground" aria-label="subagent" />}
            <StatusDot status={session.statusDot} />
            {session.role && <Badge>{agentRoleLabel[session.role] ?? session.role}</Badge>}
          </>
        }
        title={<>{session.role ? session.title.replace(/^[^·]+ · /, "") : session.title}{session.isPinned && <Pin size={11} className="ml-1 inline shrink-0 text-faint-foreground" aria-label="pinned" />}</>}
        trailing={formatRelativeCompletedTurnAge(session.lastCompletedTurnAt ?? session.activityAt)}
      />
      {session.subagents.length > 0 && <ul>{session.subagents.map((child) => renderRow({ ...child, workspaceId, sortAt: session.sortAt }, depth + 1))}</ul>}
    </li>
  );
  return (
    <div className="flex h-full">
      <aside className="flex w-1/3 min-w-0 max-w-80 shrink-0 flex-col border-r border-border">
        {sessions.length === 0 && !loading ? (
          <EmptyState title="还没有 agent 会话" hint="管家、Worker 和 Supervisor 的会话会出现在这里。" />
        ) : (
          <ul className="min-h-0 flex-1 overflow-auto py-1">
            {sessions.map((session) => renderRow(session))}
            {hasMore && <li className="px-3 py-2"><Button size="sm" variant="ghost" className="w-full" disabled={loading} onClick={() => void loadMore()}>{loading ? "加载中…" : "加载更多"}</Button></li>}
          </ul>
        )}
        <SessionActionFeedback menu={actions.menu} onCloseMenu={actions.closeMenu} onRunAction={(id, action) => void actions.run(id, action)} notice={actions.notice} onClearNotice={actions.clearNotice} />
      </aside>
      <main className="relative min-w-0 flex-1">
        {selected ? (
          <SessionPane store={sessionStore} transport={transport} sessionId={selected} reloadSignal={reloadSignal} allowChatTree={!compact} createSession={async () => { throw new Error("Agent sessions are started by the workbench."); }} />
        ) : (
          <EmptyState title="选择一个会话" hint="左侧是这个 workspace 里 agent 的会话。" />
        )}
      </main>
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
