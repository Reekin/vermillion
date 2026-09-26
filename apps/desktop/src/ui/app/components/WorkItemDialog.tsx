import { useEffect, useState, type ReactNode } from "react";
import { Ban, Check, CircleAlert, CircleDashed, Clock, Copy, GitBranch, GitMerge, MessageSquare, X, type LucideIcon } from "lucide-react";
import type { AgentRun, DecisionCard, WorkbenchClient, WorkItem, WorkflowAction } from "@vermillion/workbench/client";
import { writeClipboardText } from "../../chat-shell/clipboard.js";
import { Modal } from "./Modal.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { Badge, Button, CollapsibleDetails, DetailSection, EmptyState, IconButton, InlineNotice, StatusIcon, StatusPill, Steps, TabList, type StatusTone } from "./ui.js";
import { WorkflowDetails } from "./WorkflowDetails.js";
import { IntegrationControls } from "./IntegrationControls.js";
import { executionDuration, formatDuration, pendingItemDecisions, readableActionError, workItemAttention, workItemEvents, workItemProgress, workItemSteps, type Attention } from "./workflow-display.js";
import { workItemBoardLabel } from "./task-labels.js";

type WorkItemDialogProps = {
  client: WorkbenchClient;
  workspaceId: string;
  workItemId: string;
  workItems: WorkItem[];
  runs: AgentRun[];
  actions?: WorkflowAction[];
  /** Source conversation titles by tree id, for the "源自" link. */
  sourceTitles?: Record<string, string>;
  onClose: () => void;
  onOpenSession: (sessionId: string, turnId?: string) => void;
  onOpenIssue?: (issueId: string) => void;
};

type TabId = "progress" | "requirements" | "verification" | "review" | "evidence";

const lines = (values: string[]) => values.map((value) => "• " + value).join("\n");
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "";
const Markdown = ({ children }: { children: string }) => <div className="vm-detail-markdown"><MarkdownPreview content={children} documentUrl={window.location.href} /></div>;

/** The one place the item's state is shown: header pill tone and label. */
const headerState = (item: WorkItem, progressLabel: string, attention?: Attention): { tone: StatusTone; label: string; icon?: LucideIcon } => {
  if (item.status === "closed") return item.merge ? { tone: "done", label: "已合入", icon: GitMerge } : { tone: "done", label: "已关闭" };
  if (item.status === "cancelled") return { tone: "neutral", label: "已取消" };
  const label = workItemBoardLabel(item, progressLabel);
  if (attention) return { tone: attention.action === "retry" ? "failed" : "attention", label };
  if (item.run.activeTurnId && item.run.turnStatus !== "unknown") return { tone: "running", label };
  return { tone: "waiting", label };
};

/** A question waiting for the user, with its options as buttons; the recommended one is primary. */
export const PendingDecision = ({ card, disabled, onAnswer }: { card: DecisionCard; disabled: boolean; onAnswer: (key: string) => void }) => (
  <div className="vm-detail-decision">
    <p className="text-caption font-medium text-muted-foreground">等待你答复</p>
    <div className="text-strong"><Markdown>{card.question}</Markdown></div>
    <div className="mt-2 flex flex-wrap gap-2">
      {card.options.map((option) => <Button key={option.key} size="sm" variant={option.key === card.recommended ? "primary" : "secondary"} disabled={disabled} title={option.detail} onClick={() => onAnswer(option.key)}>{option.label}</Button>)}
    </div>
  </div>
);

const ProgressPanel = ({ item, progress, attention, pendingDecisions, onResume, resuming, onAnswer, answeringDecisionId }: {
  item: WorkItem;
  progress: ReturnType<typeof workItemProgress>;
  attention?: Attention;
  pendingDecisions: DecisionCard[];
  onResume: () => void;
  resuming: boolean;
  onAnswer: (decisionId: string, key: string) => void;
  answeringDecisionId?: string;
}) => {
  if (item.status === "closed") return <section className="vm-detail-result" aria-live="polite">
    <h3 className="vm-detail-heading">成果</h3>
    {item.evidence?.summary ? <Markdown>{item.evidence.summary}</Markdown> : <p className="text-label text-muted-foreground">没有成果摘要。</p>}
  </section>;
  return <section aria-live="polite">
    {pendingDecisions.map((card) => <PendingDecision key={card.decisionId} card={card} disabled={!!answeringDecisionId} onAnswer={(key) => onAnswer(card.decisionId, key)} />)}
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="vm-detail-heading">{progress.title}</h3>
      {progress.at && <time className="font-mono text-micro text-muted-foreground">{time(progress.at)}</time>}
    </div>
    {progress.reason && <p className="mt-1 whitespace-pre-wrap break-words text-body text-foreground">{progress.reason}</p>}
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-label">
      <dt className="text-muted-foreground">下一步</dt><dd>{progress.next}</dd>
      <dt className="text-muted-foreground">处理者</dt><dd>{progress.handler}</dd>
      {progress.userAction && <><dt className="text-muted-foreground">你需要做什么</dt><dd>{progress.userAction}</dd></>}
    </dl>
    {(item.run.paused || item.run.userStopped) && <Button className="mt-3" variant="primary" size="sm" disabled={resuming} onClick={onResume}>恢复执行</Button>}
    {attention?.raw && <RawCause text={attention.raw} />}
  </section>;
};

const RawCause = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  return <CollapsibleDetails title="原始原因" open={open} onToggle={() => setOpen((value) => !value)}>{text}</CollapsibleDetails>;
};

const ProgressTimeline = ({ events }: { events: ReturnType<typeof workItemEvents> }) => {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, 5);
  return <section>
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="vm-detail-heading">关键事件</h3>
      {events.length > 5 && <Button variant="ghost" size="sm" onClick={() => setShowAll((open) => !open)}>{showAll ? "只看最近" : "展开全部（" + events.length + "）"}</Button>}
    </div>
    {visible.length ? <ol className="vm-detail-timeline">
      {visible.map((event, index) => <li key={event.at + "-" + event.title + "-" + index}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <time className="font-mono text-micro text-muted-foreground">{time(event.at)}</time>
          <span className="text-label text-foreground">{event.title}</span>
        </div>
        {event.detail && <p className="mt-1 whitespace-pre-wrap break-words text-caption text-muted-foreground">{event.detail}</p>}
      </li>)}
    </ol> : <p className="text-caption text-muted-foreground">暂无进展记录</p>}
  </section>;
};

const Requirements = ({ item }: { item: WorkItem }) => <div className="space-y-4">
  <section><h3 className="vm-detail-heading">目标</h3>{item.objective ? <Markdown>{item.objective}</Markdown> : <p className="text-label text-muted-foreground">未填写</p>}</section>
  <DetailSection title="范围">{lines(item.scope.inScope) || "无"}</DetailSection>
  <DetailSection title="不在范围内">{lines(item.scope.outOfScope) || "无"}</DetailSection>
  <DetailSection title="允许路径">{lines(item.scope.allowedPaths) || "无"}</DetailSection>
  <DetailSection title="引用文档">{item.refs.length ? item.refs.map((ref) => ref.path + (ref.section ? " · " + ref.section : "") + " · " + ref.commit.slice(0, 7)).join("\n") : "无"}</DetailSection>
  {item.dependsOn.length > 0 && <DetailSection title="依赖工单">{item.dependsOn.join("\n")}</DetailSection>}
</div>;

const checkState: Record<string, { tone: StatusTone; icon: LucideIcon; label: string }> = {
  pass: { tone: "done", icon: Check, label: "通过" },
  defect: { tone: "failed", icon: X, label: "发现缺陷" },
  blocked: { tone: "attention", icon: CircleAlert, label: "条件不足" },
  incomplete: { tone: "attention", icon: CircleAlert, label: "尚未完成" }
};

/** Acceptance as a checklist: result icon, the requirement in normal weight, evidence folded until asked for. */
const Verification = ({ item }: { item: WorkItem }) => {
  const [open, setOpen] = useState<number[]>([]);
  const passed = item.verify?.items.filter((entry) => entry.status === "pass").length ?? 0;
  const summary = !item.verify ? "尚未验收" : item.verify.verdict === "pass" ? item.acceptance.length + " 条全部通过" : passed + " / " + item.acceptance.length + " 通过 · 需要返工";
  return <section>
    <p className="text-caption text-muted-foreground">{summary}{item.verify && " · " + time(item.verify.verifiedAt)}</p>
    <ol className="vm-checklist">
      {item.acceptance.map((acceptance, index) => {
        const entry = item.verify?.items.find((candidate) => candidate.index === index);
        const state = entry ? checkState[entry.status] ?? checkState.defect! : { tone: "waiting" as StatusTone, icon: CircleDashed, label: "尚未验收" };
        const expanded = open.includes(index);
        return <li key={index} className="vm-check">
          <StatusIcon tone={state.tone} icon={state.icon} label={state.label} />
          <div className="min-w-0">
            <Markdown>{acceptance.text}</Markdown>
            {expanded && entry?.evidence && <div className="mt-1.5 text-caption text-muted-foreground"><Markdown>{entry.evidence}</Markdown></div>}
          </div>
          {entry?.evidence ? <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setOpen((current) => expanded ? current.filter((value) => value !== index) : [...current, index])}>{expanded ? "收起" : "证据"}</Button> : <span />}
        </li>;
      })}
    </ol>
  </section>;
};

const Review = ({ item }: { item: WorkItem }) => <div className="space-y-4">
  {item.review.map((entry, index) => <div key={entry.comment + index} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
    <div className="flex items-start gap-2">
      <Badge>{entry.decision === "accepted" ? "已采纳" : "未采纳"}</Badge>
      <div className="min-w-0 flex-1 text-label text-foreground"><Markdown>{entry.comment}</Markdown></div>
    </div>
    <p className="mt-1 text-caption text-muted-foreground">理由：{entry.reason}</p>
  </div>)}
</div>;

const Evidence = ({ item, itemRuns, itemActions, onOpenSession }: { item: WorkItem; itemRuns: AgentRun[]; itemActions: WorkflowAction[]; onOpenSession: (id: string) => void }) => {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  return <div className="space-y-4">
    {item.evidence && <>
      <div className="space-y-2 text-caption text-muted-foreground">
        <p>运行记录：{itemRuns.length ? itemRuns.map((run) => (run.status === "running" ? "进行中" : run.status === "failed" ? "失败" : "已结束") + " · " + run.turns + " 轮 · " + time(run.startedAt)).join("；") : "暂无"}</p>
        {item.evidence.attachments.length > 0 && <p className="whitespace-pre-wrap break-words">附件：{lines(item.evidence.attachments)}</p>}
        {item.evidence.untested.length > 0 && <p className="whitespace-pre-wrap break-words">未测：{lines(item.evidence.untested)}</p>}
        {item.evidence.outOfScopeFindings.length > 0 && <p className="whitespace-pre-wrap break-words">范围外发现：{lines(item.evidence.outOfScopeFindings)}</p>}
      </div>
      <CollapsibleDetails title="命令与原始输出" open={technicalOpen} onToggle={() => setTechnicalOpen((open) => !open)}>{[
        ...item.evidence.commands.map((entry) => "$ " + entry.command + "\n" + entry.output),
        "假设\n" + lines(item.evidence.assumptions),
        "提交时间：" + time(item.evidence.submittedAt)
      ].join("\n\n")}</CollapsibleDetails>
    </>}
    {itemActions.length > 0 && <section><h3 className="vm-detail-heading">处理记录</h3><WorkflowDetails actions={itemActions} item={item} onOpenSession={onOpenSession} /></section>}
  </div>;
};

const Decisions = ({ cards }: { cards: DecisionCard[] }) => <section>
  <h3 className="vm-detail-heading">已处理决策</h3>
  <div className="space-y-3">
    {cards.map((card) => <div key={card.decisionId}>
      <p className="text-caption text-muted-foreground">{card.withdrawn ? "已撤回" : "已答复"}</p>
      <Markdown>{card.question}</Markdown>
      {card.answer && <p className="mt-1 text-caption text-muted-foreground">答复：{(card.options.find((option) => option.key === card.answer?.key)?.label ?? card.answer.key) + (card.answer.note ? " · " + card.answer.note : "")}</p>}
      {card.deliveryPending && <p className="mt-1 text-caption text-muted-foreground">答复尚未送达：{card.deliveryFailure ?? "等待执行会话接收"}</p>}
    </div>)}
  </div>
</section>;

const MetaItem = ({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) => <span className="vm-detail-meta__item">{Icon && <Icon size={12} aria-hidden="true" />}{children}</span>;

export const WorkItemDialog = ({ client, workspaceId, workItemId, workItems, runs, actions = [], sourceTitles = {}, onClose, onOpenSession, onOpenIssue }: WorkItemDialogProps) => {
  const item = workItems.find((entry) => entry.workItemId === workItemId);
  const [decisions, setDecisions] = useState<DecisionCard[]>();
  const [error, setError] = useState<string>();
  const [resuming, setResuming] = useState(false);
  const [answeringDecisionId, setAnsweringDecisionId] = useState<string>();
  const [tab, setTab] = useState<TabId>("progress");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const result = await client.request("decision.list", { workspaceId });
        if (active && request === generation) { setDecisions(result); setError(undefined); }
      } catch (caught) {
        if (active && request === generation) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void refresh();
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "decisions.changed" && event.workspaceId === workspaceId) void refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [client, workspaceId]);
  if (!item) return <Modal title="工单详情" onClose={onClose} width={820}><EmptyState title="工单不存在" hint={workItemId} /></Modal>;

  const itemRuns = runs.filter((run) => run.workItemId === workItemId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const itemActions = actions.filter((action) => action.workItemId === workItemId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const integration = itemActions.find((action): action is Extract<WorkflowAction, { kind: "integration" }> => action.kind === "integration" && action.stage === "merge" && action.status !== "done" && action.status !== "cancelled");
  const sessionId = item.run.sessionId ?? itemRuns[0]?.sessionId;
  const itemDecisions = decisions?.filter((card) => card.workItemId === workItemId || itemActions.some((action) => action.actionId === card.actionId) || item.decisions.includes(card.decisionId)) ?? [];
  const pendingDecisions = pendingItemDecisions(item, itemDecisions, itemActions);
  const resolvedDecisions = itemDecisions.filter((card) => card.answer || card.withdrawn);
  const unresolvedDependencies = item.dependsOn.filter((id) => workItems.find((other) => other.workItemId === id)?.status !== "closed");
  const progress = workItemProgress(item, itemActions, itemRuns.find((run) => run.sessionId === item.run.sessionId) ?? itemRuns[0], unresolvedDependencies);
  const attention = workItemAttention(item, itemActions, itemDecisions);
  const events = workItemEvents(item, itemActions, itemRuns);
  const state = headerState(item, progress.shortLabel, attention);
  const duration = executionDuration(item, itemActions, itemRuns);
  const commit = item.merge?.commit;
  const sourceTitle = (item.treeId && sourceTitles[item.treeId]) || "来源会话";
  const passed = item.verify?.items.filter((entry) => entry.status === "pass").length ?? 0;
  const tabs: Array<{ id: TabId; label: string; count?: string }> = [
    { id: "progress", label: "进展" },
    { id: "requirements", label: "任务要求" },
    ...(item.acceptance.length ? [{ id: "verification" as const, label: "验收", count: passed + "/" + item.acceptance.length }] : []),
    ...(item.review.length ? [{ id: "review" as const, label: "审阅", count: String(item.review.length) }] : []),
    ...(item.evidence || itemActions.length ? [{ id: "evidence" as const, label: "检查与附件" }] : [])
  ];
  const shown = tabs.some((candidate) => candidate.id === tab) ? tab : "progress";
  const resume = async () => {
    setResuming(true);
    setError(undefined);
    try { await client.request("workItem.resume", { workspaceId, workItemId }); }
    catch (caught) { setError(readableActionError(caught)); }
    finally { setResuming(false); }
  };
  const answerDecision = async (decisionId: string, key: string) => {
    setAnsweringDecisionId(decisionId);
    setError(undefined);
    try { await client.request("decision.answer", { workspaceId, decisionId, key }); }
    catch (caught) { setError(readableActionError(caught)); }
    finally { setAnsweringDecisionId(undefined); }
  };
  const openSession = (id: string, turnId?: string) => { onClose(); onOpenSession(id, turnId); };
  return <Modal title={item.title} onClose={onClose} width={820} contentClassName="flex min-h-0 flex-col"
    titleContent={<StatusPill tone={state.tone} icon={state.icon ?? (item.status === "cancelled" ? Ban : undefined)}>{state.label}</StatusPill>}>
    <div className="vm-detail-head">
      <div className="vm-detail-meta">
        <Badge>{item.risk}</Badge>
        {item.sourceSessionId && <button type="button" className="vm-board-link" onClick={() => openSession(item.sourceSessionId!, item.sourceTurnId)}><MessageSquare size={12} aria-hidden="true" />源自 {sourceTitle}</button>}
        {duration && <MetaItem icon={Clock}>执行用时 {formatDuration(duration)}</MetaItem>}
        {commit && <MetaItem icon={GitMerge}>
          <span className="font-mono" title={commit}>{commit.slice(0, 7)}</span>
          <IconButton icon={copied ? Check : Copy} size={12} label={copied ? "已复制 commit" : "复制 commit"} className="h-5 w-5" onClick={() => void writeClipboardText(commit).then(() => setCopied(true))} />
        </MetaItem>}
      </div>
      <Steps label="工单进度" steps={workItemSteps(item, itemActions, itemRuns, attention, item.status === "queued" && unresolvedDependencies.length ? "等待前置工单" : progress.shortLabel)} />
      <TabList label="工单材料" items={tabs} selected={shown} onSelect={setTab} />
    </div>
    <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
      <div className="space-y-5 px-6 py-5">
        {error && <InlineNotice tone="error" className="whitespace-pre-wrap break-words px-0">{error}</InlineNotice>}
        {shown === "progress" && <>
          <ProgressPanel item={item} progress={progress} attention={attention} pendingDecisions={pendingDecisions} onResume={() => void resume()} resuming={resuming} onAnswer={(decisionId, key) => void answerDecision(decisionId, key)} answeringDecisionId={answeringDecisionId} />
          {integration && <IntegrationControls client={client} workspaceId={workspaceId} workItemId={workItemId} action={integration} item={item} />}
          <ProgressTimeline events={events} />
          {resolvedDecisions.length > 0 && <Decisions cards={resolvedDecisions} />}
        </>}
        {shown === "requirements" && <Requirements item={item} />}
        {shown === "verification" && <Verification item={item} />}
        {shown === "review" && <Review item={item} />}
        {shown === "evidence" && <Evidence item={item} itemRuns={itemRuns} itemActions={itemActions} onOpenSession={(id) => openSession(id)} />}
      </div>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-6 py-3">
      <span className="mr-auto font-mono text-micro text-muted-foreground">{item.workItemId}</span>
      {item.issueId && onOpenIssue && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenIssue(item.issueId!); }}>Issue</Button>}
      {sessionId && <Button variant="ghost" outlined onClick={() => openSession(sessionId)}><MessageSquare size={14} aria-hidden="true" />会话</Button>}
      {item.sourceSessionId && <Button variant="ghost" outlined onClick={() => openSession(item.sourceSessionId!, item.sourceTurnId)}><GitBranch size={14} aria-hidden="true" />来源</Button>}
    </footer>
  </Modal>;
};
