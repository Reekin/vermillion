import { CornerDownRight, ListTree, Pin, Plus } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";
import { formatRelativeCompletedTurnAge } from "../../chat-shell/index.js";
import type { SidebarSession } from "../use-session-sidebar.js";
import type { SessionMenu } from "../use-session-actions.js";
import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import { cn } from "../lib/cn.js";
import { Button, IconButton, ListRow, SectionLabel, StatusDot } from "./ui.js";
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

  /** A session row; subagents it spawned render nested beneath it, indented one level per depth. */
  const renderRow = (session: SidebarSession, depth = 0) => (
    <li key={session.sessionId}>
      <ListRow
        depth={depth}
        selected={selectedSessionId === session.sessionId}
        onClick={() => onOpen(session.sessionId)}
        onContextMenu={(event) => onOpenMenu(event, session.sessionId)}
        leading={
          <>
            {depth > 0 && <CornerDownRight size={11} className="shrink-0 text-faint-foreground" aria-label="subagent" />}
            <StatusDot status={session.statusDot} />
          </>
        }
        title={
          <>
            {session.title}
            {session.isPinned && <Pin size={11} className="ml-1 inline shrink-0 align-[-1px] text-faint-foreground" aria-label="pinned" />}
          </>
        }
        meta={!grouped && depth === 0 ? (workspaceLabelById.get(session.workspaceId) ?? session.workspaceId) : undefined}
        trailing={formatRelativeCompletedTurnAge(session.lastCompletedTurnAt ?? session.activityAt)}
      />
      {session.subagents.length > 0 && (
        <ul>{session.subagents.map((child) => renderRow({ ...child, workspaceId: session.workspaceId, sortAt: session.sortAt }, depth + 1))}</ul>
      )}
    </li>
  );

  return (
    <aside className="flex h-full w-[296px] shrink-0 flex-col border-r border-border-strong bg-app-shell">
      <header className="px-4 pt-3"><span className="eyebrow">思考</span></header>
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <Button variant={isDraft ? "secondary" : "accent"} size="sm" className="flex-1" onClick={onNewChat} disabled={isDraft}>
          <Plus size={13} /> New Chat
        </Button>
        <IconButton icon={ListTree} label={grouped ? "平铺显示" : "按 workspace 分组"} active={grouped} onClick={() => setGrouped((v) => !v)} />
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {isDraft && (
          <li><ListRow selected title="新对话" meta="发送第一条消息后创建" /></li>
        )}
        {sessions.length === 0 && !isDraft && !loading && <li className="px-4 py-2 text-caption text-muted-foreground">还没有会话。点 New Chat 开始。</li>}
        {groups
          ? groups.map(([workspaceId, list]) => (
              <li key={workspaceId}>
                <SectionLabel>{workspaceLabelById.get(workspaceId) ?? workspaceId}</SectionLabel>
                <ul>{list.map((session) => renderRow(session))}</ul>
              </li>
            ))
          : sessions.map((session) => renderRow(session))}
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
