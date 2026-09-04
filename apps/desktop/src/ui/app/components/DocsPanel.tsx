import { FileText, GitCommitHorizontal, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { DocChange } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { Badge, Button, Empty, SectionLabel } from "./ui.js";

type DocsPanelProps = {
  store: WorkbenchStore;
  activeSessionId?: string;
};

const changeTone = (status: DocChange["status"]) =>
  status === "added" ? "success" : status === "deleted" ? "warning" : "brand";

export const DocsPanel = ({ store, activeSessionId }: DocsPanelProps) => {
  const client = store((s) => s.client);
  const workspaceId = store((s) => s.activeWorkspaceId);
  const docs = store((s) => s.docs);
  const pending = store((s) => s.pendingDocChanges);
  const openDocPath = store((s) => s.openDocPath);
  const setOpenDocPath = store((s) => s.setOpenDocPath);
  const refreshWorkspaceData = store((s) => s.refreshWorkspaceData);
  const [missionOpen, setMissionOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!workspaceId) return;
    const timer = setInterval(() => void refreshWorkspaceData(), 4000);
    return () => clearInterval(timer);
  }, [workspaceId, refreshWorkspaceData]);

  if (!workspaceId) {
    return <Empty title="未选择 workspace" hint="在左上角选择一个 workspace 后，这里会显示它的文档。" />;
  }

  return (
    <div className="flex h-full flex-col">
      <SectionLabel>Docs</SectionLabel>
      <ul className="max-h-[38%] min-h-0 flex-none overflow-auto px-1">
        {docs.length === 0 && <li className="px-2 py-2 text-caption text-muted-foreground">docs/ 下还没有文件</li>}
        {docs.map((doc) => (
          <li key={doc.path}>
            <button
              type="button"
              onClick={() => setOpenDocPath(doc.path)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-label text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                openDocPath === doc.path && "bg-surface-selected text-foreground"
              )}
            >
              <FileText size={14} className="shrink-0" />
              <span className="truncate">{doc.path.replace(/^docs\//, "")}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center border-t border-border">
        <SectionLabel>待确认变更</SectionLabel>
        {pending.length > 0 && <span className="ml-1 mt-2 text-micro text-muted-foreground">{pending.length}</span>}
      </div>
      <ul className="min-h-0 flex-1 overflow-auto px-1">
        {pending.length === 0 && (
          <li className="px-2 py-2 text-caption text-muted-foreground">与设计伙伴聊完后，docs/ 的改动会出现在这里。</li>
        )}
        {pending.map((change) => (
          <li key={change.path}>
            <button
              type="button"
              onClick={() => setOpenDocPath(change.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-label hover:bg-surface-hover"
            >
              <Badge tone={changeTone(change.status)}>{change.status[0]}</Badge>
              <span className="truncate text-foreground">{change.path.replace(/^docs\//, "")}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="border-t border-border p-3">
        {error && <p className="mb-2 text-caption text-destructive">{error}</p>}
        <Button variant="primary" className="w-full" disabled={pending.length === 0} onClick={() => setMissionOpen(true)}>
          <Plus size={14} /> 创建任务
        </Button>
        <p className="mt-2 text-micro text-faint-foreground">
          <GitCommitHorizontal size={11} className="mr-1 inline" />
          创建任务会提交 docs/ 的全部改动并绑定该 commit
        </p>
      </div>

      {missionOpen && (
        <CreateMissionDialog
          onClose={() => setMissionOpen(false)}
          onSubmit={async (input) => {
            setError(undefined);
            try {
              await client.request("mission.create", { workspaceId, sessionId: activeSessionId, ...input });
              await refreshWorkspaceData();
              setMissionOpen(false);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        />
      )}
    </div>
  );
};

const CreateMissionDialog = ({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (input: { title: string; summary: string }) => Promise<void>;
}) => {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh]" onMouseDown={onClose} role="presentation">
      <form
        role="dialog"
        aria-label="创建任务"
        className="w-[520px] max-w-[92vw] rounded-xl border border-surface-border bg-surface-raised p-4 surface-shadow"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!title.trim()) return;
          setBusy(true);
          try {
            await onSubmit({ title: title.trim(), summary: summary.trim() });
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-title-sm font-semibold">创建任务</h2>
        <p className="mt-1 text-caption text-muted-foreground">docs/ 的待确认变更会作为这个任务的依据被提交。</p>
        <label className="mt-4 block text-label">
          <span className="text-muted-foreground">标题</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-input bg-surface px-3 text-body outline-none focus:border-ring"
            placeholder="例如：导出页增加日期范围筛选"
          />
        </label>
        <label className="mt-3 block text-label">
          <span className="text-muted-foreground">摘要</span>
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            className="mt-1 w-full resize-none rounded-md border border-input bg-surface px-3 py-2 text-body outline-none focus:border-ring"
            placeholder="这次任务要达到什么效果"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !title.trim()}>{busy ? "创建中…" : "创建任务"}</Button>
        </div>
      </form>
    </div>
  );
};
