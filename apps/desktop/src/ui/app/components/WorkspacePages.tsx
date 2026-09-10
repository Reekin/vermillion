import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type DecisionCard, type RoleFile, type WorkbenchClient, type WorkItem } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ListRow, PanelHeader, SectionLabel } from "./ui.js";
import { WorkItemsSection } from "./WorkItemsSection.js";

type WorkspacePagesProps = {
  store: WorkbenchStore;
  transport: DesktopTransport;
  pickDirectory: () => Promise<string | undefined>;
  workItemTarget?: { workspaceId: string; workItemId: string; nonce: number };
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

export const WorkspacePages = ({ store, transport, pickDirectory, workItemTarget }: WorkspacePagesProps) => {
  const client = store((s) => s.client);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const section = store((s) => s.workspaceSection);
  const view = store((s) => s.view);
  const viewError = store((s) => s.viewError);
  const taskTarget = store((s) => s.taskTarget);
  const expandedWorkGroups = store((s) => s.expandedWorkGroups);
  const setWorkGroupExpanded = store((s) => s.setWorkGroupExpanded);
  const showAgentSession = store((s) => s.showAgentSession);
  const showTaskBoard = store((s) => s.showTaskBoard);
  const browseWorkspace = store((s) => s.browseWorkspace);
  const openEditor = store((s) => s.openEditor);
  const [error, setError] = useState<string>();
  const [sourceTitles, setSourceTitles] = useState<Record<string, string>>({});
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
          <WorkItemsSection sourceTitles={sourceTitles} key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} scheduler={view.scheduler} workItems={view.workItems} runs={view.runs} actions={view.actions} onOpenSession={(id, turnId) => showAgentSession(activeWorkspaceId, id, turnId)} compact={false} onExpand={showTaskBoard} expandedWorkGroups={expandedWorkGroups} setWorkGroupExpanded={setWorkGroupExpanded} taskTarget={taskTarget?.workspaceId === activeWorkspaceId ? taskTarget : undefined} detailTarget={workItemTarget?.workspaceId === activeWorkspaceId ? workItemTarget : undefined} />
        )}
      </div>}
      <div hidden={section !== "docs"}>
        <DocsSection docs={view?.docs.map((d) => d.path) ?? []} decisions={view?.decisions ?? []} onOpen={(path) => openEditor({ kind: "doc", path })} />
      </div>
      <div hidden={section !== "domains"}>
        <DomainsSection key={activeWorkspaceId} client={client} workspaceId={activeWorkspaceId} docs={view?.docs.map((d) => d.path) ?? []} onOpen={(path) => openEditor({ kind: "doc", path })} />
      </div>
      <div hidden={section !== "roles"}>
        <RolesSection client={client} workspaceId={activeWorkspaceId} roles={view?.roles ?? []} onEdit={(roleId) => openEditor({ kind: "role", roleId })} />
      </div>
      {section === "issues" && <EmptyState title="Issues 暂未提供" />}
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
      <InlineNotice>每个领域一份 md：正文说明覆盖什么、什么改动该考虑它，头部 standards 列规范路径。Worker 建单时读全部定义，判断涉及的领域并把规范附进工单。</InlineNotice>
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
