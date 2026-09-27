import { useEffect, useState, type ReactNode } from "react";
import { Ban, Check, CircleAlert, CircleDashed, Clock, Copy, GitBranch, GitMerge, MessageSquare, X, type LucideIcon } from "lucide-react";
import type { AgentRun, DecisionCard, WorkbenchClient, WorkItem, WorkflowAction } from "@vermillion/workbench/client";
import { serviceText, t } from "../../../i18n/index.js";
import { formatDateTime, formatDuration } from "../../../i18n/format.js";
import { useT } from "../../../i18n/react.js";
import { writeClipboardText } from "../../chat-shell/clipboard.js";
import { Modal } from "./Modal.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { Badge, Button, CollapsibleDetails, DetailSection, EmptyState, IconButton, InlineNotice, StatusIcon, StatusPill, Steps, TabList, type StatusTone } from "./ui.js";
import { WorkflowDetails } from "./WorkflowDetails.js";
import { IntegrationControls } from "./IntegrationControls.js";
import { executionDuration, pendingItemDecisions, readableActionError, workItemAttention, workItemEvents, workItemProgress, workItemSteps, type Attention } from "./workflow-display.js";
import { statusLabel, workItemBoardLabel } from "./task-labels.js";

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
const time = (value?: string) => value ? formatDateTime(value) : "";
const labelled = (label: string, value: string) => t("work.labelValue", { label, value });
const Markdown = ({ children }: { children: string }) => <div className="vm-detail-markdown"><MarkdownPreview content={children} documentUrl={window.location.href} /></div>;

/** The one place the item's state is shown: header pill tone and label. */
const headerState = (item: WorkItem, progressLabel: string, attention?: Attention): { tone: StatusTone; label: string; icon?: LucideIcon } => {
  if (item.status === "closed") return item.merge ? { tone: "done", label: t("work.state.merged"), icon: GitMerge } : { tone: "done", label: statusLabel("closed") };
  if (item.status === "cancelled") return { tone: "neutral", label: statusLabel("cancelled") };
  const label = workItemBoardLabel(item, progressLabel);
  if (attention) return { tone: attention.action === "retry" ? "failed" : "attention", label };
  if (item.run.activeTurnId && item.run.turnStatus !== "unknown") return { tone: "running", label };
  return { tone: "waiting", label };
};

/** A question waiting for the user, with its options as buttons; the recommended one is primary. */
export const PendingDecision = ({ card, disabled, onAnswer }: { card: DecisionCard; disabled: boolean; onAnswer: (key: string) => void }) => {
  useT();
  return (
  <div className="vm-detail-decision">
    <p className="text-caption font-medium text-muted-foreground">{t("work.attention.awaitingAnswer")}</p>
    <div className="text-strong"><Markdown>{serviceText(card.question)}</Markdown></div>
    <div className="mt-2 flex flex-wrap gap-2">
      {card.options.map((option) => <Button key={option.key} size="sm" variant={option.key === card.recommended ? "primary" : "secondary"} disabled={disabled} title={option.detail} onClick={() => onAnswer(option.key)}>{serviceText(option.label)}</Button>)}
    </div>
  </div>
  );
};

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
  useT();
  if (item.status === "closed") return <section className="vm-detail-result" aria-live="polite">
    <h3 className="vm-detail-heading">{t("work.detail.results")}</h3>
    {item.evidence?.summary ? <Markdown>{item.evidence.summary}</Markdown> : <p className="text-label text-muted-foreground">{t("work.detail.noSummary")}</p>}
  </section>;
  return <section aria-live="polite">
    {pendingDecisions.map((card) => <PendingDecision key={card.decisionId} card={card} disabled={!!answeringDecisionId} onAnswer={(key) => onAnswer(card.decisionId, key)} />)}
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="vm-detail-heading">{progress.title}</h3>
      {progress.at && <time className="font-mono text-micro text-muted-foreground">{time(progress.at)}</time>}
    </div>
    {progress.reason && <p className="mt-1 whitespace-pre-wrap break-words text-body text-foreground">{progress.reason}</p>}
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-label">
      <dt className="text-muted-foreground">{t("work.detail.next")}</dt><dd>{progress.next}</dd>
      <dt className="text-muted-foreground">{t("work.detail.handler")}</dt><dd>{progress.handler}</dd>
      {progress.userAction && <><dt className="text-muted-foreground">{t("work.detail.userAction")}</dt><dd>{progress.userAction}</dd></>}
    </dl>
    {(item.run.paused || item.run.userStopped) && <Button className="mt-3" variant="primary" size="sm" disabled={resuming} onClick={onResume}>{t("work.detail.resume")}</Button>}
    {attention?.raw && <RawCause text={attention.raw} />}
  </section>;
};

const RawCause = ({ text }: { text: string }) => {
  useT();
  const [open, setOpen] = useState(false);
  return <CollapsibleDetails title={t("work.detail.rawCause")} open={open} onToggle={() => setOpen((value) => !value)}>{text}</CollapsibleDetails>;
};

const ProgressTimeline = ({ events }: { events: ReturnType<typeof workItemEvents> }) => {
  useT();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, 5);
  return <section>
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="vm-detail-heading">{t("work.detail.events")}</h3>
      {events.length > 5 && <Button variant="ghost" size="sm" onClick={() => setShowAll((open) => !open)}>{showAll ? t("work.detail.showRecent") : t("work.detail.showAll", { count: events.length })}</Button>}
    </div>
    {visible.length ? <ol className="vm-detail-timeline">
      {visible.map((event, index) => <li key={event.at + "-" + event.title + "-" + index}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <time className="font-mono text-micro text-muted-foreground">{time(event.at)}</time>
          <span className="text-label text-foreground">{event.title}</span>
        </div>
        {event.detail && <p className="mt-1 whitespace-pre-wrap break-words text-caption text-muted-foreground">{event.detail}</p>}
      </li>)}
    </ol> : <p className="text-caption text-muted-foreground">{t("work.detail.noEvents")}</p>}
  </section>;
};

const Requirements = ({ item }: { item: WorkItem }) => {
  useT();
  return <div className="space-y-4">
    <section><h3 className="vm-detail-heading">{t("work.detail.objective")}</h3>{item.objective ? <Markdown>{item.objective}</Markdown> : <p className="text-label text-muted-foreground">{t("work.detail.notProvided")}</p>}</section>
    <DetailSection title={t("work.detail.scope")}>{lines(item.scope.inScope) || t("work.none")}</DetailSection>
    <DetailSection title={t("work.detail.outOfScope")}>{lines(item.scope.outOfScope) || t("work.none")}</DetailSection>
    <DetailSection title={t("work.detail.allowedPaths")}>{lines(item.scope.allowedPaths) || t("work.none")}</DetailSection>
    <DetailSection title={t("work.detail.refs")}>{item.refs.length ? item.refs.map((ref) => ref.path + (ref.section ? " · " + ref.section : "") + " · " + ref.commit.slice(0, 7)).join("\n") : t("work.none")}</DetailSection>
    {item.dependsOn.length > 0 && <DetailSection title={t("work.detail.dependencies")}>{item.dependsOn.join("\n")}</DetailSection>}
  </div>;
};

const checkState = (status: string): { tone: StatusTone; icon: LucideIcon; label: string } => {
  switch (status) {
    case "pass": return { tone: "done", icon: Check, label: t("work.verify.pass") };
    case "blocked": return { tone: "attention", icon: CircleAlert, label: t("work.verify.blocked") };
    case "incomplete": return { tone: "attention", icon: CircleAlert, label: t("work.verify.incomplete") };
    default: return { tone: "failed", icon: X, label: t("work.verify.defect") };
  }
};

/** Acceptance as a checklist: result icon, the requirement in normal weight, evidence folded until asked for. */
const Verification = ({ item }: { item: WorkItem }) => {
  useT();
  const [open, setOpen] = useState<number[]>([]);
  const passed = item.verify?.items.filter((entry) => entry.status === "pass").length ?? 0;
  const summary = !item.verify ? t("work.verify.pending") : item.verify.verdict === "pass" ? t("work.verify.allPassed", { count: item.acceptance.length })
    : t("work.verify.partlyPassed", { passed, total: item.acceptance.length });
  return <section>
    <p className="text-caption text-muted-foreground">{summary}{item.verify && " · " + time(item.verify.verifiedAt)}</p>
    <ol className="vm-checklist">
      {item.acceptance.map((acceptance, index) => {
        const entry = item.verify?.items.find((candidate) => candidate.index === index);
        const state = entry ? checkState(entry.status) : { tone: "waiting" as StatusTone, icon: CircleDashed, label: t("work.verify.pending") };
        const expanded = open.includes(index);
        return <li key={index} className="vm-check">
          <StatusIcon tone={state.tone} icon={state.icon} label={state.label} />
          <div className="min-w-0">
            <Markdown>{acceptance.text}</Markdown>
            {expanded && entry?.evidence && <div className="mt-1.5 text-caption text-muted-foreground"><Markdown>{entry.evidence}</Markdown></div>}
          </div>
          {entry?.evidence ? <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setOpen((current) => expanded ? current.filter((value) => value !== index) : [...current, index])}>{expanded ? t("work.verify.hide") : t("work.verify.evidence")}</Button> : <span />}
        </li>;
      })}
    </ol>
  </section>;
};

const Review = ({ item }: { item: WorkItem }) => {
  useT();
  return <div className="space-y-4">
    {item.review.map((entry, index) => <div key={entry.comment + index} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2">
        <Badge>{entry.decision === "accepted" ? t("work.detail.accepted") : t("work.detail.notAccepted")}</Badge>
        <div className="min-w-0 flex-1 text-label text-foreground"><Markdown>{entry.comment}</Markdown></div>
      </div>
      <p className="mt-1 text-caption text-muted-foreground">{labelled(t("work.detail.reason"), entry.reason)}</p>
    </div>)}
  </div>;
};

const runStatus = (run: AgentRun) => run.status === "running" ? t("work.detail.runRunning") : run.status === "failed" ? t("work.detail.runFailed") : t("work.detail.runEnded");

const Evidence = ({ item, itemRuns, itemActions, onOpenSession }: { item: WorkItem; itemRuns: AgentRun[]; itemActions: WorkflowAction[]; onOpenSession: (id: string) => void }) => {
  useT();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  return <div className="space-y-4">
    {item.evidence && <>
      <div className="space-y-2 text-caption text-muted-foreground">
        <p>{labelled(t("work.detail.runs"), itemRuns.length
          ? itemRuns.map((run) => t("work.detail.runEntry", { status: runStatus(run), turns: run.turns, time: time(run.startedAt) })).join(t("work.detail.runSeparator"))
          : t("work.detail.noneYet"))}</p>
        {item.evidence.attachments.length > 0 && <p className="whitespace-pre-wrap break-words">{labelled(t("work.detail.attachments"), lines(item.evidence.attachments))}</p>}
        {item.evidence.untested.length > 0 && <p className="whitespace-pre-wrap break-words">{labelled(t("work.detail.untested"), lines(item.evidence.untested))}</p>}
        {item.evidence.outOfScopeFindings.length > 0 && <p className="whitespace-pre-wrap break-words">{labelled(t("work.detail.outOfScopeFindings"), lines(item.evidence.outOfScopeFindings))}</p>}
      </div>
      <CollapsibleDetails title={t("work.detail.commandsOutput")} open={technicalOpen} onToggle={() => setTechnicalOpen((open) => !open)}>{[
        ...item.evidence.commands.map((entry) => "$ " + entry.command + "\n" + entry.output),
        t("work.detail.assumptions") + "\n" + lines(item.evidence.assumptions),
        labelled(t("work.detail.submittedAt"), time(item.evidence.submittedAt))
      ].join("\n\n")}</CollapsibleDetails>
    </>}
    {itemActions.length > 0 && <section><h3 className="vm-detail-heading">{t("work.detail.handling")}</h3><WorkflowDetails actions={itemActions} item={item} onOpenSession={onOpenSession} /></section>}
  </div>;
};

const Decisions = ({ cards }: { cards: DecisionCard[] }) => {
  useT();
  return <section>
    <h3 className="vm-detail-heading">{t("work.detail.resolvedDecisions")}</h3>
    <div className="space-y-3">
      {cards.map((card) => <div key={card.decisionId}>
        <p className="text-caption text-muted-foreground">{card.withdrawn ? t("work.detail.withdrawn") : t("work.detail.answered")}</p>
        <Markdown>{serviceText(card.question)}</Markdown>
        {card.answer && <p className="mt-1 text-caption text-muted-foreground">{labelled(t("work.detail.answer"), (card.options.find((option) => option.key === card.answer?.key)?.label ?? card.answer.key) + (card.answer.note ? " · " + card.answer.note : ""))}</p>}
        {card.deliveryPending && <p className="mt-1 text-caption text-muted-foreground">{labelled(t("work.detail.answerUndelivered"), card.deliveryFailure ?? t("work.detail.awaitingReceipt"))}</p>}
      </div>)}
    </div>
  </section>;
};

const MetaItem = ({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) => <span className="vm-detail-meta__item">{Icon && <Icon size={12} aria-hidden="true" />}{children}</span>;

export const WorkItemDialog = ({ client, workspaceId, workItemId, workItems, runs, actions = [], sourceTitles = {}, onClose, onOpenSession, onOpenIssue }: WorkItemDialogProps) => {
  useT();
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
  if (!item) return <Modal title={t("work.detail.title")} onClose={onClose} width={820}><EmptyState title={t("work.detail.notFound")} hint={workItemId} /></Modal>;

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
  const sourceTitle = (item.treeId && sourceTitles[item.treeId]) || t("work.sourceSession");
  const passed = item.verify?.items.filter((entry) => entry.status === "pass").length ?? 0;
  const tabs: Array<{ id: TabId; label: string; count?: string }> = [
    { id: "progress", label: t("work.detail.tab.progress") },
    { id: "requirements", label: t("work.detail.tab.requirements") },
    ...(item.acceptance.length ? [{ id: "verification" as const, label: t("work.detail.tab.verification"), count: passed + "/" + item.acceptance.length }] : []),
    ...(item.review.length ? [{ id: "review" as const, label: t("work.detail.tab.review"), count: String(item.review.length) }] : []),
    ...(item.evidence || itemActions.length ? [{ id: "evidence" as const, label: t("work.detail.tab.evidence") }] : [])
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
        {item.sourceSessionId && <button type="button" className="vm-board-link" onClick={() => openSession(item.sourceSessionId!, item.sourceTurnId)}><MessageSquare size={12} aria-hidden="true" />{t("work.detail.from", { title: sourceTitle })}</button>}
        {duration && <MetaItem icon={Clock}>{t("work.detail.runTime", { duration: formatDuration(duration) })}</MetaItem>}
        {commit && <MetaItem icon={GitMerge}>
          <span className="font-mono" title={commit}>{commit.slice(0, 7)}</span>
          <IconButton icon={copied ? Check : Copy} size={12} label={copied ? t("work.detail.commitCopied") : t("work.detail.copyCommit")} className="h-5 w-5" onClick={() => void writeClipboardText(commit).then(() => setCopied(true))} />
        </MetaItem>}
      </div>
      <Steps label={t("work.detail.steps")} steps={workItemSteps(item, itemActions, itemRuns, attention, item.status === "queued" && unresolvedDependencies.length ? t("work.progress.waitingDependencies") : progress.shortLabel)} />
      <TabList label={t("work.detail.materials")} items={tabs} selected={shown} onSelect={setTab} />
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
      {sessionId && <Button variant="ghost" outlined onClick={() => openSession(sessionId)}><MessageSquare size={14} aria-hidden="true" />{t("work.detail.session")}</Button>}
      {item.sourceSessionId && <Button variant="ghost" outlined onClick={() => openSession(item.sourceSessionId!, item.sourceTurnId)}><GitBranch size={14} aria-hidden="true" />{t("work.detail.source")}</Button>}
    </footer>
  </Modal>;
};
