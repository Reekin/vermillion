import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { type DecisionCard, type DomainConfig, type DomainDefinition, type PatrolRun, type RoleFile, type WorkbenchClient, type WorkItem, type Workspace } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, Checkbox, EmptyState, Field, IconButton, InlineNotice, ListRow, PanelHeader, SectionLabel, Toggle } from "./ui.js";
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
  const workspaces = store((s) => s.workspaces);
  const selected = store((s) => s.browsingWorkspaceId);
  const browseWorkspace = store((s) => s.browseWorkspace);
  return <div className="flex min-w-0 max-w-md flex-1 items-center">
    <Field kind="select" compact aria-label="切换 workspace" className="min-w-0 flex-1" value={selected ?? ""} onChange={(e) => browseWorkspace(e.target.value)}>
      {!selected && <option value="">选择 workspace</option>}
      {workspaces.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.label} · {item.rootPath}</option>)}
    </Field>
  </div>;
};

export const loadSourceTreeTitles = async (
  list: DesktopTransport["sessionBrowser"]["list"], workspaceId: string,
  workItems: Pick<WorkItem, "treeId" | "sourceSessionId">[]
): Promise<Record<string, string>> => {
  const pending = new Map(workItems.flatMap((item) => item.treeId ? [[item.treeId, item.sourceSessionId] as const] : []));
  const titles: Record<string, string> = {};
  if (pending.size === 0) {
    return titles;
  }
  const snapshot = await list({ workspaceId, kind: "user" });
  for (const session of snapshot.items) {
    const ids = new Set([session.sessionId, ...(session.memberSessionIds ?? [])]);
    for (const [treeId, sourceId] of pending) {
      if (ids.has(treeId) || (sourceId && ids.has(sourceId))) {
        titles[treeId] = session.title;
        pending.delete(treeId);
      }
    }
  }
  return titles;
};

export const WorkspacePages = ({ store, transport, pickDirectory, workItemTarget, onWorkItemTargetConsumed }: WorkspacePagesProps) => {
  const client = store((s) => s.client);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const section = store((s) => s.workspaceSection);
  const view = store((s) => s.view);
  const workspaces = store((s) => s.workspaces);
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
      <div hidden={section !== "manage"}>
        <ManageSection client={client} workspace={workspaces.find((item) => item.workspaceId === activeWorkspaceId)} />
      </div>
      {section === "issues" && <IssuesSection client={client} workspaceId={activeWorkspaceId} issues={view?.issues ?? []} workItems={view?.workItems ?? []}
        domainIds={(view?.domains ?? []).map((domain) => domain.domainId)}
        targetDomainId={linkedIssueDomain}
        targetIssueId={issueTarget?.workspaceId === activeWorkspaceId ? issueTarget.issueId : undefined} onTargetConsumed={() => store.setState({ issueTarget: undefined })} onOpenSession={(id, turnId) => showAgentSession(activeWorkspaceId, id, turnId)}
        onOpenWorkItem={(workItemId) => { setLinkedWorkItemTarget({ workspaceId: activeWorkspaceId, workItemId, nonce: Date.now() }); store.getState().setWorkspaceSection("workItems"); }} />}
      {section === "automation" && <EmptyState title="自动化暂未提供" />}
    </div>}
  </section>;
};

const ManageSection = ({ client, workspace }: { client: WorkbenchClient; workspace?: Workspace }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!workspace) return <EmptyState title="选择一个 workspace" />;
  const remove = async () => {
    setBusy(true); setError(undefined);
    try {
      await client.request("workspace.remove", { workspaceId: workspace.workspaceId });
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };
  return <div className="max-w-[720px] pb-4">
    <PanelHeader title="管理" />
    <div className="flex items-center gap-3 px-4">
      <div className="min-w-0">
        <div className="truncate text-label text-strong">{workspace.label}</div>
        <div className="truncate font-mono text-caption text-muted-foreground">{workspace.rootPath}</div>
      </div>
      <Button size="sm" className="ml-auto shrink-0" onClick={() => setConfirming(true)}>移除 workspace</Button>
    </div>
    {confirming && <Modal title={"移除 " + workspace.label} onClose={() => setConfirming(false)} width={460}>
      <div className="space-y-3 p-4">
        <p className="text-caption text-muted-foreground">移除后工作台不再列出这个项目，磁盘上的文件不会被删除。之后可以重新添加。</p>
        <p className="truncate font-mono text-caption text-muted-foreground">{workspace.rootPath}</p>
        {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void remove()}>移除</Button>
        </div>
      </div>
    </Modal>}
  </div>;
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
  const [removing, setRemoving] = useState<string>();
  const [pickingPaths, setPickingPaths] = useState(false);
  const [editingAuthorization, setEditingAuthorization] = useState(false);
  const [config, setConfig] = useState<DomainConfig>();
  const [error, setError] = useState<string>();
  const selected = domains.find((domain) => domain.domainId === selectedId) ?? domains[0];
  useEffect(() => { if (selected && selected.domainId !== selectedId) setSelectedId(selected.domainId); }, [selected, selectedId]);
  useEffect(() => { setConfig(selected?.config); }, [selected]);
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
  const updateConfig = async (changes: Partial<DomainConfig>) => {
    if (!selected || !config) return;
    const next = { ...config, ...changes };
    setConfig(next); setError(undefined);
    try {
      setConfig(await client.request("domain.config.set", { workspaceId, domainId: selected.domainId, value: {
        enabled: next.enabled, changeTrigger: next.changeTrigger, intervalHours: next.intervalHours,
        triggerPaths: next.triggerPaths, autoWorkEnabled: next.autoWorkEnabled, authorizationScope: next.authorizationScope } }));
    } catch (caught) {
      setConfig(selected.config);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const removeDomain = async (domainId: string) => {
    setError(undefined);
    try {
      await client.request("domain.remove", { workspaceId, domainId });
      setRemoving(undefined);
      setSelectedId(domains.filter((domain) => domain.domainId !== domainId)[0]?.domainId ?? "");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const target = domains.find((domain) => domain.domainId === removing);
  const listed = <div className="flex w-52 shrink-0 flex-col border-r border-border">
    <PanelHeader title="领域"><IconButton icon={Plus} label="新建领域" onClick={() => setCreating((value) => !value)} /></PanelHeader>
    {creating && <form className="flex items-center gap-1 px-4 pb-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <Field value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="领域 id" className="w-28" /><Button type="submit" size="sm" disabled={!draft.trim()}>创建</Button>
    </form>}
    <ul className="min-h-0 flex-1 overflow-auto">{domains.map((domain) => <li key={domain.domainId}>
      <ListRow title={domain.title} meta={domain.domainId} selected={domain.domainId === selected?.domainId}
        onClick={() => setSelectedId(domain.domainId)}
        hoverActions={<IconButton icon={X} size={12} label={"删除领域：" + domain.title} onClick={() => setRemoving(domain.domainId)} />} />
    </li>)}</ul>
  </div>;
  if (!selected) return <div className="flex min-h-0 flex-1">
    {listed}
    <EmptyState title="还没有领域定义" action={<Button onClick={() => setCreating(true)}>新建领域</Button>} />
  </div>;
  const instructionPath = `.vermillion/roles/maintainer/${selected.domainId}.md`;
  const runs = patrolRuns.filter((run) => run.domainId === selected.domainId);
  return <div className="flex min-h-0 flex-1">
    {listed}
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="max-w-[720px] pb-4">
        <div className="flex items-baseline gap-2 px-4 pt-4">
          <h2 className="truncate text-title font-semibold text-strong">{selected.title}</h2>
          <span className="shrink-0 font-mono text-micro text-muted-foreground">{selected.domainId}</span>
        </div>
        <InlineNotice>{selected.summary || "领域定义说明覆盖范围和应考虑它的改动。"}</InlineNotice>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <SectionLabel>领域文件</SectionLabel>
        <ul>
          <li><ListRow title={selected.title} meta={selected.path} trailing="领域定义" onClick={() => onOpenDoc(selected.path)} className="py-1.5" /></li>
          {selected.standards.map((path) => <li key={path}><ListRow title={fileTitle(path)} meta={path} trailing="检查依据" onClick={() => onOpenDoc(path)} className="py-1.5" /></li>)}
          <li><ListRow title={`${selected.title} 巡检指令`} meta={instructionPath} trailing="巡检指令" onClick={() => onOpenInstruction(selected.domainId)} className="py-1.5" /></li>
        </ul>
        <div className="mt-3 border-t border-border">
          <PanelHeader title="Maintainer" align="start">
            <Badge tone={config?.enabled ? "accent" : "neutral"}>{config?.enabled ? "已启用" : "已暂停"}</Badge>
            <Button size="sm" onClick={() => void run()}>立即巡检</Button>
          </PanelHeader>
          {config && <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 pb-4 text-label text-foreground">
            <Toggle label="启用自动巡检" checked={config.enabled} onChange={(enabled) => void updateConfig({ enabled })} />
            <Toggle label="目录变更后巡检" checked={config.changeTrigger} onChange={(changeTrigger) => void updateConfig({ changeTrigger })} />
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground">定时巡检</span>
              <Field kind="select" compact aria-label="定时巡检间隔" className="w-24" value={String(config.intervalHours)} onChange={(event) => void updateConfig({ intervalHours: Number(event.target.value) })}>
                {[3, 6, 12, 24, 48, 168].map((hours) => <option key={hours} value={hours}>每 {hours} 小时</option>)}
              </Field>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground">触发目录</span>
              <span>{config.triggerPaths.length} 个</span>
              <Button size="sm" variant="ghost" outlined onClick={() => setPickingPaths(true)}>选择目录</Button>
            </span>
            <Toggle label="允许自动开单" checked={config.autoWorkEnabled} onChange={(autoWorkEnabled) => void updateConfig({ autoWorkEnabled })} />
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground">授权范围</span>
              <span>{config.authorizationScope.length} 项</span>
              <Button size="sm" variant="ghost" outlined onClick={() => setEditingAuthorization(true)}>编辑</Button>
            </span>
            <span><span className="text-muted-foreground">下次检查　</span>{config.enabled ? new Date(config.nextRunAt).toLocaleString("zh-CN") : "—"}</span>
            {config.retryAt && <span><span className="text-muted-foreground">失败重试　</span>{new Date(config.retryAt).toLocaleString("zh-CN")}</span>}
          </div>}
        </div>
        <div className="border-t border-border">
          <PanelHeader title="巡检记录" align="start"><Button size="sm" variant="ghost" outlined onClick={() => onOpenIssues(selected.domainId)}>相关 Issues</Button></PanelHeader>
          {runs.length ? <ul>{runs.map((patrol) => <li key={patrol.patrolRunId} className="border-b border-border"><ListRow
            title={patrol.summary || patrolStatus[patrol.status]} meta={`${relativePatrolTime(patrol.startedAt)} · ${patrolTrigger[patrol.trigger]}${patrol.changedPaths.length ? ` · ${patrol.changedPaths.length} 个文件` : ""}`}
            trailing={patrol.sessionId ? "会话" : patrolStatus[patrol.status]} onClick={patrol.sessionId ? () => onOpenSession(patrol.sessionId!) : undefined} /></li>)}</ul>
            : <InlineNotice>暂无巡检记录。</InlineNotice>}
        </div>
      </div>
    </div>
    {target && <Modal title={"删除 " + target.title} onClose={() => setRemoving(undefined)} width={460}>
      <div className="space-y-3 p-4">
        <p className="text-caption text-muted-foreground">删除后移除领域定义、巡检指令和巡检配置；该领域已有的 Issue 与巡检记录保留。领域定义的删除作为文档变更，随文档提交。</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(undefined)}>取消</Button>
          <Button variant="primary" onClick={() => void removeDomain(target.domainId)}>删除领域</Button>
        </div>
      </div>
    </Modal>}
    {config && pickingPaths && <DirectoryPickerDialog client={client} workspaceId={workspaceId} selected={config.triggerPaths}
      onSave={(triggerPaths) => { setPickingPaths(false); void updateConfig({ triggerPaths }); }} onClose={() => setPickingPaths(false)} />}
    {config && editingAuthorization && <AuthorizationDialog selected={config.authorizationScope}
      onSave={(authorizationScope) => { setEditingAuthorization(false); void updateConfig({ authorizationScope }); }} onClose={() => setEditingAuthorization(false)} />}
  </div>;
};

type DirectoryNode = { path: string; name: string; children: DirectoryNode[] };

const directoryTree = (paths: string[]): DirectoryNode => {
  const root: DirectoryNode = { path: "", name: "", children: [] };
  for (const path of paths) {
    let node = root;
    let accumulated = "";
    for (const part of path.split("/")) {
      accumulated = accumulated ? accumulated + "/" + part : part;
      let child = node.children.find((entry) => entry.name === part);
      if (!child) { child = { path: accumulated, name: part, children: [] }; node.children.push(child); }
      node = child;
    }
  }
  return root;
};

const findDirectory = (node: DirectoryNode, path: string): DirectoryNode | undefined =>
  node.path === path ? node : node.children.map((child) => findDirectory(child, path)).find(Boolean);

/** True when the directory itself, or one of its ancestors, is part of the selection. */
const isCovers = (selected: string[], path: string): boolean => selected.some((entry) => entry === path || path.startsWith(entry + "/"));

const withoutBranch = (selected: string[], path: string): string[] =>
  selected.filter((entry) => entry !== path && !entry.startsWith(path + "/"));

/** Minimal set of directories covering `node` minus the excluded branch. */
const remainderOf = (node: DirectoryNode, exclude: string): string[] => {
  if (node.path === exclude) return [];
  if (!exclude.startsWith(node.path + "/")) return [node.path];
  return node.children.flatMap((child) => remainderOf(child, exclude));
};

/** Picks the directories whose changes trigger a patrol; the tree comes from Git-tracked files. */
const DirectoryPickerDialog = ({ client, workspaceId, selected, onSave, onClose }: {
  client: WorkbenchClient; workspaceId: string; selected: string[]; onSave: (paths: string[]) => void; onClose: () => void;
}) => {
  const [paths, setPaths] = useState<string[]>();
  const [chosen, setChosen] = useState<string[]>(selected);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    client.request("workspace.directories", { workspaceId })
      .then((listed) => { if (active) setPaths(listed); })
      .catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [client, workspaceId]);
  const tree = useMemo(() => directoryTree(paths ?? []), [paths]);
  const toggle = (path: string, next: boolean) => {
    const ancestor = chosen.find((entry) => path.startsWith(entry + "/"));
    const branch = ancestor ? findDirectory(tree, ancestor) : undefined;
    setChosen(next
      ? [...withoutBranch(chosen, path), path]
      : [...withoutBranch(chosen, path).filter((entry) => entry !== ancestor), ...(branch ? remainderOf(branch, path) : [])]);
  };
  const rows = (node: DirectoryNode, depth: number): ReactNode[] => node.children.flatMap((child) => [
    <div key={child.path} style={{ paddingLeft: depth * 14 }}>
      <Checkbox label={child.name} checked={isCovers(chosen, child.path)}
        indeterminate={!isCovers(chosen, child.path) && chosen.some((entry) => entry.startsWith(child.path + "/"))}
        onChange={(next) => toggle(child.path, next)} />
    </div>,
    ...rows(child, depth + 1)
  ]);
  return <Modal title="触发目录" onClose={onClose} width={520}><div className="space-y-3 p-4">
    <p className="text-caption text-muted-foreground">这些目录下的变更会触发巡检。勾选父目录即覆盖其全部子目录。</p>
    {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
    {paths ? <div className="max-h-[52vh] overflow-auto rounded-md border border-border bg-input p-2">{rows(tree, 0)}</div>
      : <p className="text-caption text-muted-foreground">正在读取目录…</p>}
    <div className="flex items-center gap-2">
      <span className="text-caption text-muted-foreground">已选 {chosen.length} 个目录</span>
      <Button variant="ghost" className="ml-auto" onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={!paths} onClick={() => onSave([...chosen].sort())}>保存</Button>
    </div>
  </div></Modal>;
};

const AuthorizationDialog = ({ selected, onSave, onClose }: { selected: string[]; onSave: (scope: string[]) => void; onClose: () => void }) => {
  const [value, setValue] = useState(selected.join("\n"));
  return <Modal title="自动修复授权范围" onClose={onClose} width={560}><div className="space-y-3 p-4">
    <Field kind="textarea" label="每行一项" rows={6} hint="只填写允许自动恢复的既定要求偏差；需求取舍仍进入待决策。" value={value} onChange={(event) => setValue(event.target.value)} />
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>取消</Button>
      <Button variant="primary" onClick={() => onSave(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))}>保存</Button>
    </div>
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
