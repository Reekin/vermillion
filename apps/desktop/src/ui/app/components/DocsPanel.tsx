import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { DocChange, DocFile, Mission } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { Button, Empty, SectionLabel } from "./ui.js";
import { CommitDocsDialog } from "./CommitDocsDialog.js";

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
  const docs = view?.docs ?? EMPTY_DOCS;
  const pending = view?.pendingDocChanges ?? EMPTY_CHANGES;
  const missions = view?.missions ?? EMPTY_MISSIONS;
  const openDocPath = store((s) => s.openDocPath);
  const setOpenDocPath = store((s) => s.setOpenDocPath);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | undefined>();
  const [missionOpen, setMissionOpen] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

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
    return <Empty title="未选择 workspace" hint="在 Composer 里选择 workspace 后，这里显示它的文档。" />;
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
          onClick={() => (isDir ? toggle(node.path) : setOpenDocPath(node.path))}
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
      <div className="flex items-center pr-2">
        <SectionLabel>Docs</SectionLabel>
        {pending.length > 0 && <span className="ml-auto font-mono text-micro text-accent-strong">{pending.length} 处变更</span>}
      </div>
      <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {tree.length === 0 && <li className="px-4 py-2 text-caption text-muted-foreground">.vermillion/docs 下还没有文件。和设计伙伴聊出第一份 spec 吧。</li>}
        {tree.map((node) => renderNode(node, 0))}
      </ul>
      <div className="border-t border-border p-3">
        <Button variant="primary" className="w-full" disabled={pending.length === 0} onClick={() => setMissionOpen(true)}>提交变更</Button>
        <p className="mt-2 text-caption text-faint-foreground">新建任务，或补充到现有任务。每次提交是任务的一个 revision。</p>
      </div>

      {menu &&
        createPortal(
          <ul
            role="menu"
            className="fixed z-50 min-w-44 rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow"
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {[
              { label: "在文件管理器中显示", action: "reveal" as const },
              { label: "用默认编辑器打开", action: "open" as const }
            ].map((item) => (
              <li key={item.action}>
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-label text-foreground hover:bg-surface-hover hover:text-strong"
                  onClick={() => {
                    setMenu(undefined);
                    void onFileAction(absolute(menu.path), item.action);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}

      {missionOpen && (
        <CommitDocsDialog
          pending={pending}
          missions={missions}
          defaultMissionId={activeSessionId ? missions.find((m) => m.status === "active" && m.sessionId === activeSessionId)?.missionId : undefined}
          onClose={() => setMissionOpen(false)}
          onCreate={async (input) => {
            await client.request("mission.create", { workspaceId: workspace.workspaceId, sessionId: activeSessionId, ...input });
            setMissionOpen(false);
          }}
          onAppend={async (input) => {
            await client.request("mission.addRevision", { workspaceId: workspace.workspaceId, sessionId: activeSessionId, ...input });
            setMissionOpen(false);
          }}
        />
      )}
    </div>
  );
};
