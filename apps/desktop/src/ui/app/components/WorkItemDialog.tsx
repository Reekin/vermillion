import { useEffect, useState, type ReactNode } from "react";
import type { AgentRun, DecisionCard, WorkbenchClient, WorkItem, WorkflowAction } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Badge, Button, CollapsibleDetails, DetailSection, DisclosureCard, EmptyState, InlineNotice } from "./ui.js";
import { WorkflowDetails } from "./WorkflowDetails.js";
import { IntegrationControls } from "./IntegrationControls.js";
import { workItemEvents, workItemProgress } from "./workflow-display.js";

type WorkItemDialogProps = {
  client: WorkbenchClient;
  workspaceId: string;
  workItemId: string;
  workItems: WorkItem[];
  runs: AgentRun[];
  actions?: WorkflowAction[];
  onClose: () => void;
  onOpenSession: (sessionId: string, turnId?: string) => void;
  onOpenIssue?: (issueId: string) => void;
};

const lines = (values: string[]) => values.map((value) => "• " + value).join("\n");
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "";
const verificationLabel = (status: string) => ({ pass: "通过", defect: "发现缺陷", blocked: "条件不足", incomplete: "尚未完成" }[status] ?? "未通过");

const ProgressPanel = ({ item, progress, pendingDecisions, onResume, resuming, onAnswer, answeringDecisionId }: {
  item: WorkItem;
  progress: ReturnType<typeof workItemProgress>;
  pendingDecisions: DecisionCard[];
  onResume: () => void;
  resuming: boolean;
  onAnswer: (decisionId: string, key: string) => void;
  answeringDecisionId?: string;
}) => (
  <section className="border-l-2 border-border-strong pl-4" aria-live="polite">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Badge status={item.status}>{progress.shortLabel}</Badge>
          <span className="text-caption text-muted-foreground">{progress.handler}</span>
        </div>
        <h3 className="text-title-sm font-semibold text-strong">{progress.title}</h3>
      </div>
      {progress.at && <time className="shrink-0 font-mono text-micro text-muted-foreground">{time(progress.at)}</time>}
    </div>
    {progress.reason && <p className="mt-2 whitespace-pre-wrap break-words text-body text-foreground">{progress.reason}</p>}
    <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-label">
      <dt className="text-muted-foreground">下一步</dt><dd>{progress.next}</dd>
      {progress.userAction && <><dt className="text-muted-foreground">你需要做什么</dt><dd>{progress.userAction}</dd></>}
    </dl>
    {item.run.pauseReason === "user" && <Button className="mt-4" variant="primary" size="sm" disabled={resuming} onClick={onResume}>恢复执行</Button>}
    {pendingDecisions.length > 0 && <div className="mt-4 border-t border-border pt-3">
      <p className="text-label font-medium text-strong">待答复</p>
      {pendingDecisions.map((card) => <div key={card.decisionId} className="mt-2 space-y-1">
        <p className="text-label text-foreground">{card.question}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {card.options.map((option) => <Button key={option.key} size="sm" variant={option.key === card.recommended ? "primary" : "secondary"} disabled={!!answeringDecisionId} onClick={() => onAnswer(card.decisionId, option.key)}>{option.label}</Button>)}
        </div>
      </div>)}
    </div>}
  </section>
);

const ProgressTimeline = ({ events }: { events: ReturnType<typeof workItemEvents> }) => {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, 5);
  return <section>
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-label font-medium text-strong">最近进展</h3>
      {events.length > 5 && <Button variant="ghost" size="sm" onClick={() => setShowAll((open) => !open)}>{showAll ? "收起记录" : "展开全部记录（" + events.length + "）"}</Button>}
    </div>
    {visible.length ? <ol className="ml-2 border-l border-border pl-4">
      {visible.map((event, index) => <li key={event.at + "-" + event.title + "-" + index} className="relative pb-4 last:pb-0">
        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-border-strong bg-surface-raised" />
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <time className="font-mono text-micro text-muted-foreground">{time(event.at)}</time>
          <span className="text-label text-foreground">{event.title}</span>
        </div>
        {event.detail && <p className="mt-1 whitespace-pre-wrap break-words text-caption text-muted-foreground">{event.detail}</p>}
      </li>)}
    </ol> : <p className="text-caption text-muted-foreground">暂无进展记录</p>}
  </section>;
};

const SectionDisclosure = ({ title, summary, open, onToggle, children }: { title: string; summary: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) => (
  <DisclosureCard title={title} summary={summary} open={open} onToggle={onToggle}>{children}</DisclosureCard>
);

const Requirements = ({ item }: { item: WorkItem }) => <div className="space-y-4">
  <DetailSection title="目标">{item.objective || "未填写"}</DetailSection>
  <DetailSection title="范围">{lines(item.scope.inScope) || "无"}</DetailSection>
  <DetailSection title="不在范围内">{lines(item.scope.outOfScope) || "无"}</DetailSection>
  <DetailSection title="允许路径">{lines(item.scope.allowedPaths) || "无"}</DetailSection>
  <DetailSection title="引用文档">{item.refs.length ? item.refs.map((ref) => ref.path + (ref.section ? " · " + ref.section : "") + "\ncommit: " + ref.commit).join("\n\n") : "无"}</DetailSection>
  {item.dependsOn.length > 0 && <DetailSection title="依赖工单">{item.dependsOn.join("\n")}</DetailSection>}
</div>;

const Verification = ({ item }: { item: WorkItem }) => <div className="space-y-3">
  {item.verify ? <>
    <div className="flex flex-wrap items-center gap-2"><Badge>{item.verify.verdict === "pass" ? "全部通过" : "需要返工"}</Badge><span className="text-caption text-muted-foreground">{time(item.verify.verifiedAt)}</span></div>
    {item.acceptance.map((acceptance, index) => {
      const entry = item.verify?.items.find((candidate) => candidate.index === index);
      return <div key={index} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
        <p className="text-label text-foreground">{index + 1}. {acceptance.text}</p>
        <p className="mt-1 text-caption text-muted-foreground">{entry ? verificationLabel(entry.status) + "：" + entry.evidence : "尚未验收"}</p>
      </div>;
    })}
  </> : <>
    <p className="text-label text-muted-foreground">尚未验收</p>
    {item.acceptance.map((acceptance, index) => <div key={index} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className="text-label text-foreground">{index + 1}. {acceptance.text}</p>
      <p className="mt-1 text-caption text-muted-foreground">尚未验收</p>
    </div>)}
  </>}
</div>;

const Review = ({ item }: { item: WorkItem }) => <div className="space-y-4">
  {item.review.map((entry, index) => <div key={entry.comment + index} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
    <p className="text-label text-foreground">{entry.decision === "accepted" ? "已采纳" : "已拒绝"}：{entry.comment}</p>
    <p className="mt-1 text-caption text-muted-foreground">理由：{entry.reason}</p>
  </div>)}
</div>;

const Evidence = ({ item, itemRuns, technicalOpen, onToggleTechnical }: { item: WorkItem; itemRuns: AgentRun[]; technicalOpen: boolean; onToggleTechnical: () => void }) => item.evidence ? <div className="space-y-4">
  <p className="whitespace-pre-wrap break-words text-label text-foreground">{item.evidence.summary || "尚未提交"}</p>
  <div className="space-y-2 text-caption text-muted-foreground">
    <p>运行记录：{itemRuns.length ? itemRuns.map((run) => (run.status === "running" ? "进行中" : run.status === "failed" ? "失败" : "已结束") + " · " + run.turns + " turn · " + time(run.startedAt)).join("；") : "暂无"}</p>
    {item.evidence.attachments.length > 0 && <p className="whitespace-pre-wrap break-words">附件：{lines(item.evidence.attachments)}</p>}
    {item.evidence.untested.length > 0 && <p className="whitespace-pre-wrap break-words">未测：{lines(item.evidence.untested)}</p>}
    {item.evidence.outOfScopeFindings.length > 0 && <p className="whitespace-pre-wrap break-words">范围外发现：{lines(item.evidence.outOfScopeFindings)}</p>}
  </div>
  <CollapsibleDetails title="命令与原始输出" open={technicalOpen} onToggle={onToggleTechnical}>{[
    ...item.evidence.commands.map((entry) => "$ " + entry.command + "\n" + entry.output),
    "假设\n" + lines(item.evidence.assumptions),
    "提交时间：" + time(item.evidence.submittedAt)
  ].join("\n\n")}</CollapsibleDetails>
</div> : null;

const Decisions = ({ cards }: { cards: DecisionCard[] }) => <div className="space-y-4">
  {cards.map((card) => <div key={card.decisionId} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
    <p className="text-label text-foreground">{card.withdrawn ? "已撤回" : "已答复"}：{card.question}</p>
    {card.answer && <p className="mt-1 text-caption text-muted-foreground">答复：{(card.options.find((option) => option.key === card.answer?.key)?.label ?? card.answer.key) + (card.answer.note ? " · " + card.answer.note : "")}</p>}
  </div>)}
</div>;

export const WorkItemDialog = ({ client, workspaceId, workItemId, workItems, runs, actions = [], onClose, onOpenSession, onOpenIssue }: WorkItemDialogProps) => {
  const item = workItems.find((entry) => entry.workItemId === workItemId);
  const [decisions, setDecisions] = useState<DecisionCard[]>();
  const [error, setError] = useState<string>();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [answeringDecisionId, setAnsweringDecisionId] = useState<string>();
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ requirements: false, verification: false, review: false, evidence: false, records: false, decisions: false });
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
  if (!item) return <Modal title="工单详情" onClose={onClose} width={800}><EmptyState title="工单不存在" hint={workItemId} /></Modal>;

  const itemRuns = runs.filter((run) => run.workItemId === workItemId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const itemActions = actions.filter((action) => action.workItemId === workItemId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const integration = itemActions.find((action): action is Extract<WorkflowAction, { kind: "integration" }> => action.kind === "integration" && action.stage === "merge" && action.status !== "done" && action.status !== "cancelled");
  const sessionId = item.run.sessionId ?? itemRuns[0]?.sessionId;
  const itemDecisions = decisions?.filter((card) => card.workItemId === workItemId || itemActions.some((action) => action.actionId === card.actionId) || item.decisions.includes(card.decisionId)) ?? [];
  const pendingDecisions = itemDecisions.filter((card) => !card.answer && !card.withdrawn);
  const resolvedDecisions = itemDecisions.filter((card) => card.answer || card.withdrawn);
  const unresolvedDependencies = item.dependsOn.filter((id) => workItems.find((other) => other.workItemId === id)?.status !== "closed");
  const progress = workItemProgress(item, itemActions, itemRuns.find((run) => run.sessionId === item.run.sessionId) ?? itemRuns[0], unresolvedDependencies);
  const events = workItemEvents(item, itemActions, itemRuns);
  const toggle = (section: string) => setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  const resume = async () => {
    setResuming(true);
    setError(undefined);
    try { await client.request("workItem.resume", { workspaceId, workItemId }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setResuming(false); }
  };
  const answerDecision = async (decisionId: string, key: string) => {
    setAnsweringDecisionId(decisionId);
    setError(undefined);
    try { await client.request("decision.answer", { workspaceId, decisionId, key }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setAnsweringDecisionId(undefined); }
  };
  return <Modal title={item.title} onClose={onClose} width={800} contentClassName="flex min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-5 px-5 py-5">
        <ProgressPanel item={item} progress={progress} pendingDecisions={pendingDecisions} onResume={() => void resume()} resuming={resuming} onAnswer={(decisionId, key) => void answerDecision(decisionId, key)} answeringDecisionId={answeringDecisionId} />
        {error && <InlineNotice tone="error" className="whitespace-pre-wrap break-words px-0">{error}</InlineNotice>}
        <ProgressTimeline events={events} />
        {integration && <IntegrationControls client={client} workspaceId={workspaceId} workItemId={workItemId} action={integration} item={item} />}
        <div className="space-y-3">
          <SectionDisclosure title="任务要求" summary="目标、范围与引用文档" open={openSections.requirements!} onToggle={() => toggle("requirements")}><Requirements item={item} /></SectionDisclosure>
          <SectionDisclosure title="验收结果" summary={item.verify ? item.verify.items.filter((entry) => entry.status === "pass").length + " / " + item.acceptance.length + " 通过" : "尚未验收"} open={openSections.verification!} onToggle={() => toggle("verification")}><Verification item={item} /></SectionDisclosure>
          {item.review.length > 0 && <SectionDisclosure title="审阅意见" summary={item.review.length + " 条 · 已处理"} open={openSections.review!} onToggle={() => toggle("review")}><Review item={item} /></SectionDisclosure>}
          {itemActions.length > 0 && <SectionDisclosure title="处理记录" summary={itemActions.length + " 个处理过程"} open={openSections.records!} onToggle={() => toggle("records")}><WorkflowDetails actions={itemActions} item={item} onOpenSession={(id) => { onClose(); onOpenSession(id); }} /></SectionDisclosure>}
          {item.evidence && <SectionDisclosure title="检查与附件" summary="检查命令、运行记录与交付附件" open={openSections.evidence!} onToggle={() => toggle("evidence")}><Evidence item={item} itemRuns={itemRuns} technicalOpen={technicalOpen} onToggleTechnical={() => setTechnicalOpen((open) => !open)} /></SectionDisclosure>}
          {resolvedDecisions.length > 0 && <SectionDisclosure title="已处理决策" summary={resolvedDecisions.length + " 条"} open={openSections.decisions!} onToggle={() => toggle("decisions")}><Decisions cards={resolvedDecisions} /></SectionDisclosure>}
        </div>
      </div>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
      <span className="mr-auto font-mono text-micro text-muted-foreground">{item.workItemId}</span>
      {item.issueId && onOpenIssue && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenIssue(item.issueId!); }}>Issue</Button>}
      {sessionId && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenSession(sessionId); }}>会话</Button>}
      {item.sourceSessionId && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenSession(item.sourceSessionId!, item.sourceTurnId); }}>来源</Button>}
    </footer>
  </Modal>;
};
