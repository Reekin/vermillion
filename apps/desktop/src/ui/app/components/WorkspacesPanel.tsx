import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import type { Mission } from "@vermillion/workbench/client";
import { Badge, Button, Empty, SectionLabel } from "./ui.js";

const EMPTY_MISSIONS: Mission[] = [];

type WorkspacesPanelProps = {
  store: WorkbenchStore;
  pickDirectory: () => Promise<string | undefined>;
};

export const WorkspacesPanel = ({ store, pickDirectory }: WorkspacesPanelProps) => {
  const client = store((s) => s.client);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const missions = store((s) => s.view?.missions ?? EMPTY_MISSIONS);
  const selectWorkspace = store((s) => s.browseWorkspace);
  const [error, setError] = useState<string | undefined>();

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
    <div className="flex h-full min-h-[320px]">
      <aside className="w-64 shrink-0 border-r border-border">
        <div className="flex items-center pr-2">
          <SectionLabel>Workspaces</SectionLabel>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void add()} title="添加 workspace"><Plus size={14} /></Button>
        </div>
        {error && <p className="px-4 pb-2 text-caption text-muted-foreground">{error}</p>}
        <ul>
          {workspaces.map((workspace) => (
            <li key={workspace.workspaceId} className="group flex items-center">
              <button
                type="button"
                onClick={() => selectWorkspace(workspace.workspaceId)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col px-4 py-1.5 text-left hover:bg-surface-hover",
                  activeWorkspaceId === workspace.workspaceId && "bg-surface-selected"
                )}
              >
                <span className="truncate text-label text-strong">{workspace.label}</span>
                <span className="truncate font-mono text-micro text-faint-foreground">{workspace.rootPath}</span>
              </button>
              <button type="button" aria-label={"移除 " + workspace.label} className="mr-2 hidden rounded-md p-1 text-faint-foreground hover:bg-surface-hover hover:text-strong group-hover:block" onClick={() => void remove(workspace.workspaceId)}><Trash2 size={13} /></button>
            </li>
          ))}
          {workspaces.length === 0 && <li className="px-4 py-2 text-caption text-muted-foreground">点右上角 + 添加一个目录</li>}
        </ul>
      </aside>
      <section className="min-w-0 flex-1">
        {!activeWorkspaceId ? (
          <Empty title="选择一个 workspace" />
        ) : (
          <>
            <SectionLabel>任务</SectionLabel>
            {missions.length === 0 ? (
              <p className="px-4 py-2 text-caption text-muted-foreground">还没有任务。去「思考」里和设计伙伴聊出一个。</p>
            ) : (
              <ul>
                {missions.map((mission) => (
                  <li key={mission.missionId} className="px-4 py-2 hover:bg-surface-hover">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-label text-strong">{mission.title}</span>
                      <Badge tone={mission.status === "active" ? "accent" : "neutral"}>{mission.status}</Badge>
                    </div>
                    {mission.summary && <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">{mission.summary}</p>}
                    <p className="mt-1 font-mono text-micro text-faint-foreground">doc {mission.docCommit.slice(0, 8)} · {new Date(mission.createdAt).toLocaleString()}</p>
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
