import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactElement } from "react";
import type { DocChange, DocFile, Mission } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { Button, EmptyState, InlineNotice, PanelHeader } from "./ui.js";
import { CommitDocsDialog } from "./CommitDocsDialog.js";
import { ContextMenu } from "./ContextMenu.js";
import { DiffDialog } from "./DiffDialog.js";

type DocsPanelProps = {
  store: WorkbenchStore;
  activeSessionId?: string;
  onFileAction: (absolutePath: string, action: "open" | "reveal") => Promise<void>;
};

type TreeNode = { name: string; path: string; children?: TreeNode[] };

const DOCS_PREFIX = ".vermillion/docs/";

const buildTree = (paths: string[]): TreeNode[] => {
  const root: TreeNode[] = [];
  for (const full of paths) {
    const parts = full.slice(DOCS_PREFIX.length).split("/");
    let level = root;
    let acc = DOCS_PREFIX.slice(0, -1);
    parts.forEach((part, index) => {
      acc += "/" + part;
      const isFile = index === parts.length - 1;
      let node = level.find((n) => n.name === part);
      if (!node) {
        node = isFile ? { name: part, path: acc } : { name: part, path: acc, children: [] };
        level.push(node);
      }
      if (!isFile) level = node.children!;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
    nodes.forEach((n) => n.children && sort(n.children));
  };
  sort(root);
  return root;
};

const statusMark: Record<DocChange["status"], string> = { added: "U", modified: "M", deleted: "D" };
const EMPTY_DOCS: DocFile[] = [];
const EMPTY_CHANGES: DocChange[] = [];
const EMPTY_MISSIONS: Mission[] = [];

export const DocsPanel = ({ store, activeSessionId, onFileAction }: DocsPanelProps) => {
  const client = store((s) => s.client);
  const workspace = store((s) => s.workspaces.find((w) => w.workspaceId === s.browsingWorkspaceId));
  const view = store((s) => s.view);
  const viewError = store((s) => s.viewError);
  const docs = view?.docs ?? EMPTY_DOCS;
  const pending = view?.pendingDocChanges ?? EMPTY_CHANGES;
  const missions = view?.missions ?? EMPTY_MISSIONS;
  const openDocPath = store((s) => (s.editor?.kind === "doc" ? s.editor.path : undefined));
  const openEditor = store((s) => s.openEditor);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | undefined>();
  const [missionOpen, setMissionOpen] = useState(false);
  const setResult = store((s) => s.setDocCommit);
  const [diffTarget, setDiffTarget] = useState<{ workspaceId: string; path: string }>();
  const [diffResult, setDiffResult] = useState<{ diff?: string; error?: string }>();

  useEffect(() => {
    setDiffResult(undefined);
    if (!diffTarget) return;
    let active = true;
    void client.request("docs.diff", diffTarget).then(
      (result) => { if (active) setDiffResult(result); },
      (error: Error) => { if (active) setDiffResult({ error: error.message }); }
    );
    return () => { active = false; };
  }, [client, diffTarget]);

  const tree = useMemo(() => buildTree(docs.map((doc) => doc.path)), [docs]);
  const changeByPath = useMemo(() => new Map(pending.map((c) => [c.path, c])), [pending]);
  const dirtyDirs = useMemo(() => {
    const set = new Set<string>();
    for (const change of pending) {
      const parts = change.path.split("/");
      for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join("/"));
    }
    return set;
  }, [pending]);

  if (!workspace) {
    return <EmptyState title="未选择 workspace" hint="在 Composer 里选择 workspace 后，这里显示它的文档。" />;
  }

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onContextMenu = (event: MouseEvent, path: string) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, path });
  };

  const absolute = (path: string) => workspace.rootPath.replace(/[\\/]+$/, "") + "/" + path;

  const renderNode = (node: TreeNode, depth: number): ReactElement => {
    const isDir = Boolean(node.children);
    const change = changeByPath.get(node.path);
    const mark = change ? statusMark[change.status] : dirtyDirs.has(node.path) ? "•" : undefined;
    const isOpen = isDir && !collapsed.has(node.path);
    return (
      <li key={node.path}>
        <button
          type="button"
          onClick={() => { if (isDir) toggle(node.path); else if (docs.find((doc) => doc.path === node.path)?.isText) openEditor({ kind: "doc", path: node.path }); }}
          onContextMenu={(event) => onContextMenu(event, node.path)}
          className={cn(
            "flex h-[26px] w-full items-center gap-1.5 pr-3 text-left text-label text-foreground hover:bg-surface-hover",
            openDocPath === node.path && "bg-surface-selected text-strong"
          )}
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          {isDir ? (
            isOpen ? <ChevronDown size={13} className="shrink-0 text-faint-foreground" /> : <ChevronRight size={13} className="shrink-0 text-faint-foreground" />
          ) : (
            <span className="w-[13px] shrink-0" />
          )}
          {isDir ? (isOpen ? <FolderOpen size={14} className="shrink-0 text-muted-foreground" /> : <Folder size={14} className="shrink-0 text-muted-foreground" />) : <FileText size={14} className="shrink-0 text-muted-foreground" />}
          <span className={cn("truncate", change && "text-strong")}>{node.name}</span>
          {mark && <span className="ml-auto font-mono text-micro text-accent-strong">{mark}</span>}
        </button>
        {isDir && isOpen && <ul>{node.children!.map((child) => renderNode(child, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Docs">
        {pending.length > 0 && <span className="font-mono text-micro text-accent-strong">{pending.length} 处变更</span>}
      </PanelHeader>
      {viewError && <InlineNotice tone="error">工作区数据加载失败：<span className="break-all font-mono text-micro text-muted-foreground">{viewError}</span></InlineNotice>}
      {view && !viewError && tree.length === 0 && <InlineNotice>.vermillion/docs 下还没有文件。和设计伙伴聊出第一份 spec 吧。</InlineNotice>}
      <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {tree.map((node) => renderNode(node, 0))}
      </ul>
      <div className="border-t border-border p-3">
        <Button variant="primary" className="w-full" disabled={docs.length === 0} onClick={() => setMissionOpen(true)}>{pending.length > 0 ? "提交变更" : "创建任务"}</Button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          items={[
            ...(docs.some((doc) => doc.path === menu.path)
              ? [{ key: "diff", label: "Diff", onSelect: () => setDiffTarget({ workspaceId: workspace.workspaceId, path: menu.path }) }]
              : []),
            { key: "reveal", label: "在文件管理器中显示", onSelect: () => void onFileAction(absolute(menu.path), "reveal") },
            { key: "open", label: "用默认编辑器打开", onSelect: () => void onFileAction(absolute(menu.path), "open") }
          ]}
        />
      )}

      {missionOpen && (
        <CommitDocsDialog
          docs={docs.map((doc) => doc.path)}
          pending={pending}
          missions={missions}
          defaultMissionId={activeSessionId ? missions.find((m) => m.status !== "cancelled" && m.sessionId === activeSessionId)?.missionId : undefined}
          onClose={() => setMissionOpen(false)}
          onCreate={async (input) => {
            const mission = await client.request("mission.create", { workspaceId: workspace.workspaceId, sessionId: activeSessionId, ...input });
            setResult({ kind: "mission", missionId: mission.missionId, title: mission.title, appended: false });
            setMissionOpen(false);
          }}
          onAppend={async (input) => {
            const mission = await client.request("mission.addRevision", { workspaceId: workspace.workspaceId, sessionId: activeSessionId, ...input });
            setResult({ kind: "mission", missionId: mission.missionId, title: mission.title, appended: true });
            setMissionOpen(false);
          }}
          onCommit={async (input) => {
            const committed = await client.request("docs.commit", { workspaceId: workspace.workspaceId, ...input });
            setResult({ kind: "commit", ...committed });
            setMissionOpen(false);
          }}
        />
      )}
      {diffTarget && (
        <DiffDialog
          key={diffTarget.workspaceId + ":" + diffTarget.path}
          files={[{ path: diffTarget.path, diff: diffResult?.diff }]}
          loading={!diffResult}
          error={diffResult?.error}
          onClose={() => setDiffTarget(undefined)}
        />
      )}
    </div>
  );
};
