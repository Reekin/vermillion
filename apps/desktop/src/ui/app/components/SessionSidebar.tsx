import { ChevronDown, ChevronRight, CornerDownRight, Pin, Plus } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { formatRelativeCompletedTurnAge } from "../../chat-shell/index.js";
import type { SidebarSession } from "../use-session-sidebar.js";
import type { SessionMenu } from "../use-session-actions.js";
import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import { SessionActionFeedback } from "./SessionActionFeedback.js";
import { Badge, Button, Field, IconButton, ListRow } from "./ui.js";
import { roleLabel } from "./workflow-display.js";

type SessionSidebarProps = {
  sessions: SidebarSession[];
  hasMore: boolean;
  loading: boolean;
  loadMore: () => Promise<void>;
  selectedSessionId: string | undefined;
  isDraft: boolean;
  workspaceLabelById: Map<string, string>;
  workspaceFilterId: string | undefined;
  onWorkspaceFilter: (id: string | undefined) => void;
  onOpen: (sessionId: string) => void;
  onNewChat: () => void;
  menu: SessionMenu | undefined;
  onOpenMenu: (event: MouseEvent, sessionId: string) => void;
  onCloseMenu: () => void;
  onRunAction: (sessionId: string, action: SessionActionDescriptorRpc["action"]) => void;
  notice: { text: string; error?: boolean } | undefined;
  onClearNotice: () => void;
};

export const SessionSidebar = ({ sessions, hasMore, loading, loadMore, selectedSessionId, isDraft, workspaceLabelById, workspaceFilterId, onWorkspaceFilter, onOpen, onNewChat, menu, onOpenMenu, onCloseMenu, onRunAction, notice, onClearNotice }: SessionSidebarProps) => {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = (sessionId: string) => setCollapsedIds((current) => {
    const next = new Set(current);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    return next;
  });
  /** A session row; subagents it spawned render nested beneath it, indented one level per depth. */
  const renderRow = (session: SidebarSession, depth = 0) => (
    <li key={session.sessionId}>
      <ListRow
        depth={depth}
        leadingAction={session.subagents.length > 0 && (
          <IconButton
            icon={collapsedIds.has(session.sessionId) ? ChevronRight : ChevronDown}
            label={`${collapsedIds.has(session.sessionId) ? "展开" : "折叠"}子会话：${session.title}`}
            aria-expanded={!collapsedIds.has(session.sessionId)}
            onClick={() => toggleCollapsed(session.sessionId)}
          />
        )}
        selected={selectedSessionId === session.sessionId || Boolean(selectedSessionId && session.memberSessionIds?.includes(selectedSessionId))}
        onClick={() => onOpen(session.sessionId)}
        onContextMenu={(event) => onOpenMenu(event, session.sessionId)}
        leading={
          <>
            {depth > 0 && <CornerDownRight size={11} className="shrink-0 text-faint-foreground" aria-label="subagent" />}
            {session.role && session.role !== "design-partner" && <Badge>{roleLabel[session.role] ?? session.role}</Badge>}
          </>
        }
        title={
          <>
            {session.title}
            {session.isPinned && <Pin size={11} className="ml-1 inline shrink-0 align-[-1px] text-faint-foreground" aria-label="pinned" />}
          </>
        }
        meta={!workspaceFilterId ? workspaceLabelById.get(session.workspaceId) ?? session.workspaceId : undefined}
        trailing={formatRelativeCompletedTurnAge(session.lastCompletedTurnAt ?? session.activityAt)}
      />
      {session.subagents.length > 0 && !collapsedIds.has(session.sessionId) && (
        <ul>{session.subagents.map((child) => renderRow({ ...child, workspaceId: session.workspaceId, sortAt: session.sortAt }, depth + 1))}</ul>
      )}
    </li>
  );

  return (
    <aside className="flex h-full w-[296px] shrink-0 flex-col border-r border-border-strong bg-app-shell">
      <header className="px-4 pt-3"><span className="eyebrow">工作台</span></header>
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <Button variant={isDraft ? "secondary" : "accent"} size="sm" className="shrink-0" onClick={onNewChat}>
          <Plus size={13} /> New Chat
        </Button>
        <Field kind="select" compact aria-label="筛选 workspace" className="min-w-0 flex-1" value={workspaceFilterId ?? ""} onChange={(event) => onWorkspaceFilter(event.target.value || undefined)}>
          <option value="">All</option>
          {[...workspaceLabelById].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Field>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {isDraft && (
          <li><ListRow selected title="新对话" meta="发送第一条消息后创建" /></li>
        )}
        {sessions.length === 0 && !isDraft && !loading && <li className="px-4 py-2 text-caption text-muted-foreground">还没有会话。点 New Chat 开始。</li>}
        {sessions.map((session) => renderRow(session))}
        {hasMore && (
          <li className="px-3 py-2">
            <Button size="sm" variant="ghost" className="w-full" disabled={loading} onClick={() => void loadMore()}>{loading ? "加载中…" : "加载更多"}</Button>
          </li>
        )}
      </ul>
      <SessionActionFeedback menu={menu} onCloseMenu={onCloseMenu} onRunAction={onRunAction} notice={notice} onClearNotice={onClearNotice} />
    </aside>
  );
};
