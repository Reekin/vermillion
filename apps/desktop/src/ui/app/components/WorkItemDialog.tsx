import { useEffect, useState } from "react";
import type { AgentRun, DecisionCard, WorkbenchClient, WorkItem } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Badge, Button, Card, CollapsibleDetails, DetailSection, EmptyState, InlineNotice, ListRow } from "./ui.js";
import { statusLabel } from "./task-labels.js";

type WorkItemDialogProps = {
  client: WorkbenchClient;
  workspaceId: string;
  workItemId: string;
  workItems: WorkItem[];
  runs: AgentRun[];
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
};

const lines = (values: string[]) => values.length ? values.map((value) => "• " + value).join("\n") : "无";
const time = (value: string) => new Date(value).toLocaleString("zh-CN");
const runStatus = { running: "进行中", done: "已结束", failed: "失败" };
const roleLabel = { steward: "管家", worker: "Worker", supervisor: "Supervisor" };

export const WorkItemDialog = ({ client, workspaceId, workItemId, workItems, runs, onClose, onOpenSession }: WorkItemDialogProps) => {
  const item = workItems.find((entry) => entry.workItemId === workItemId);
  const [decisions, setDecisions] = useState<DecisionCard[]>();
  const [error, setError] = useState<string>();
  const [technicalOpen, setTechnicalOpen] = useState(false);
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
  const itemRuns = runs.filter((run) => run.workItemId === workItemId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const sessionId = item?.run.sessionId ?? itemRuns[0]?.sessionId;
  const itemDecisions = decisions?.filter((card) => card.workItemId === workItemId || item?.decisions.includes(card.decisionId));
  return <Modal title="工单详情" onClose={onClose} width={800}>
    {!item ? <EmptyState title="工单不存在" hint={workItemId} /> : <Card
      className="m-4"
      header={<><Badge>{item.risk}</Badge><Badge status={item.status}>{statusLabel[item.status]}</Badge></>}
      footer={sessionId && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenSession(sessionId); }}>会话</Button>}
    >
      <DetailSection title="工单">{item.title}</DetailSection>
      <DetailSection title="目标">{item.objective || "未填写"}</DetailSection>
      <DetailSection title="范围">{lines(item.scope.inScope)}</DetailSection>
      <DetailSection title="不在范围内">{lines(item.scope.outOfScope)}</DetailSection>
      <DetailSection title="允许路径">{lines(item.scope.allowedPaths)}</DetailSection>
      <DetailSection title="验收条目">{item.acceptance.length ? item.acceptance.map((entry, index) => `${index + 1}. ${entry.text}${entry.source ? "\n来源：" + entry.source : ""}`).join("\n\n") : "无"}</DetailSection>
      <DetailSection title="引用文档">{item.refs.length ? item.refs.map((ref) => `${ref.path}${ref.section ? " · " + ref.section : ""}\ncommit: ${ref.commit}`).join("\n\n") : "无"}</DetailSection>
      <DetailSection title="依赖工单">{item.dependsOn.length ? item.dependsOn.map((id) => {
        const dependency = workItems.find((entry) => entry.workItemId === id);
        return <ListRow key={id} title={dependency?.title ?? id} trailing={dependency && <Badge status={dependency.status}>{statusLabel[dependency.status]}</Badge>} />;
      }) : "无"}</DetailSection>
      {item.needs.length > 0 && <DetailSection title="执行资源">{lines(item.needs)}</DetailSection>}
      <DetailSection title="运行记录">
        {itemRuns.length ? itemRuns.map((run) => <DetailSection key={run.runId} title={`${roleLabel[run.role]} · ${runStatus[run.status]} · ${run.turns} turn`}>
          {[time(run.startedAt) + (run.endedAt ? " → " + time(run.endedAt) : ""), run.note].filter(Boolean).join("\n")}
        </DetailSection>) : "暂无运行记录"}
        {item.run.lastFailure && <InlineNotice tone="error">{item.run.lastFailure}</InlineNotice>}
      </DetailSection>
      <DetailSection title="证据">{item.evidence?.summary || "尚未提交"}</DetailSection>
      {item.evidence && <CollapsibleDetails title="证据命令与附件" open={technicalOpen} onToggle={() => setTechnicalOpen(!technicalOpen)}>{[
        ...item.evidence.commands.map((entry) => "$ " + entry.command + "\n" + entry.output),
        "附件\n" + lines(item.evidence.attachments), "假设\n" + lines(item.evidence.assumptions),
        "未测\n" + lines(item.evidence.untested), "范围外发现\n" + lines(item.evidence.outOfScopeFindings),
        "提交时间：" + time(item.evidence.submittedAt)
      ].join("\n\n")}</CollapsibleDetails>}
      <DetailSection title="Review 处置">{item.review.length ? item.review.map((entry) => `${entry.decision === "accepted" ? "采纳" : "拒绝"}：${entry.comment}\n理由：${entry.reason}`).join("\n\n") : "暂无 Review 记录"}</DetailSection>
      <DetailSection title="验收结果">{item.verify ? [
        (item.verify.verdict === "pass" ? "通过" : "需返工") + " · " + time(item.verify.verifiedAt),
        ...item.verify.items.map((entry) => `${entry.index + 1}. ${item.acceptance[entry.index]?.text ?? "验收项"}\n${entry.pass ? "通过" : "未通过"}：${entry.evidence}`)
      ].join("\n\n") : "尚未验收"}</DetailSection>
      <DetailSection title="决策">
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : !itemDecisions ? "加载中…" : itemDecisions.length ? itemDecisions.map((card) => <DetailSection key={card.decisionId} title={card.answer ? "已答复" : "待答复"}>{[
          card.question, card.context,
          ...card.options.map((option) => option.label + (option.detail ? "：" + option.detail : "") + (option.key === card.recommended ? "（推荐）" : "")),
          card.recommendation, card.details,
          ...(card.adjustments ?? []).map((entry) => "合同调整：" + entry.note),
          card.answer && "答复：" + [card.options.find((option) => option.key === card.answer?.key)?.label ?? card.answer.key, card.answer.note, time(card.answer.at)].filter(Boolean).join(" · ")
        ].filter(Boolean).join("\n\n")}</DetailSection>) : "暂无决策"}
      </DetailSection>
    </Card>}
  </Modal>;
};
