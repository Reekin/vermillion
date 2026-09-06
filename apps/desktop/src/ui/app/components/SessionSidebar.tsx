import { ListTree, Pin, Plus } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";
import { formatRelativeCompletedTurnAge } from "../../chat-shell/index.js";
import type { SidebarSession } from "../use-session-sidebar.js";
import type { SessionMenu } from "../use-session-actions.js";
import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import { cn } from "../lib/cn.js";
import { Button, SectionLabel } from "./ui.js";
import { ContextMenu } from "./ContextMenu.js";

type SessionSidebarProps = {
  sessions: SidebarSession[];
  hasMore: boolean;
  loading: boolean;
  loadMore: () => Promise<void>;
  selectedSessionId: string | undefined;
  isDraft: boolean;
  workspaceLabelById: Map<string, string>;
  onOpen: (sessionId: string) => void;
  onNewChat: () => void;
  menu: SessionMenu | undefined;
  onOpenMenu: (event: MouseEvent, sessionId: string) => void;
  onCloseMenu: () => void;
  onRunAction: (sessionId: string, action: SessionActionDescriptorRpc["action"]) => void;
  notice: { text: string; error?: boolean } | undefined;
  onClearNotice: () => void;
};

export const SessionSidebar = ({ sessions, hasMore, loading, loadMore, selectedSessionId, isDraft, workspaceLabelById, onOpen, onNewChat, menu, onOpenMenu, onCloseMenu, onRunAction, notice, onClearNotice }: SessionSidebarProps) => {
  const [grouped, setGrouped] = useState(false);

  const groups = useMemo(() => {
    if (!grouped) return undefined;
    const byWorkspace = new Map<string, SidebarSession[]>();
    for (const session of sessions) {
      const list = byWorkspace.get(session.workspaceId) ?? [];
      list.push(session);
      byWorkspace.set(session.workspaceId, list);
    }
    return [...byWorkspace.entries()];
  }, [grouped, sessions]);

  const renderRow = (session: SidebarSession) => (
    <li key={session.sessionId}>
      <button
        type="button"
        onClick={() => onOpen(session.sessionId)}
        onContextMenu={(event) => onOpenMenu(event, session.sessionId)}
        className={cn(
          "relative flex w-full flex-col gap-0.5 px-4 py-2 text-left hover:bg-surface-hover",
          selectedSessionId === session.sessionId && "bg-surface-selected before:absolute before:bottom-[5px] before:left-0 before:top-[5px] before:w-0.5 before:bg-accent"
        )}
      >
        <span className="flex items-center gap-2">
          {session.statusDot === "running" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong" aria-label="running" />}
          <span className="truncate text-label text-strong">{session.title}</span>
          {session.isPinned && <Pin size={11} className="ml-auto shrink-0 text-faint-foreground" aria-label="pinned" />}
        </span>
        <span className="flex items-center gap-2 font-mono text-micro text-faint-foreground">
          {!grouped && <span className="truncate">{workspaceLabelById.get(session.workspaceId) ?? session.workspaceId}</span>}
          <span className="ml-auto shrink-0">{formatRelativeCompletedTurnAge(session.lastCompletedTurnAt ?? session.activityAt)}</span>
        </span>
      </button>
    </li>
  );

  return (
    <aside className="flex h-full w-[296px] shrink-0 flex-col border-r border-border-strong bg-app-shell">
      <header className="px-4 pt-3"><span className="eyebrow">思考</span></header>
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <Button variant={isDraft ? "secondary" : "accent"} size="sm" className="flex-1" onClick={onNewChat} disabled={isDraft}>
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
        {isDraft && (
          <li className="relative bg-surface-selected px-4 py-2 before:absolute before:bottom-[5px] before:left-0 before:top-[5px] before:w-0.5 before:bg-accent">
            <span className="text-label text-strong">新对话</span>
            <span className="block font-mono text-micro text-faint-foreground">发送第一条消息后创建</span>
          </li>
        )}
        {sessions.length === 0 && !isDraft && !loading && <li className="px-4 py-2 text-caption text-muted-foreground">还没有会话。点 New Chat 开始。</li>}
        {groups
          ? groups.map(([workspaceId, list]) => (
              <li key={workspaceId}>
                <SectionLabel>{workspaceLabelById.get(workspaceId) ?? workspaceId}</SectionLabel>
                <ul>{list.map(renderRow)}</ul>
              </li>
            ))
          : sessions.map(renderRow)}
        {hasMore && (
          <li className="px-3 py-2">
            <Button size="sm" variant="ghost" className="w-full" disabled={loading} onClick={() => void loadMore()}>{loading ? "加载中…" : "加载更多"}</Button>
          </li>
        )}
      </ul>
      {notice && (
        <div role="status" className={cn("flex items-start gap-2 border-t border-border px-4 py-2 text-caption", notice.error ? "text-strong" : "text-muted-foreground")}>
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          {notice.error && <button type="button" className="shrink-0 text-faint-foreground hover:text-foreground" onClick={onClearNotice}>关闭</button>}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={onCloseMenu}
          items={menu.actions.map((action) => ({
            key: action.action,
            label: action.label,
            disabled: action.disabled,
            title: action.reason,
            onSelect: () => onRunAction(menu.sessionId, action.action)
          }))}
        />
      )}
    </aside>
  );
};
