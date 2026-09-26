import { useEffect, useState } from "react";
import { type WorkbenchClient, type WorkItem, type Workspace } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Button, EmptyState, InlineNotice, PanelHeader, Select } from "./ui.js";
import { DomainsSection } from "./DomainsSection.js";
import { RolesSection } from "./RolesSection.js";
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


/** Compact editing-scope picker at the tab bar's right end: the name shows, the path is the option's second line. */
export const WorkspaceSwitcher = ({ store }: { store: WorkbenchStore }) => {
  const workspaces = store((s) => s.workspaces);
  const selected = store((s) => s.browsingWorkspaceId);
  const browseWorkspace = store((s) => s.browseWorkspace);
  return <Select plain compact aria-label="切换 workspace" className="max-w-60" value={selected ?? ""} placeholder="选择 workspace"
    options={workspaces.map((item) => ({ value: item.workspaceId, label: item.label, hint: item.rootPath }))} onChange={browseWorkspace} />;
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
  const snapshot = await list({ workspaceId });
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
  const sources = [...(view?.workRequests ?? []), ...(view?.workItems ?? [])];
  const sourceIdsKey = JSON.stringify(sources.map(({ treeId, sourceSessionId }) => [treeId, sourceSessionId]));
  useEffect(() => {
    let active = true;
    setSourceTitles({});
    setError(undefined);
    if (!activeWorkspaceId) return;
    void loadSourceTreeTitles(transport.sessionBrowser.list, activeWorkspaceId, sources)
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
        {viewError ? <EmptyState title="工作加载失败" hint={viewError} /> : view && (
          <WorkItemsSection sourceTitles={sourceTitles} key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} scheduler={view.scheduler} workItems={view.workItems} workRequests={view.workRequests} decisions={view.decisions} runs={view.runs} actions={view.actions} onOpenSession={(id, turnId) => showAgentSession(activeWorkspaceId, id, turnId)} compact={false} onExpand={showTaskBoard} expandedWorkGroups={expandedWorkGroups} setWorkGroupExpanded={setWorkGroupExpanded} taskTarget={taskTarget?.workspaceId === activeWorkspaceId ? taskTarget : undefined} detailTarget={(linkedWorkItemTarget ?? workItemTarget)?.workspaceId === activeWorkspaceId ? linkedWorkItemTarget ?? workItemTarget : undefined} onDetailTargetConsumed={() => { setLinkedWorkItemTarget(undefined); onWorkItemTargetConsumed?.(); }} onOpenIssue={(issueId) => store.getState().showIssue({ workspaceId: activeWorkspaceId, issueId })} />
        )}
      </div>}
      <div hidden={section !== "domains"}>
        <DomainsSection key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} workspaceRoot={workspaces.find((item) => item.workspaceId === activeWorkspaceId)?.rootPath ?? ""}
          domains={view?.domains ?? []} patrolRuns={view?.patrolRuns ?? []} issues={view?.issues ?? []}
          onOpenDoc={(path) => openEditor({ kind: "doc", path })}
          onOpenInstruction={(domainId) => openEditor({ kind: "maintainer", domainId, path: `.vermillion/roles/maintainer/${domainId}.md` })}
          onOpenSession={(id) => showAgentSession(activeWorkspaceId, id)} onOpenIssues={(domainId) => { setLinkedIssueDomain(domainId); store.getState().setWorkspaceSection("issues"); }} />
      </div>
      <div hidden={section !== "roles"}>
        <RolesSection client={client} transport={transport} workspaceId={activeWorkspaceId} roles={view?.roles ?? []} onEdit={(roleId) => openEditor({ kind: "role", roleId })} />
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
