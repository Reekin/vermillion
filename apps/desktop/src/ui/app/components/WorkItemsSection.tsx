import { ChevronDown, ChevronRight, Copy, MessageSquare, Pause, Play, Plus, RotateCw, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type AgentRun, type DecisionCard, type Scheduler, type WorkItem, type WorkbenchClient, type WorkflowAction, type WorkRequest } from "@vermillion/workbench/client";
import { writeClipboardText } from "../../chat-shell/clipboard.js";
import type { TaskTarget, WorkbenchState } from "../workbench-store.js";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog.js";
import { Modal } from "./Modal.js";
import { SupervisorDetails } from "./SupervisorDetails.js";
import { PendingDecision, WorkItemDialog } from "./WorkItemDialog.js";
import { statusTone, workItemBoardLabel, workRequestStatus } from "./task-labels.js";
import { Alert, Badge, Button, CollapsibleDetails, EmptyState, Field, FilterChip, IconButton, InlineNotice, ListRow, OverflowMenu, PageHeader, Progress, SegmentedControl, StatusIcon, StatusPill, Stepper, Toggle, type StatusTone } from "./ui.js";
import { formatDuration, pendingRequestDecisions, readableActionError, workItemAttention, workItemProgress, type Attention } from "./workflow-display.js";
import {
  boardSectionLabel, entryContains, filterShowing, isOpenWorkItem, visibleBoard, workBoard, workBoardCounts, workExpansionKey,
  type BoardEntry, type BoardFilter, type BoardSection
} from "./work-board-display.js";

const relativeTime = (iso: string) => {
  const date = new Date(iso);
  const now = new Date();
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return Math.floor(minutes / 60) + " 小时前";
  if (date.toDateString() === yesterday.toDateString()) return "昨天 " + time;
  return (date.getMonth() + 1) + "月" + date.getDate() + "日";
};
const fullTime = (iso: string) => new Date(iso).toLocaleString("zh-CN");

const itemState = (item: WorkItem, attention?: Attention): { tone: StatusTone; icon?: LucideIcon } => {
  if (item.status === "closed") return { tone: "done" };
  if (item.status === "cancelled") return { tone: "neutral" };
  if (attention) return attention.action === "retry" ? { tone: "failed" } : { tone: "attention", icon: attention.action === "resume" ? Pause : undefined };
  if (item.run.activeTurnId && item.run.turnStatus !== "unknown") return { tone: "running" };
  return { tone: "waiting" };
};

const commitOf = (items: WorkItem[]) => items.filter((item) => item.merge?.commit).sort((a, b) => (b.merge!.mergedAt).localeCompare(a.merge!.mergedAt))[0]?.merge?.commit;

type ItemHandlers = {
  busy: boolean;
  onOpen: (workItemId: string) => void;
  onOpenSession: (sessionId: string, turnId?: string) => void;
  onItemAction: (method: "workItem.pause" | "workItem.resume" | "workItem.retry" | "workItem.cancel", workItemId: string) => void;
};

/** One work item: state, risk, title, stage or wait reason, time; controls appear on hover in fixed slots. */
const WorkItemRow = ({ item, run, actions, waitingFor, attention, handlers }: {
  item: WorkItem; run?: AgentRun; actions: WorkflowAction[]; waitingFor: string[]; attention?: Attention; handlers: ItemHandlers;
}) => {
  const open = isOpenWorkItem(item);
  const progress = workItemProgress(item, actions, run, waitingFor);
  const state = itemState(item, attention);
  const running = open && run?.status === "running" && item.run.activeTurnId;
  // The cause itself is told once, in the alert; the row keeps a short stage label.
  const stage = attention?.action === "decision" ? "等待决策" : attention ? workItemBoardLabel(item, progress.shortLabel)
    : waitingFor.length ? "等待 " + waitingFor.join("、")
    : workItemBoardLabel(item, progress.shortLabel) + (open && run?.turns ? " · 第 " + run.turns + " 轮" : "");
  const sessionId = item.run.sessionId ?? run?.sessionId;
  const stopped = item.run.paused || item.run.userStopped;
  return <div data-task-id={item.workItemId}>
    <ListRow title={item.title} onClick={() => handlers.onOpen(item.workItemId)} cells={{
      state: <StatusIcon tone={state.tone} icon={state.icon} label={stage} />,
      tag: <Badge>{item.risk}</Badge>, stage, muted: !open, timeTitle: fullTime(item.updatedAt),
      time: running && run ? "已运行 " + formatDuration(Date.now() - Date.parse(run.startedAt)) : relativeTime(item.updatedAt),
      controls: [
        open && (stopped
          ? <IconButton icon={Play} label={"恢复：" + item.title} disabled={handlers.busy} onClick={() => handlers.onItemAction("workItem.resume", item.workItemId)} />
          : attention?.action === "retry" ? <IconButton icon={RotateCw} label={"重试：" + item.title} disabled={handlers.busy} onClick={() => handlers.onItemAction("workItem.retry", item.workItemId)} />
          : <IconButton icon={Pause} label={"暂停：" + item.title} disabled={handlers.busy} onClick={() => handlers.onItemAction("workItem.pause", item.workItemId)} />),
        sessionId && <IconButton icon={MessageSquare} label={"打开执行会话：" + item.title} onClick={() => handlers.onOpenSession(sessionId)} />,
        open && <IconButton icon={X} label={"取消工单：" + item.title} disabled={handlers.busy} onClick={() => handlers.onItemAction("workItem.cancel", item.workItemId)} />
      ]
    }} />
  </div>;
};

type WorkHandlers = ItemHandlers & {
  onWorkAction: (method: "work.pause" | "work.resume" | "work.retry" | "work.cancel", requestId: string) => void;
  onOpenWork: (requestId: string) => void;
};

/** Cause, next step and the matching controls for an entry that needs the user. */
const AttentionAlert = ({ entry, attention, subject, handlers, sessionId, controls = true }: {
  entry: BoardEntry; attention: Attention & { itemId?: string }; subject?: string; handlers: WorkHandlers; sessionId?: string;
  /** Off inside work detail, which carries the same controls in its own action row. */
  controls?: boolean;
}) => {
  const [copied, setCopied] = useState<"done" | "failed">();
  const itemId = attention.itemId ?? (entry.kind === "item" ? entry.id : undefined);
  const resume = () => itemId ? handlers.onItemAction("workItem.resume", itemId) : handlers.onWorkAction("work.resume", entry.id);
  const retry = () => itemId ? handlers.onItemAction("workItem.retry", itemId) : handlers.onWorkAction("work.retry", entry.id);
  const detail = () => itemId ? handlers.onOpen(itemId) : handlers.onOpenWork(entry.id);
  const action = attention.action;
  return <Alert tone={action === "retry" ? "error" : "attention"} title={(subject ? subject + "：" : "") + attention.title} next={attention.next}
    actions={<>
      {attention.command && <Button size="sm" variant="ghost" onClick={() => void writeClipboardText(attention.command!).then(() => setCopied("done"), () => setCopied("failed"))}>
        <Copy size={14} aria-hidden="true" />{copied === "done" ? "已复制" : copied === "failed" ? "复制失败" : "复制取消归档命令"}
      </Button>}
      {controls && action === "resume" && <Button size="sm" disabled={handlers.busy} onClick={resume}><Play size={14} aria-hidden="true" />恢复</Button>}
      {controls && action === "retry" && <Button size="sm" disabled={handlers.busy} onClick={retry}><RotateCw size={14} aria-hidden="true" />重试</Button>}
      {controls && action === "decision" && <Button size="sm" onClick={detail}>回复决策</Button>}
      {controls && action === "detail" && <Button size="sm" onClick={detail}>查看详情</Button>}
      {action === "session" && sessionId && <Button size="sm" onClick={() => handlers.onOpenSession(sessionId)}><MessageSquare size={14} aria-hidden="true" />打开会话</Button>}
    </>} />;
};

type RowContext = { runsFor: (item: WorkItem) => AgentRun | undefined; waitingFor: (item: WorkItem) => string[]; actions: WorkflowAction[]; attentionOf: (item: WorkItem) => Attention | undefined };

const itemRow = (item: WorkItem, context: RowContext, handlers: ItemHandlers) => <WorkItemRow key={item.workItemId} item={item} run={context.runsFor(item)}
  actions={context.actions} waitingFor={context.waitingFor(item)} attention={context.attentionOf(item)} handlers={handlers} />;

/** An unfinished work: name, source and timing, state and merge progress, the attention alert and its items. */
const WorkCard = ({ entry, title, sourceTitle, context, handlers }: {
  entry: Extract<BoardEntry, { kind: "work" }>; title: string; sourceTitle: string; context: RowContext; handlers: WorkHandlers;
}) => {
  const { request, items } = entry;
  const state = workRequestStatus(request, items);
  const counted = items.filter((item) => item.status !== "cancelled");
  const merged = counted.filter((item) => item.status === "closed").length;
  const attentionItem = entry.attention?.itemId ? items.find((item) => item.workItemId === entry.attention!.itemId) : undefined;
  const menu = [
    { label: "工作详情", onSelect: () => handlers.onOpenWork(entry.id) },
    request.paused || request.userStopped ? { label: "恢复全部推进", onSelect: () => handlers.onWorkAction("work.resume", entry.id), disabled: handlers.busy }
      : { label: "暂停全部", onSelect: () => handlers.onWorkAction("work.pause", entry.id), disabled: handlers.busy },
    ...(request.status === "failed" && !request.paused ? [{ label: "重试准备", onSelect: () => handlers.onWorkAction("work.retry", entry.id), disabled: handlers.busy }] : []),
    { label: "取消剩余工作", onSelect: () => handlers.onWorkAction("work.cancel", entry.id), disabled: handlers.busy }
  ];
  return <article className="vm-work-card" data-attention={entry.section === "attention" || undefined}>
    <header className="vm-work-card__head">
      <button type="button" className="vm-work-card__title" title={title} onClick={() => handlers.onOpenWork(entry.id)}>{title}</button>
      <div className="vm-work-card__side">
        {counted.length > 0 && <Progress label={merged + " / " + counted.length + " 已合入"}
          segments={counted.map((item) => item.status === "closed" ? "done" : item.run.lastFailure && !item.run.activeTurnId ? "failed" : item.run.activeTurnId ? "running" : "pending")} />}
        <StatusPill tone={statusTone(state.status)}>{state.label}</StatusPill>
        <OverflowMenu label={"工作操作：" + title} items={menu} />
      </div>
      <div className="vm-work-card__meta">
        <button type="button" className="vm-board-link" onClick={() => handlers.onOpenSession(request.sourceSessionId, request.sourceTurnId)}>
          <MessageSquare size={12} aria-hidden="true" />{sourceTitle}
        </button>
        <span aria-hidden="true">·</span>
        <span title={fullTime(request.createdAt)}>{relativeTime(request.createdAt)}开工</span>
        <span aria-hidden="true">·</span>
        <span>{items.length ? items.length + " 张工单" : request.status === "ready" ? "没有工单" : "还没有工单"}</span>
      </div>
    </header>
    {entry.attention && <div className="vm-work-card__alert">
      <AttentionAlert entry={entry} attention={entry.attention} subject={attentionItem?.title} handlers={handlers}
        sessionId={attentionItem ? attentionItem.run.sessionId : request.workerSessionId} />
    </div>}
    {items.length > 0 && <div className="vm-work-card__items">{items.map((item) => itemRow(item, context, handlers))}</div>}
  </article>;
};

/** Compact line for an ended work or item; a multi-item work expands to show its items. */
const EndedRow = ({ entry, title, expanded, onToggle, context, handlers }: {
  entry: BoardEntry; title: string; expanded: boolean; onToggle: () => void; context: RowContext; handlers: WorkHandlers;
}) => {
  const items = entry.kind === "work" ? entry.items : [entry.item];
  const closed = items.filter((item) => item.status === "closed").length;
  const cancelled = entry.kind === "work" && entry.request.status === "cancelled" && !items.length;
  const tone: StatusTone = closed ? "done" : "neutral";
  const commit = commitOf(items);
  const result = cancelled || !closed ? "已取消" : closed < items.length ? "部分取消" : commit ? undefined : "已完成";
  const multi = entry.kind === "work" && items.length > 1;
  const sessionId = entry.kind === "item" ? entry.item.run.sessionId : entry.request.workerSessionId;
  const open = () => entry.kind === "item" ? handlers.onOpen(entry.id) : items.length === 1 ? handlers.onOpen(items[0]!.workItemId) : handlers.onOpenWork(entry.id);
  return <>
    <div data-task-id={entry.kind === "item" ? entry.id : items.length === 1 ? items[0]!.workItemId : undefined}>
      <ListRow title={title} onClick={open} cells={{
        state: <StatusIcon tone={tone} label={result ?? "已合入"} />,
        tag: multi && <IconButton icon={expanded ? ChevronDown : ChevronRight} label={(expanded ? "收起" : "展开") + "工单：" + title} active={expanded} onClick={onToggle} />,
        stage: <>
          {commit && <span className="vm-board-commit" title={commit}>{commit.slice(0, 7)}</span>}
          {result && <span>{result}</span>}
          {multi && <span>{items.length} 张工单</span>}
        </>,
        time: relativeTime(entry.updatedAt), timeTitle: fullTime(entry.updatedAt), muted: true, compact: true,
        controls: [null, sessionId && <IconButton icon={MessageSquare} label={"打开会话：" + title} onClick={() => handlers.onOpenSession(sessionId)} />, null]
      }} />
    </div>
    {multi && expanded && <div className="vm-board-nested">{items.map((item) => itemRow(item, context, handlers))}</div>}
  </>;
};

type WorkItemsSectionProps = {
  decisions?: DecisionCard[];
  sourceTitles: Record<string, string>; client: WorkbenchClient; workspaceId: string; scheduler: Scheduler; workItems: WorkItem[]; workRequests: WorkRequest[]; runs: AgentRun[]; actions: WorkflowAction[];
  onOpenSession: (sessionId: string, turnId?: string) => void;
  expandedWorkGroups: WorkbenchState["expandedWorkGroups"];
  setWorkGroupExpanded: WorkbenchState["setWorkGroupExpanded"];
  detailTarget?: { workspaceId: string; workItemId: string; nonce: number };
  onDetailTargetConsumed?: () => void;
  onOpenIssue?: (issueId: string) => void;
  /** Task picked from the status bar: bring it into view once. */
  taskTarget?: TaskTarget;
};

const countTone: Record<BoardSection, StatusTone> = { attention: "attention", active: "running", ended: "neutral" };

export const WorkItemsSection = ({ sourceTitles, client, workspaceId, scheduler, workItems, workRequests, runs, actions, decisions = [], onOpenSession, onOpenIssue, taskTarget, detailTarget, onDetailTargetConsumed, expandedWorkGroups, setWorkGroupExpanded }: WorkItemsSectionProps) => {
  const board = useRef<HTMLDivElement>(null);
  const located = useRef<TaskTarget | undefined>(undefined);
  const entries = useMemo(() => workBoard({ requests: workRequests, items: workItems, decisions, actions }), [workRequests, workItems, decisions, actions]);
  const counts = workBoardCounts(entries);
  const [filter, setFilter] = useState<BoardFilter>("open");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<{ workspaceId: string; workItemId: string }>();
  const [workDetail, setWorkDetail] = useState<string>();
  const sourceTitleOf = (entry: BoardEntry) => (entry.treeId && sourceTitles[entry.treeId]) || "来源会话";
  const titleOf = (entry: BoardEntry) => entry.kind === "item" ? entry.item.title : entry.request.scope?.trim() || sourceTitleOf(entry);
  const needle = query.trim().toLowerCase();
  const matches = (entry: BoardEntry) => !needle || titleOf(entry).toLowerCase().includes(needle)
    || (entry.kind === "work" && entry.items.some((item) => item.title.toLowerCase().includes(needle)));
  const groups = visibleBoard(entries, filter, matches);
  const isExpanded = (requestId: string) => expandedWorkGroups[workspaceId + "/" + workExpansionKey(requestId)] === true;

  /** Makes a work item visible: widen the filter, drop a hiding query, expand its ended work. Returns true once it is rendered. */
  const reveal = (workItemId: string) => {
    const entry = entries.find((candidate) => entryContains(candidate, workItemId));
    if (!entry) return false;
    const needed = filterShowing(entries, workItemId, filter);
    if (needed !== filter) { setFilter(needed); return false; }
    if (!matches(entry)) { setQuery(""); return false; }
    if (entry.kind === "work" && entry.section === "ended" && entry.items.length > 1 && !isExpanded(entry.id)) {
      setWorkGroupExpanded(workspaceId, workExpansionKey(entry.id), true);
      return false;
    }
    return true;
  };
  useEffect(() => {
    if (!taskTarget || located.current === taskTarget || !reveal(taskTarget.id)) return;
    const row = board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskTarget.id)}"]`);
    if (row) { row.scrollIntoView({ block: "start" }); located.current = taskTarget; }
  }, [taskTarget, entries, filter, query, expandedWorkGroups]);
  useEffect(() => {
    if (!detailTarget || detailTarget.workspaceId !== workspaceId) return;
    if (!workItems.some((item) => item.workItemId === detailTarget.workItemId) || !reveal(detailTarget.workItemId)) return;
    board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(detailTarget.workItemId)}"]`)?.scrollIntoView({ block: "nearest" });
    setDetail({ workspaceId, workItemId: detailTarget.workItemId });
    onDetailTargetConsumed?.();
  }, [detailTarget, entries, filter, query, expandedWorkGroups, onDetailTargetConsumed, workItems, workspaceId]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (caught) { setError(readableActionError(caught)); }
    finally { setBusy(false); }
  };
  const setScheduler = (value: Partial<Scheduler>) => void perform(() => client.request("scheduler.set", { workspaceId, value: { ...scheduler, ...value } }));
  const latestRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const context: RowContext = {
    actions,
    runsFor: (item) => latestRuns.find((run) => run.workItemId === item.workItemId && (!item.run.sessionId || run.sessionId === item.run.sessionId)),
    waitingFor: (item) => item.status === "queued" ? item.dependsOn.flatMap((id) => {
      const dependency = workItems.find((candidate) => candidate.workItemId === id);
      return dependency?.status === "closed" ? [] : [dependency ? dependency.title + (dependency.status === "cancelled" ? "（已取消）" : "") : id];
    }) : [],
    attentionOf: (item) => workItemAttention(item, actions, decisions)
  };
  const handlers: WorkHandlers = {
    busy, onOpenSession,
    onOpen: (workItemId) => setDetail({ workspaceId, workItemId }),
    onOpenWork: setWorkDetail,
    onItemAction: (method, workItemId) => void perform(() => client.request(method, { workspaceId, workItemId })),
    onWorkAction: (method, requestId) => void perform(() => client.request(method, { workspaceId, requestId }))
  };

  const renderOpenGroup = (members: BoardEntry[]) => {
    const blocks: ReactNode[] = [];
    let standalone: WorkItem[] = [];
    const flush = () => {
      if (!standalone.length) return;
      const rows = standalone;
      blocks.push(<div key={"items-" + rows[0]!.workItemId} className="vm-board-list">{rows.map((item) => <div key={item.workItemId}>
        {itemRow(item, context, handlers)}
        {context.attentionOf(item) && <div className="vm-board-list__alert">
          <AttentionAlert entry={entries.find((entry) => entry.id === item.workItemId)!} attention={context.attentionOf(item)!} handlers={handlers} sessionId={item.run.sessionId} />
        </div>}
      </div>)}</div>);
      standalone = [];
    };
    for (const entry of members) {
      if (entry.kind === "item") { standalone.push(entry.item); continue; }
      flush();
      blocks.push(<WorkCard key={entry.id} entry={entry} title={titleOf(entry)} sourceTitle={sourceTitleOf(entry)} context={context} handlers={handlers} />);
    }
    flush();
    return blocks;
  };
  const openWork = workDetail ? entries.find((entry) => entry.kind === "work" && entry.id === workDetail) : undefined;

  return (
    <div ref={board} className="vm-board">
      <PageHeader title="工作"
        summary={(["attention", "active", "ended"] as const).map((section) => <FilterChip key={section} tone={countTone[section]} count={counts[section]}
          label={section === "attention" ? "需要处理" : boardSectionLabel[section]} pressed={filter === section} onToggle={() => setFilter(filter === section ? "open" : section)} />)}
        actions={<>
          <Toggle label="自动推进" checked={scheduler.enabled} disabled={busy} onChange={(enabled) => setScheduler({ enabled })} />
          <Stepper label="并发" value={scheduler.maxWorkers} min={1} max={8} disabled={busy} onChange={(maxWorkers) => setScheduler({ maxWorkers })} />
          <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" />新建工单</Button>
        </>} />
      <div className="vm-board-toolbar">
        <SegmentedControl label="看板视图" value={filter === "attention" || filter === "active" ? "open" : filter} onChange={(value) => setFilter(value as BoardFilter)}
          items={[{ value: "open", label: "进行中", count: counts.attention + counts.active }, { value: "ended", label: "已结束", count: counts.ended }, { value: "all", label: "全部" }]} />
        <Field compact className="vm-board-search" aria-label="筛选标题" placeholder="筛选标题" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      {error && <InlineNotice tone="error" className="pt-2">{error}</InlineNotice>}
      {groups.length === 0 ? <EmptyState title={entries.length === 0 ? "还没有工作" : needle ? "没有匹配的工作" : "这个视图里没有内容"}
        hint={entries.length === 0 ? "在会话中点击开工，或新建一张工单。" : needle ? "换个关键词，或清空筛选。" : "切换到其他视图查看。"} /> : (
        <div className="vm-board-body">
          {groups.map((group) => <section key={group.section} aria-label={boardSectionLabel[group.section]}>
            <h3 className="vm-board-group-title">
              {boardSectionLabel[group.section]}<span className="vm-board-group-count">{group.total}</span>
              {group.entries.length < group.total && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFilter("ended")}>查看全部</Button>}
            </h3>
            {group.section === "ended"
              ? <div className="vm-board-list">{group.entries.map((entry) => <EndedRow key={entry.id} entry={entry} title={titleOf(entry)} context={context} handlers={handlers}
                expanded={isExpanded(entry.id)} onToggle={() => setWorkGroupExpanded(workspaceId, workExpansionKey(entry.id), !isExpanded(entry.id))} />)}</div>
              : <div className="vm-board-stack">{renderOpenGroup(group.entries)}</div>}
          </section>)}
        </div>
      )}
      {creating && <CreateWorkItemDialog client={client} workspaceId={workspaceId} onClose={() => setCreating(false)} />}
      {detail?.workspaceId === workspaceId && <WorkItemDialog key={workspaceId + "/" + detail.workItemId} client={client} workspaceId={workspaceId}
        workItemId={detail.workItemId} workItems={workItems} runs={runs} actions={actions} sourceTitles={sourceTitles}
        onClose={() => setDetail(undefined)} onOpenSession={onOpenSession} onOpenIssue={onOpenIssue} />}
      {openWork?.kind === "work" && <WorkDetail entry={openWork} title={titleOf(openWork)} client={client} workspaceId={workspaceId} decisions={decisions} handlers={handlers} onClose={() => setWorkDetail(undefined)} />}
    </div>
  );
};

/** Work-level detail: preparation session, supervisor, whole-work controls and the raw technical cause. */
const WorkDetail = ({ entry, title, client, workspaceId, decisions, handlers, onClose }: {
  entry: Extract<BoardEntry, { kind: "work" }>; title: string; client: WorkbenchClient; workspaceId: string; decisions: DecisionCard[]; handlers: WorkHandlers; onClose: () => void;
}) => {
  const [technical, setTechnical] = useState(false);
  const [answering, setAnswering] = useState<string>();
  const [error, setError] = useState<string>();
  const { request, items } = entry;
  const state = workRequestStatus(request, items);
  const raw = [request.failure, request.waitReason, entry.attention?.raw].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  const finished = entry.section === "ended";
  const stopped = request.paused || request.userStopped;
  const pending = pendingRequestDecisions(request, decisions);
  const answer = async (decisionId: string, key: string) => {
    setAnswering(decisionId);
    setError(undefined);
    try { await client.request("decision.answer", { workspaceId, decisionId, key }); }
    catch (caught) { setError(readableActionError(caught)); }
    finally { setAnswering(undefined); }
  };
  return <Modal title={title} width={560} onClose={onClose} titleContent={<StatusPill tone={statusTone(state.status)}>{state.label}</StatusPill>}>
    <div className="space-y-4 p-4">
      <p className="text-label text-muted-foreground">{items.length} 张工单 · {relativeTime(request.createdAt)}开工</p>
      {entry.attention && <AttentionAlert entry={entry} attention={entry.attention} handlers={handlers} sessionId={request.workerSessionId} controls={false} />}
      {pending.map((card) => <PendingDecision key={card.decisionId} card={card} disabled={!!answering} onAnswer={(key) => void answer(card.decisionId, key)} />)}
      {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
      <div className="flex flex-wrap gap-2">
        {request.workerSessionId && <Button size="sm" variant="ghost" outlined onClick={() => { onClose(); handlers.onOpenSession(request.workerSessionId!); }}><MessageSquare size={14} aria-hidden="true" />准备会话</Button>}
        {!finished && <Button size="sm" disabled={handlers.busy} onClick={() => handlers.onWorkAction(stopped ? "work.resume" : "work.pause", entry.id)}>{stopped ? "恢复全部推进" : "暂停全部"}</Button>}
        {!finished && request.status === "failed" && !stopped && <Button size="sm" disabled={handlers.busy} onClick={() => handlers.onWorkAction("work.retry", entry.id)}>重试准备</Button>}
        {!finished && <Button size="sm" variant="ghost" outlined disabled={handlers.busy} onClick={() => handlers.onWorkAction("work.cancel", entry.id)}>取消剩余工作</Button>}
      </div>
      <SupervisorDetails request={request} client={client} workspaceId={workspaceId} onOpenSession={(id) => { onClose(); handlers.onOpenSession(id); }} />
      {raw.length > 0 && <CollapsibleDetails open={technical} onToggle={() => setTechnical((open) => !open)}>{raw.join("\n\n")}</CollapsibleDetails>}
    </div>
  </Modal>;
};
