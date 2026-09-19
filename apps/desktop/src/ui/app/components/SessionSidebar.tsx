import { ChevronDown, ChevronRight, CornerDownRight, Pin, Plus, Search } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { formatRelativeActivityAge } from "../../chat-shell/index.js";
import type { SidebarSession } from "../use-session-sidebar.js";
import type { SessionMenu, SessionRenameController } from "../use-session-actions.js";
import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import { SessionActionFeedback } from "./SessionActionFeedback.js";
import { SessionRenameDialog } from "./SessionRenameDialog.js";
import { Badge, Button, Field, IconButton, ListRow, StatusDot } from "./ui.js";
import { roleLabel } from "./workflow-display.js";

type SessionSidebarProps = {
  sessions: SidebarSession[];
  loading: boolean;
  selectedSessionId: string | undefined;
  isDraft: boolean;
  workspaceLabelById: Map<string, string>;
  workspaceFilterId: string | undefined;
  onWorkspaceFilter: (id: string | undefined) => void;
  onOpen: (sessionId: string) => void;
  onNewChat: () => void;
  onSearch: () => void;
  menu: SessionMenu | undefined;
  onOpenMenu: (event: MouseEvent, sessionId: string, title: string) => void;
  onCloseMenu: () => void;
  onRunAction: (sessionId: string, action: SessionActionDescriptorRpc["action"]) => void;
  renameDialog: SessionRenameController;
  notice: { text: string; error?: boolean } | undefined;
  onClearNotice: () => void;
};

type SessionRowProps = {
  session: SidebarSession;
  depth: number;
  expanded: boolean;
  selected: boolean;
  workspaceLabel: string | undefined;
  onToggleExpanded: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onOpenMenu: (event: MouseEvent, sessionId: string, title: string) => void;
};

/** One session row; subagents render as separate rows, so unchanged rows keep rendering untouched. */
const SessionRow = memo(function SessionRow({ session, depth, expanded, selected, workspaceLabel, onToggleExpanded, onOpen, onOpenMenu }: SessionRowProps) {
  return (
    <ListRow
      depth={depth}
      leadingAction={session.subagents.length > 0 ? (
        <IconButton
          icon={expanded ? ChevronDown : ChevronRight}
          label={`${expanded ? "折叠" : "展开"}子会话：${session.title}`}
          aria-expanded={expanded}
          onClick={() => onToggleExpanded(session.sessionId)}
        />
      ) : <span aria-hidden="true" />}
      selected={selected}
      onClick={() => onOpen(session.sessionId)}
      onContextMenu={(event) => onOpenMenu(event, session.sessionId, session.title)}
      leading={
        <>
          <StatusDot status={session.statusDot} />
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
      meta={workspaceLabel}
      trailing={formatRelativeActivityAge(session.activityAt ?? session.lastCompletedTurnAt)}
    />
  );
});

type SidebarRow = { session: SidebarSession; depth: number; expanded: boolean };

/** Rows in display order: every session, followed by the subagents of the ones that are expanded. */
const flattenRows = (sessions: SidebarSession[], expandedIds: ReadonlySet<string>): SidebarRow[] => {
  const rows: SidebarRow[] = [];
  const push = (session: SidebarSession, depth: number) => {
    const expanded = expandedIds.has(session.sessionId);
    rows.push({ session, depth, expanded });
    if (expanded) session.subagents.forEach((child) => push(child, depth + 1));
  };
  sessions.forEach((session) => push(session, 0));
  return rows;
};

export const SessionSidebar = ({ sessions, loading, selectedSessionId, isDraft, workspaceLabelById, workspaceFilterId, onWorkspaceFilter, onOpen, onNewChat, onSearch, menu, onOpenMenu, onCloseMenu, onRunAction, renameDialog, notice, onClearNotice }: SessionSidebarProps) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((sessionId: string) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    return next;
  }), []);
  const rows = useMemo(() => flattenRows(sessions, expandedIds), [sessions, expandedIds]);
  const selectedRowId = useMemo(
    () => rows.find(({ session }) =>
      session.sessionId === selectedSessionId || Boolean(selectedSessionId && session.memberSessionIds?.includes(selectedSessionId))
    )?.session.sessionId,
    [rows, selectedSessionId]
  );
  const workspaceLabelFor = useCallback(
    (session: SidebarSession) => workspaceFilterId ? undefined : workspaceLabelById.get(session.workspaceId) ?? session.workspaceId,
    [workspaceFilterId, workspaceLabelById]
  );
  const listRef = useRef<HTMLUListElement | null>(null);
  const anchorRef = useRef<{ sessionId: string; offset: number; scrollTop: number } | undefined>(undefined);
  const selectedRowRef = useRef<{ sessionId: string; index: number } | undefined>(undefined);

  /**
   * Keeps the row the reader is looking at in place when the list reorders or grows.
   * A reader who scrolled since the last render owns the position, so that case only re-anchors.
   * The open session outranks that: when its row appears or moves up it is scrolled back into view,
   * because the reorder comes from the reader's own activity in that session.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const domRows = [...list.querySelectorAll<HTMLElement>("[data-session-row]")];
    const anchor = anchorRef.current;
    if (anchor && list.scrollTop === anchor.scrollTop) {
      const row = domRows.find((item) => item.dataset.sessionRow === anchor.sessionId);
      if (row) list.scrollTop += row.getBoundingClientRect().top - top - anchor.offset;
    }
    const selectedIndex = selectedRowId ? domRows.findIndex((row) => row.dataset.sessionRow === selectedRowId) : -1;
    if (selectedIndex >= 0 && selectedRowId) {
      const previous = selectedRowRef.current;
      if (!previous || previous.sessionId !== selectedRowId || selectedIndex < previous.index) {
        domRows[selectedIndex]?.scrollIntoView({ block: "nearest" });
      }
      selectedRowRef.current = { sessionId: selectedRowId, index: selectedIndex };
    } else {
      selectedRowRef.current = undefined;
    }
    const leading = domRows.find((row) => row.getBoundingClientRect().bottom > top);
    anchorRef.current = leading?.dataset.sessionRow
      ? { sessionId: leading.dataset.sessionRow, offset: leading.getBoundingClientRect().top - top, scrollTop: list.scrollTop }
      : undefined;
  });

  return (
    <aside className="flex h-full w-[296px] shrink-0 flex-col border-r border-border-strong bg-app-shell">
      <header className="px-4 pt-3"><span className="eyebrow">工作台</span></header>
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <Button variant={isDraft ? "secondary" : "accent"} size="sm" className="shrink-0" onClick={onNewChat}>
          <Plus size={13} /> 新建会话
        </Button>
        <Field kind="select" compact aria-label="筛选 workspace" className="min-w-0 flex-1" value={workspaceFilterId ?? ""} onChange={(event) => onWorkspaceFilter(event.target.value || undefined)}>
          <option value="">全部</option>
          {[...workspaceLabelById].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Field>
      </div>
      <div className="px-3 pb-2">
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onSearch}>
          <Search size={13} /> 搜索
        </Button>
      </div>
      <ul ref={listRef} className="vm-session-list min-h-0 flex-1 overflow-auto">
        {isDraft && (
          <li><ListRow selected title="新对话" meta="发送第一条消息后创建" /></li>
        )}
        {sessions.length === 0 && !isDraft && !loading && <li className="px-4 py-2 text-caption text-muted-foreground">还没有会话。点新建会话开始。</li>}
        {rows.map(({ session, depth, expanded }) => (
          <li key={session.sessionId} data-session-row={session.sessionId}>
            <SessionRow
              session={session}
              depth={depth}
              expanded={expanded}
              selected={selectedSessionId === session.sessionId || Boolean(selectedSessionId && session.memberSessionIds?.includes(selectedSessionId))}
              workspaceLabel={workspaceLabelFor(session)}
              onToggleExpanded={toggleExpanded}
              onOpen={onOpen}
              onOpenMenu={onOpenMenu}
            />
          </li>
        ))}
      </ul>
      <SessionActionFeedback menu={menu} onCloseMenu={onCloseMenu} onRunAction={onRunAction} onOpenRename={renameDialog.open} notice={notice} onClearNotice={onClearNotice} />
      {renameDialog.state && (
        <SessionRenameDialog
          title={renameDialog.state.title}
          busy={renameDialog.state.busy}
          error={renameDialog.state.error}
          onSubmit={renameDialog.submit}
          onClose={renameDialog.close}
        />
      )}
    </aside>
  );
};
