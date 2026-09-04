import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { Badge, Button, Empty, SectionLabel } from "./ui.js";

type WorkspacesPanelProps = {
  store: WorkbenchStore;
  pickDirectory: () => Promise<string | undefined>;
};

export const WorkspacesPanel = ({ store, pickDirectory }: WorkspacesPanelProps) => {
  const client = store((s) => s.client);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.activeWorkspaceId);
  const missions = store((s) => s.missions);
  const selectWorkspace = store((s) => s.selectWorkspace);
  const refreshWorkspaces = store((s) => s.refreshWorkspaces);
  const [error, setError] = useState<string | undefined>();

  const add = async () => {
    setError(undefined);
    const rootPath = await pickDirectory();
    if (!rootPath) return;
    try {
      const workspace = await client.request("workspace.add", { rootPath });
      await refreshWorkspaces();
      await selectWorkspace(workspace.workspaceId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const remove = async (workspaceId: string) => {
    await client.request("workspace.remove", { workspaceId });
    await refreshWorkspaces();
  };

  return (
    <div className="flex h-full min-h-[320px]">
      <aside className="w-64 shrink-0 border-r border-border">
        <div className="flex items-center pr-2">
          <SectionLabel>Workspaces</SectionLabel>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void add()} title="添加 workspace"><Plus size={14} /></Button>
        </div>
        {error && <p className="px-3 pb-2 text-caption text-destructive">{error}</p>}
        <ul className="px-1">
          {workspaces.map((workspace) => (
            <li key={workspace.workspaceId} className="group flex items-center">
              <button
                type="button"
                onClick={() => void selectWorkspace(workspace.workspaceId)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-hover",
                  activeWorkspaceId === workspace.workspaceId && "bg-surface-selected"
                )}
              >
                <span className="truncate text-label font-medium text-foreground">{workspace.label}</span>
                <span className="truncate font-mono text-micro text-faint-foreground">{workspace.rootPath}</span>
              </button>
              <button type="button" aria-label={"移除 " + workspace.label} className="mr-1 hidden rounded-md p-1 text-muted-foreground hover:bg-surface-hover hover:text-destructive group-hover:block" onClick={() => void remove(workspace.workspaceId)}><Trash2 size={13} /></button>
            </li>
          ))}
          {workspaces.length === 0 && <li className="px-2 py-2 text-caption text-muted-foreground">点右上角 + 添加一个目录</li>}
        </ul>
      </aside>
      <section className="min-w-0 flex-1">
        {!activeWorkspaceId ? (
          <Empty title="选择一个 workspace" />
        ) : (
          <>
            <SectionLabel>任务</SectionLabel>
            {missions.length === 0 ? (
              <p className="px-3 py-2 text-caption text-muted-foreground">还没有任务。去「思考」里和设计伙伴聊出一个。</p>
            ) : (
              <ul className="px-1">
                {missions.map((mission) => (
                  <li key={mission.missionId} className="rounded-md px-2 py-2 hover:bg-surface-hover">
                    <div className="flex items-center gap-2">
                      <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-label font-medium">{mission.title}</span>
                      <Badge tone={mission.status === "active" ? "brand" : "neutral"}>{mission.status}</Badge>
                    </div>
                    {mission.summary && <p className="mt-1 line-clamp-2 pl-6 text-caption text-muted-foreground">{mission.summary}</p>}
                    <p className="mt-1 pl-6 font-mono text-micro text-faint-foreground">doc {mission.docCommit.slice(0, 8)} · {new Date(mission.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
};
