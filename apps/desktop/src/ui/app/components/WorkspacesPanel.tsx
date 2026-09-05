import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { DecisionCard, Mission, WorkItem } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";
import { Badge, Button, Empty, SectionLabel } from "./ui.js";

type WorkspacesPanelProps = {
  store: WorkbenchStore;
  pickDirectory: () => Promise<string | undefined>;
};

/** Secondary navigation inside a workspace. Sections without a backing feature yet render a placeholder. */
type Section = "missions" | "domains" | "docs" | "issues" | "automation";
const sections: Array<{ id: Section; label: string }> = [
  { id: "missions", label: "任务" },
  { id: "domains", label: "Domain" },
  { id: "docs", label: "Docs" },
  { id: "issues", label: "Issues" },
  { id: "automation", label: "Automation" }
];

export const WorkspacesPanel = ({ store, pickDirectory }: WorkspacesPanelProps) => {
  const client = store((s) => s.client);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.browsingWorkspaceId);
  const view = store((s) => s.view);
  const selectWorkspace = store((s) => s.browseWorkspace);
  const setOpenDocPath = store((s) => s.setOpenDocPath);
  const [section, setSection] = useState<Section>("missions");
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
    <div className="flex h-full min-h-[360px]">
      <aside className="w-56 shrink-0 border-r border-border">
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
      <section className="flex min-w-0 flex-1 flex-col">
        {!activeWorkspaceId ? (
          <Empty title="选择一个 workspace" />
        ) : (
          <>
            <nav className="flex gap-1 border-b border-border px-3" aria-label="workspace 导航">
              {sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "-mb-px border-b px-2 py-2 text-label text-muted-foreground hover:text-foreground",
                    section === item.id ? "border-accent-strong text-strong" : "border-transparent"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto">
              {section === "missions" && <MissionsSection missions={view?.missions ?? []} workItems={view?.workItems ?? []} />}
              {section === "docs" && <DocsSection docs={view?.docs.map((d) => d.path) ?? []} decisions={view?.decisions ?? []} onOpen={setOpenDocPath} />}
              {section === "domains" && <Empty title="Domain 尚未提供" hint="默认一个 workspace 就是一个 Domain；维护者、监控范围和执行规范会在这里配置。" />}
              {section === "issues" && <Empty title="Issues 尚未提供" hint="来自 IM 和 Maintainer 的议题会在这里汇总，经思考流程转化为任务。" />}
              {section === "automation" && <Empty title="Automation 尚未提供" hint="管家、Worker、Supervisor 的调度与运行记录会在这里展示。" />}
            </div>
          </>
        )}
      </section>
    </div>
  );
};

const statusLabel: Record<WorkItem["status"], string> = { queued: "排队中", running: "进行中", review: "待验收", decision: "待决策", closed: "已关闭" };

const MissionsSection = ({ missions, workItems }: { missions: Mission[]; workItems: WorkItem[] }) => {
  if (missions.length === 0) {
    return <p className="px-4 py-3 text-caption text-muted-foreground">还没有任务。去「思考」里和设计伙伴聊出一个。</p>;
  }
  return (
    <ul>
      {missions.map((mission) => {
        const items = workItems.filter((w) => w.missionId === mission.missionId);
        return (
          <li key={mission.missionId} className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="truncate text-label text-strong">{mission.title}</span>
              <Badge tone={mission.status === "active" ? "accent" : "neutral"}>{mission.status}</Badge>
            </div>
            {mission.summary && <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">{mission.summary}</p>}
            <p className="mt-1 font-mono text-micro text-faint-foreground">doc {mission.docCommit.slice(0, 8)} · {new Date(mission.createdAt).toLocaleString()}</p>
            {items.length > 0 && (
              <ul className="mt-2 space-y-1">
                {items.map((item) => (
                  <li key={item.workItemId} className="flex items-center gap-2 text-caption">
                    <Badge>{item.risk}</Badge>
                    <span className="truncate text-foreground">{item.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-micro text-faint-foreground">{statusLabel[item.status]}{item.rejections.length > 0 ? " · 打回 " + item.rejections.length : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
};

const DocsSection = ({ docs, decisions, onOpen }: { docs: string[]; decisions: DecisionCard[]; onOpen: (path: string) => void }) => (
  <div>
    <SectionLabel>文档</SectionLabel>
    {docs.length === 0 ? (
      <p className="px-4 pb-2 text-caption text-muted-foreground">.vermillion/docs 下还没有文件。</p>
    ) : (
      <ul>
        {docs.map((path) => (
          <li key={path}>
            <button type="button" onClick={() => onOpen(path)} className="block w-full truncate px-4 py-1 text-left font-mono text-caption text-foreground hover:bg-surface-hover">{path.replace(/^\.vermillion\/docs\//, "")}</button>
          </li>
        ))}
      </ul>
    )}
    <SectionLabel>决策记录</SectionLabel>
    {decisions.length === 0 ? (
      <p className="px-4 pb-3 text-caption text-muted-foreground">还没有决策卡。</p>
    ) : (
      <ul>
        {decisions.map((card) => (
          <li key={card.decisionId} className="px-4 py-1.5 text-caption">
            <span className="text-foreground">{card.question}</span>
            <span className="ml-2 font-mono text-micro text-faint-foreground">{card.answer ? "→ " + (card.options.find((o) => o.key === card.answer!.key)?.label ?? card.answer.key) : "待回答"}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);
