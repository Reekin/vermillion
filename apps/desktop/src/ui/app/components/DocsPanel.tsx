import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import type { DocChange, DocFile } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { EmptyState, InlineNotice, PanelHeader } from "./ui.js";
import { CommitDocsDialog } from "./CommitDocsDialog.js";
import { ContextMenu } from "./ContextMenu.js";
import { DiffDialog } from "./DiffDialog.js";
import { DiscardDocsDialog } from "./DiscardDocsDialog.js";

type DocsPanelProps = {
  store: WorkbenchStore;
  primaryAction: ReactNode;
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

export const DocsPanel = ({ store, onFileAction, primaryAction }: DocsPanelProps) => {
  const client = store((s) => s.client);
  const workspace = store((s) => s.workspaces.find((w) => w.workspaceId === s.browsingWorkspaceId));
  const docsSessionId = store((s) => s.docsSessionId);
  const view = store((s) => s.view);
  const viewError = store((s) => s.viewError);
  const docs = view?.docs ?? EMPTY_DOCS;
  const pending = view?.pendingDocChanges ?? EMPTY_CHANGES;
  const openDocPath = store((s) => (s.editor?.kind === "doc" ? s.editor.path : undefined));
  const openEditor = store((s) => s.openEditor);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | undefined>();
  const [commitOpen, setCommitOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{ workspaceId: string; path: string; sessionId?: string }>();
  const setResult = store((s) => s.setDocCommit);
  const [diffTarget, setDiffTarget] = useState<{ workspaceId: string; path: string }>();
  const [diffResult, setDiffResult] = useState<{ diff?: string; error?: string }>();

  useEffect(() => {
    setDiffResult(undefined);
    if (!diffTarget) return;
    let active = true;
    void client.request("docs.diff", { ...diffTarget, sessionId: docsSessionId }).then(
      (result) => { if (active) setDiffResult(result); },
      (error: Error) => { if (active) setDiffResult({ error: error.message }); }
    );
    return () => { active = false; };
  }, [client, diffTarget, docsSessionId]);

  const tree = useMemo(() => buildTree([...new Set([...docs.map((doc) => doc.path), ...pending.map((change) => change.path)])]), [docs, pending]);
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
    return <EmptyState title="未选择 workspace" hint="在输入器里选择 workspace 后，这里显示它的文档。" />;
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
    event.stopPropagation();
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
          onClick={() => { if (isDir) toggle(node.path); else if (docs.find((doc) => doc.path === node.path)?.isText) openEditor({ kind: "doc", path: node.path, sessionId: docsSessionId }); }}
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
    <div className="flex h-full flex-col" onContextMenu={(event) => onContextMenu(event, ".vermillion/docs")}>
      <PanelHeader title="文档">
        {pending.length > 0 && <span className="font-mono text-micro text-accent-strong">{pending.length} 处变更</span>}
      </PanelHeader>
      {viewError && <InlineNotice tone="error">工作区数据加载失败：<span className="break-all font-mono text-micro text-muted-foreground">{viewError}</span></InlineNotice>}
      {view && !viewError && tree.length === 0 && <InlineNotice>.vermillion/docs 下还没有文件。和设计伙伴聊出第一份 spec 吧。</InlineNotice>}
      <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {tree.map((node) => renderNode(node, 0))}
      </ul>
      <div className="border-t border-border p-3">
        {primaryAction}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          items={[
            { key: "commit", label: "提交", disabled: pending.length === 0, onSelect: () => setCommitOpen(true) },
            { key: "discard", label: "丢弃变更", disabled: !pending.some((change) => change.path === menu.path || change.path.startsWith(menu.path + "/")), onSelect: () => setDiscardTarget({ workspaceId: workspace.workspaceId, path: menu.path, sessionId: docsSessionId }) },
            ...(docs.some((doc) => doc.path === menu.path) || changeByPath.has(menu.path)
              ? [{ key: "diff", label: "查看差异", onSelect: () => setDiffTarget({ workspaceId: workspace.workspaceId, path: menu.path }) }]
              : []),
            { key: "reveal", label: "在文件管理器中显示", onSelect: () => void onFileAction(absolute(menu.path), "reveal") },
            { key: "open", label: "用默认编辑器打开", onSelect: () => void onFileAction(absolute(menu.path), "open") }
          ]}
        />
      )}

      {commitOpen && (
        <CommitDocsDialog
          pending={pending}
          onClose={() => setCommitOpen(false)}
          onCommit={async (input) => {
            const committed = await client.request("docs.commit", { workspaceId: workspace.workspaceId, sessionId: docsSessionId, ...input });
            setResult({ kind: "commit", ...committed });
            setCommitOpen(false);
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
      {discardTarget && <DiscardDocsDialog key={discardTarget.workspaceId + ":" + discardTarget.path} client={client} {...discardTarget} onClose={() => setDiscardTarget(undefined)} />}
    </div>
  );
};
