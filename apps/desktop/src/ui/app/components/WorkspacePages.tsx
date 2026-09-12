import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type DecisionCard, type DomainConfig, type DomainDefinition, type PatrolRun, type RoleFile, type WorkbenchClient, type WorkItem } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ListRow, PanelHeader, SectionLabel, Toggle } from "./ui.js";
import { WorkItemsSection } from "./WorkItemsSection.js";
import { IssuesSection } from "./IssuesSection.js";
import { Modal } from "./Modal.js";

type WorkspacePagesProps = {
  store: WorkbenchStore;
  transport: DesktopTransport;
  pickDirectory: () => Promise<string | undefined>;
  workItemTarget?: { workspaceId: string; workItemId: string; nonce: number };
  onWorkItemTargetConsumed?: () => void;
};

const DOMAINS_DIR = ".vermillion/docs/domains/";

export const WorkspaceSwitcher = ({ store }: { store: WorkbenchStore }) => {
  const client = store((s) => s.client);
  const workspaces = store((s) => s.workspaces);
  const selected = store((s) => s.browsingWorkspaceId);
  const browseWorkspace = store((s) => s.browseWorkspace);
  const [error, setError] = useState<string>();
  const workspace = workspaces.find((item) => item.workspaceId === selected);
  const remove = async () => {
    if (!selected) return;
    setError(undefined);
    try {
      await client.request("workspace.remove", { workspaceId: selected });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return <div className="group flex min-w-0 max-w-md flex-1 flex-col">
    <div className="flex min-w-0 items-center gap-1">
      <Field kind="select" compact aria-label="切换 workspace" className="min-w-0 flex-1" value={selected ?? ""} onChange={(e) => { setError(undefined); browseWorkspace(e.target.value); }}>
        {!selected && <option value="">选择 workspace</option>}
        {workspaces.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.label} · {item.rootPath}</option>)}
      </Field>
      {workspace && <IconButton icon={X} label={"移除 " + workspace.label} className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => void remove()} />}
    </div>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
  </div>;
};

export const loadSourceTreeTitles = async (
  list: DesktopTransport["sessionBrowser"]["list"], workspaceId: string,
  workItems: Pick<WorkItem, "treeId" | "sourceSessionId">[]
): Promise<Record<string, string>> => {
  const pending = new Map(workItems.flatMap((item) => item.treeId ? [[item.treeId, item.sourceSessionId] as const] : []));
  const titles: Record<string, string> = {};
  let cursor: string | undefined;
  let expectedRevision: string | undefined;
  while (pending.size) {
    const page = await list({ workspaceId, kind: "user", limit: 100, cursor, expectedRevision });
    for (const session of page.items) {
      const ids = new Set([session.sessionId, ...(session.memberSessionIds ?? [])]);
      for (const [treeId, sourceId] of pending) {
        if (ids.has(treeId) || (sourceId && ids.has(sourceId))) {
          titles[treeId] = session.title;
          pending.delete(treeId);
        }
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
    expectedRevision = page.revision;
  }
  return titles;
};

export const WorkspacePages = ({ store, transport, pickDirectory, workItemTarget, onWorkItemTargetConsumed }: WorkspacePagesProps) => {
  const client = store((s) => s.client);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const section = store((s) => s.workspaceSection);
  const view = store((s) => s.view);
  const viewError = store((s) => s.viewError);
  const taskTarget = store((s) => s.taskTarget);
  const issueTarget = store((s) => s.issueTarget);
  const expandedWorkGroups = store((s) => s.expandedWorkGroups);
  const setWorkGroupExpanded = store((s) => s.setWorkGroupExpanded);
  const showAgentSession = store((s) => s.showAgentSession);
  const showTaskBoard = store((s) => s.showTaskBoard);
  const browseWorkspace = store((s) => s.browseWorkspace);
  const openEditor = store((s) => s.openEditor);
  const [error, setError] = useState<string>();
  const [sourceTitles, setSourceTitles] = useState<Record<string, string>>({});
  const [linkedWorkItemTarget, setLinkedWorkItemTarget] = useState<{ workspaceId: string; workItemId: string; nonce: number }>();
  const [linkedIssueDomain, setLinkedIssueDomain] = useState<string>();
  const sourceIdsKey = JSON.stringify(view?.workItems.map(({ treeId, sourceSessionId }) => [treeId, sourceSessionId]) ?? []);
  useEffect(() => {
    let active = true;
    setSourceTitles({});
    setError(undefined);
    if (!activeWorkspaceId) return;
    void loadSourceTreeTitles(transport.sessionBrowser.list, activeWorkspaceId, view?.workItems ?? [])
      .then((titles) => { if (active) setSourceTitles(titles); })
      .catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [transport, activeWorkspaceId, sourceIdsKey]);

  const add = async () => {
    setError(undefined);
    try {
      const rootPath = await pickDirectory();
      if (!rootPath) return;
      const workspace = await client.request("workspace.add", { rootPath });
      browseWorkspace(workspace.workspaceId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return <section className="flex h-full min-h-0 min-w-0 flex-col">
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    {!activeWorkspaceId ? (
      <EmptyState title="选择一个 workspace" action={<Button onClick={() => void add()}>添加 workspace</Button>} />
    ) : <div className="min-h-0 flex-1 overflow-auto">
      {section === "workItems" && <div>
        {viewError ? <EmptyState title="工单加载失败" hint={viewError} /> : view && (
          <WorkItemsSection sourceTitles={sourceTitles} key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} scheduler={view.scheduler} workItems={view.workItems} runs={view.runs} actions={view.actions} onOpenSession={(id, turnId) => showAgentSession(activeWorkspaceId, id, turnId)} compact={false} onExpand={showTaskBoard} expandedWorkGroups={expandedWorkGroups} setWorkGroupExpanded={setWorkGroupExpanded} taskTarget={taskTarget?.workspaceId === activeWorkspaceId ? taskTarget : undefined} detailTarget={(linkedWorkItemTarget ?? workItemTarget)?.workspaceId === activeWorkspaceId ? linkedWorkItemTarget ?? workItemTarget : undefined} onDetailTargetConsumed={() => { setLinkedWorkItemTarget(undefined); onWorkItemTargetConsumed?.(); }} onOpenIssue={(issueId) => store.getState().showIssue({ workspaceId: activeWorkspaceId, issueId })} />
        )}
      </div>}
      <div hidden={section !== "docs"}>
        <DocsSection docs={view?.docs.map((d) => d.path) ?? []} decisions={view?.decisions ?? []} onOpen={(path) => openEditor({ kind: "doc", path })} />
      </div>
      <div hidden={section !== "domains"}>
        <DomainsSection key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} domains={view?.domains ?? []} patrolRuns={view?.patrolRuns ?? []}
          onOpenDoc={(path) => openEditor({ kind: "doc", path })}
          onOpenInstruction={(domainId) => openEditor({ kind: "maintainer", domainId, path: `.vermillion/roles/maintainer/${domainId}.md` })}
          onOpenSession={(id) => showAgentSession(activeWorkspaceId, id)} onOpenIssues={(domainId) => { setLinkedIssueDomain(domainId); store.getState().setWorkspaceSection("issues"); }} />
      </div>
      <div hidden={section !== "roles"}>
        <RolesSection client={client} workspaceId={activeWorkspaceId} roles={view?.roles ?? []} onEdit={(roleId) => openEditor({ kind: "role", roleId })} />
      </div>
      {section === "issues" && <IssuesSection client={client} workspaceId={activeWorkspaceId} issues={view?.issues ?? []} workItems={view?.workItems ?? []}
        domainIds={(view?.domains ?? []).map((domain) => domain.domainId)}
        targetDomainId={linkedIssueDomain}
        targetIssueId={issueTarget?.workspaceId === activeWorkspaceId ? issueTarget.issueId : undefined} onTargetConsumed={() => store.setState({ issueTarget: undefined })} onOpenSession={(id, turnId) => showAgentSession(activeWorkspaceId, id, turnId)}
        onOpenWorkItem={(workItemId) => { setLinkedWorkItemTarget({ workspaceId: activeWorkspaceId, workItemId, nonce: Date.now() }); store.getState().setWorkspaceSection("workItems"); }} />}
      {section === "automation" && <EmptyState title="Automation 暂未提供" />}
    </div>}
  </section>;
};

const DOMAIN_TEMPLATE = `---
standards:
  - .vermillion/docs/<业务>/Standards.md
---
# <领域名>

## 覆盖什么

## 什么样的改动应该考虑它
`;

const patrolStatus: Record<PatrolRun["status"], string> = {
  queued: "等待巡检", running: "巡检中", completed: "已完成", skipped: "已跳过", failed: "失败"
};
const patrolTrigger: Record<PatrolRun["trigger"], string> = { manual: "手动", change: "目录变更", scheduled: "定时" };
const relativePatrolTime = (value: string): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : new Date(value).toLocaleString();
};
const fileTitle = (path: string): string => path.split("/").at(-1)?.replace(/\.md$/i, "") || path;

const DomainsSection = ({ client, workspaceId, domains, patrolRuns, onOpenDoc, onOpenInstruction, onOpenSession, onOpenIssues }: {
  client: WorkbenchClient; workspaceId: string; domains: DomainDefinition[]; patrolRuns: PatrolRun[];
  onOpenDoc: (path: string) => void; onOpenInstruction: (domainId: string) => void; onOpenSession: (sessionId: string) => void;
  onOpenIssues: (domainId: string) => void;
}) => {
  const [selectedId, setSelectedId] = useState(domains[0]?.domainId ?? "");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string>();
  const selected = domains.find((domain) => domain.domainId === selectedId) ?? domains[0];
  useEffect(() => { if (selected && selected.domainId !== selectedId) setSelectedId(selected.domainId); }, [selected, selectedId]);
  const create = async () => {
    const id = draft.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!id) return;
    setError(undefined);
    try {
      const path = DOMAINS_DIR + id + ".md";
      await client.request("docs.write", { workspaceId, path, content: DOMAIN_TEMPLATE });
      setDraft(""); setCreating(false); setSelectedId(id); onOpenDoc(path);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const run = async () => {
    if (!selected) return;
    setError(undefined);
    try { await client.request("domain.patrol.run", { workspaceId, domainId: selected.domainId }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  if (!selected) return <div><PanelHeader title="Domain"><IconButton icon={Plus} label="新建领域" onClick={() => setCreating(true)} /></PanelHeader>
    {creating ? <form className="flex items-center gap-1 px-4 py-2" onSubmit={(event) => { event.preventDefault(); void create(); }}><Field value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="领域 id" className="w-48" /><Button type="submit" disabled={!draft.trim()}>创建</Button></form>
      : <EmptyState title="还没有领域定义" action={<Button onClick={() => setCreating(true)}>新建领域</Button>} />}</div>;
  const instructionPath = `.vermillion/roles/maintainer/${selected.domainId}.md`;
  const runs = patrolRuns.filter((run) => run.domainId === selected.domainId);
  return <div className="pb-4">
    <PanelHeader title="Domain">
      <Field kind="select" compact aria-label="选择领域" value={selected.domainId} className="w-56" onChange={(event) => setSelectedId(event.target.value)}>
        {domains.map((domain) => <option key={domain.domainId} value={domain.domainId}>{domain.title}</option>)}
      </Field>
      <IconButton icon={Plus} label="新建领域" onClick={() => setCreating((value) => !value)} />
    </PanelHeader>
    {creating && <form className="flex items-center gap-1 px-4 pb-2" onSubmit={(event) => { event.preventDefault(); void create(); }}><Field value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="领域 id" className="w-48" /><Button type="submit" size="sm" disabled={!draft.trim()}>创建</Button></form>}
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    <InlineNotice>{selected.summary || "领域定义说明覆盖范围和应考虑它的改动。"}</InlineNotice>
    <SectionLabel>领域文件</SectionLabel>
    <ul>
      <li><ListRow title={selected.title} meta={selected.path} trailing="领域定义" onClick={() => onOpenDoc(selected.path)} className="py-1.5" /></li>
      {selected.standards.map((path) => <li key={path}><ListRow title={fileTitle(path)} meta={path} trailing="检查依据" onClick={() => onOpenDoc(path)} className="py-1.5" /></li>)}
      <li><ListRow title={`${selected.title} 巡检指令`} meta={instructionPath} trailing="巡检指令" onClick={() => onOpenInstruction(selected.domainId)} className="py-1.5" /></li>
    </ul>
    <div className="mt-3 border-t border-border">
      <PanelHeader title={<span className="flex items-center gap-2">Maintainer <Badge tone={selected.config.enabled ? "accent" : "neutral"}>{selected.config.enabled ? "已启用" : "已暂停"}</Badge></span>}>
        <Button size="sm" onClick={() => setConfiguring(true)}>配置</Button><Button size="sm" onClick={() => void run()}>立即巡检</Button>
      </PanelHeader>
      <div className="flex flex-wrap gap-x-7 gap-y-1 px-4 pb-3 text-label text-foreground">
        <span><span className="text-muted-foreground">变更触发　</span>{selected.config.changeTrigger ? selected.config.triggerPaths.length ? "目录变更后" : "等待配置目录" : "关闭"}</span>
        <span><span className="text-muted-foreground">定时巡检　</span>每 {selected.config.intervalHours} 小时</span>
        <span><span className="text-muted-foreground">下次检查　</span>{selected.config.enabled ? new Date(selected.config.nextRunAt).toLocaleString("zh-CN") : "—"}</span>
        {selected.config.retryAt && <span><span className="text-muted-foreground">失败重试　</span>{new Date(selected.config.retryAt).toLocaleString("zh-CN")}</span>}
        <span><span className="text-muted-foreground">自动开单　</span>{selected.config.autoWorkEnabled ? selected.config.authorizationScope.length ? `已授权 ${selected.config.authorizationScope.length} 项` : "等待授权范围" : "关闭"}</span>
      </div>
    </div>
    <div className="border-t border-border">
      <PanelHeader title="巡检记录"><Button size="sm" variant="ghost" outlined onClick={() => onOpenIssues(selected.domainId)}>相关 Issues</Button></PanelHeader>
      {runs.length ? <ul>{runs.map((patrol) => <li key={patrol.patrolRunId} className="border-b border-border"><ListRow
        title={patrol.summary || patrolStatus[patrol.status]} meta={`${relativePatrolTime(patrol.startedAt)} · ${patrolTrigger[patrol.trigger]}${patrol.changedPaths.length ? ` · ${patrol.changedPaths.length} 个文件` : ""}`}
        trailing={patrol.sessionId ? "会话" : patrolStatus[patrol.status]} onClick={patrol.sessionId ? () => onOpenSession(patrol.sessionId!) : undefined} /></li>)}</ul>
        : <InlineNotice>暂无巡检记录。</InlineNotice>}
    </div>
    {configuring && <DomainConfigDialog client={client} workspaceId={workspaceId} domain={selected} onClose={() => setConfiguring(false)} />}
  </div>;
};

const DomainConfigDialog = ({ client, workspaceId, domain, onClose }: { client: WorkbenchClient; workspaceId: string; domain: DomainDefinition; onClose: () => void }) => {
  const [value, setValue] = useState<DomainConfig>(domain.config);
  const [paths, setPaths] = useState(domain.config.triggerPaths.join("\n"));
  const [authorization, setAuthorization] = useState(domain.config.authorizationScope.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      await client.request("domain.config.set", { workspaceId, domainId: domain.domainId, value: { ...value,
        triggerPaths: paths.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        authorizationScope: authorization.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setBusy(false); }
  };
  return <Modal title={`${domain.title} · 巡检配置`} onClose={onClose} width={640}><div className="space-y-4 p-4">
    <Toggle label="启用自动巡检" checked={value.enabled} onChange={(enabled) => setValue({ ...value, enabled })} />
    <Toggle label="相关目录变更后巡检" checked={value.changeTrigger} onChange={(changeTrigger) => setValue({ ...value, changeTrigger })} />
    <Field kind="textarea" label="触发目录（每行一个）" value={paths} rows={4} onChange={(event) => setPaths(event.target.value)} />
    <Field kind="select" label="定时巡检" value={String(value.intervalHours)} onChange={(event) => setValue({ ...value, intervalHours: Number(event.target.value) })}>
      {[3, 6, 12, 24, 48, 168].map((hours) => <option key={hours} value={hours}>每 {hours} 小时</option>)}
    </Field>
    <Toggle label="允许 Owner 在授权范围内自动开单" checked={value.autoWorkEnabled} onChange={(autoWorkEnabled) => setValue({ ...value, autoWorkEnabled })} />
    <Field kind="textarea" label="自动修复授权范围（每行一项）" hint="只填写允许自动恢复的既定要求偏差；需求取舍仍进入待决策。" value={authorization} rows={4} onChange={(event) => setAuthorization(event.target.value)} />
    {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
    <div className="flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>保存</Button></div>
  </div></Modal>;
};

const roleLabelForFile = (role: RoleFile) => role.title;

const roleSourceLabel: Record<RoleFile["source"], string> = { global: "全局", workspace: "本 workspace" };

const RolesSection = ({ client, workspaceId, roles, onEdit }: { client: WorkbenchClient; workspaceId: string; roles: RoleFile[]; onEdit: (roleId: string) => void }) => (
  <div>
    <SectionLabel>角色 prompt</SectionLabel>
    <InlineNotice>选择角色后，可在 global、override、append 三种方式间定制 prompt 和模型配置。global 沿用全局且只读，override 使用项目正文，append 在全局正文后追加项目正文。</InlineNotice>
    <ul>
      {roles.map((role) => (
        <li key={role.roleId}>
          <ListRow
            title={roleLabelForFile(role)}
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
            <ListRow title={card.question} titleClassName="font-normal text-foreground" trailing={card.withdrawn ? "已撤回：" + card.withdrawn.reason : card.answer ? "→ " + (card.options.find((o) => o.key === card.answer!.key)?.label ?? card.answer.note ?? "已答复") : "待回答"} />
          </li>
        ))}
      </ul>
    )}
  </div>
);
