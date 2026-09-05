import { ListTree, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { SidebarRenderContext } from "../../chat-shell/ChatShellApp.js";
import { formatRelativeCompletedTurnAge } from "../../chat-shell/ChatShellApp.js";
import type { SessionBrowserViewNode } from "../../chat-shell/workspace-browser-tree.js";
import { cn } from "../lib/cn.js";
import { Button, SectionLabel } from "./ui.js";

type SessionListProps = SidebarRenderContext & {
  activeWorkspaceId?: string;
  workspaceLabelById: Map<string, string>;
};

type Row = SessionBrowserViewNode & { workspaceLabel: string };

/** Flat list of sessions ordered by last completed turn; optional grouping by workspace. */
export const SessionList = ({ workspaceTree, displayedSessionId, onOpenSession, onCreateSession, activeWorkspaceId, workspaceLabelById }: SessionListProps) => {
  const [grouped, setGrouped] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const all = workspaceTree.flatMap((workspace) =>
      workspace.sessions.map((session) => ({ ...session, workspaceLabel: workspaceLabelById.get(workspace.workspaceId) ?? workspace.label }))
    );
    return all.sort((a, b) => (b.lastCompletedTurnAt ?? b.activityAt ?? "").localeCompare(a.lastCompletedTurnAt ?? a.activityAt ?? ""));
  }, [workspaceTree, workspaceLabelById]);

  const groups = useMemo(() => {
    if (!grouped) return undefined;
    const byWorkspace = new Map<string, Row[]>();
    for (const row of rows) {
      const list = byWorkspace.get(row.workspaceId) ?? [];
      list.push(row);
      byWorkspace.set(row.workspaceId, list);
    }
    return [...byWorkspace.entries()].map(([workspaceId, sessions]) => ({ workspaceId, label: sessions[0]!.workspaceLabel, sessions }));
  }, [grouped, rows]);

  const renderRow = (row: Row) => (
    <li key={row.sessionId}>
      <button
        type="button"
        onClick={() => void onOpenSession(row.sessionId)}
        className={cn(
          "relative flex w-full flex-col gap-0.5 px-4 py-2 text-left hover:bg-surface-hover",
          displayedSessionId === row.sessionId && "bg-surface-selected before:absolute before:bottom-[5px] before:left-0 before:top-[5px] before:w-0.5 before:bg-accent"
        )}
      >
        <span className="flex items-center gap-2">
          {row.statusDot === "running" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong" aria-label="running" />}
          <span className="truncate text-label text-strong">{row.title}</span>
        </span>
        <span className="flex items-center gap-2 font-mono text-micro text-faint-foreground">
          {!grouped && <span className="truncate">{row.workspaceLabel}</span>}
          <span className="ml-auto shrink-0">{formatRelativeCompletedTurnAge(row.lastCompletedTurnAt ?? row.activityAt)}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <Button variant="accent" size="sm" className="flex-1" disabled={!activeWorkspaceId} onClick={() => activeWorkspaceId && void onCreateSession(activeWorkspaceId)}>
          <Plus size={13} /> New Chat
        </Button>
        <button
          type="button"
          aria-pressed={grouped}
          title={grouped ? "平铺显示" : "按 workspace 分组"}
          onClick={() => setGrouped((v) => !v)}
          className={cn("flex h-7 w-7 items-center justify-center rounded-lg text-faint-foreground hover:bg-surface-hover hover:text-foreground", grouped && "bg-surface-selected text-strong")}
        >
          <ListTree size={14} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && <li className="px-4 py-2 text-caption text-muted-foreground">还没有会话。点 New Chat 开始。</li>}
        {groups
          ? groups.map((group) => (
              <li key={group.workspaceId}>
                <SectionLabel>{group.label}</SectionLabel>
                <ul>{group.sessions.map(renderRow)}</ul>
              </li>
            ))
          : rows.map(renderRow)}
      </ul>
    </div>
  );
};
