import { useEffect, useMemo, useState } from "react";
import type { Issue, WorkbenchClient, WorkItem } from "@vermillion/workbench/client";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog.js";
import { Modal } from "./Modal.js";
import { Badge, Button, Card, DetailSection, EmptyState, Field, InlineNotice, ListRow } from "./ui.js";

const statusLabel: Record<Issue["status"], string> = {
  open: "待处理", investigating: "调查中", decision: "待决策", started: "已开工", closed: "关闭", duplicate: "重复"
};
const sourceLabel: Record<Issue["source"], string> = { user: "用户", maintainer: "Maintainer", liaison: "Liaison" };
const evidenceLabel: Record<Issue["evidence"][number]["kind"], string> = {
  static: "静态证据", reproduced: "已复现", unverified: "待验证", user: "用户反馈"
};
const relativeTime = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + " 小时前";
  return new Date(value).toLocaleDateString("zh-CN");
};

type IssuesSectionProps = {
  client: WorkbenchClient;
  workspaceId: string;
  issues: Issue[];
  workItems: WorkItem[];
  domainIds: string[];
  targetIssueId?: string;
  targetDomainId?: string;
  onTargetConsumed?: () => void;
  onOpenSession: (sessionId: string, turnId?: string) => void;
  onOpenWorkItem: (workItemId: string) => void;
};

export const IssuesSection = ({ client, workspaceId, issues, workItems, domainIds, targetIssueId, targetDomainId, onTargetConsumed, onOpenSession, onOpenWorkItem }: IssuesSectionProps) => {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("decision");
  const [domainId, setDomainId] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const availableDomainIds = useMemo(() => {
    const values = [...new Set([...domainIds, ...issues.map((issue) => issue.domainId)])].sort();
    return values.length ? values : ["general"];
  }, [domainIds, issues]);
  useEffect(() => {
    if (!targetIssueId || !issues.some((issue) => issue.issueId === targetIssueId)) return;
    setSelectedId(targetIssueId);
    onTargetConsumed?.();
  }, [issues, onTargetConsumed, targetIssueId]);
  useEffect(() => { if (targetDomainId) setDomainId(targetDomainId); }, [targetDomainId]);
  const visible = useMemo(() => issues.filter((issue) =>
    (!search || [issue.title, issue.summary].some((value) => value.toLocaleLowerCase().includes(search.toLocaleLowerCase()))) &&
    (!domainId || issue.domainId === domainId) &&
    (filter === "all" || filter === "suggestion" ? filter !== "suggestion" || issue.type === "suggestion" : issue.status === filter)
  ), [domainId, filter, issues, search]);
  const selected = issues.find((issue) => issue.issueId === selectedId);
  return <div>
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <Field compact aria-label="搜索 Issue" placeholder="搜索 Issue" className="min-w-48 flex-1" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Field kind="select" compact aria-label="Issue 状态" className="w-32" value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="decision">待决策</option><option value="all">全部议题</option><option value="open">待处理</option>
        <option value="investigating">调查中</option><option value="started">已开工</option><option value="suggestion">建议</option>
        <option value="closed">关闭</option><option value="duplicate">重复</option>
      </Field>
      <Field kind="select" compact aria-label="Issue 领域" className="w-40" value={domainId} onChange={(event) => setDomainId(event.target.value)}>
        <option value="">全部领域</option>{availableDomainIds.map((id) => <option key={id} value={id}>{id}</option>)}
      </Field>
      <Button size="sm" onClick={() => setCreating(true)}>新建 Issue</Button>
    </div>
    {visible.length ? <ul className="max-w-6xl px-4">
      {visible.map((issue) => <li key={issue.issueId} className="border-b border-border">
        <ListRow title={<span title={issue.title}>{issue.unread && <span aria-label="未读">• </span>}{issue.title}</span>}
          meta={<span className="font-mono text-micro">{issue.issueId} · {issue.evidence[0] ? evidenceLabel[issue.evidence[0].kind] : "暂无证据"}</span>}
          onClick={() => setSelectedId(issue.issueId)}
          columns={{ info: <span>{issue.type === "suggestion" && "建议 · "}{issue.domainId} · {sourceLabel[issue.source]} · {relativeTime(issue.updatedAt)}</span>, status: <Badge tone={issue.status === "decision" ? "accent" : "neutral"}>{statusLabel[issue.status]}</Badge> }} />
      </li>)}
    </ul> : <EmptyState title={filter === "decision" ? "没有待决策的 Issue" : "没有符合条件的 Issue"} hint="调整筛选，或新建一条议题。" />}
    {creating && <CreateIssueDialog client={client} workspaceId={workspaceId} domainIds={availableDomainIds} onCreated={(issue) => { setCreating(false); setSelectedId(issue.issueId); }} onClose={() => setCreating(false)} />}
    {selected && <IssueDialog key={selected.issueId} client={client} workspaceId={workspaceId} issue={selected} issues={issues} workItems={workItems}
      onClose={() => setSelectedId(undefined)} onOpenIssue={setSelectedId} onOpenSession={onOpenSession} onOpenWorkItem={onOpenWorkItem} />}
  </div>;
};

const CreateIssueDialog = ({ client, workspaceId, domainIds, onCreated, onClose }: {
  client: WorkbenchClient; workspaceId: string; domainIds: string[]; onCreated: (issue: Issue) => void; onClose: () => void;
}) => {
  const [title, setTitle] = useState(""); const [summary, setSummary] = useState(""); const [domainId, setDomainId] = useState(domainIds[0] ?? "general");
  const [type, setType] = useState<Issue["type"]>("problem"); const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); setError(undefined); try {
    onCreated(await client.request("issue.create", { workspaceId, title, summary, domainId, type, evidence: [{ kind: "user", text: summary || title }] }));
  } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  return <Modal title="新建 Issue" onClose={onClose} width={560}><form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); if (title.trim() && !busy) void create(); }}>
    <Field label="标题" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
    <Field kind="textarea" label="问题与影响" rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} />
    <Field kind="select" label="领域" value={domainId} onChange={(event) => setDomainId(event.target.value)}>{domainIds.map((id) => <option key={id}>{id}</option>)}</Field>
    <Field kind="select" label="类型" value={type} onChange={(event) => setType(event.target.value as Issue["type"])}><option value="problem">问题</option><option value="suggestion">建议</option></Field>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !title.trim()}>创建</Button></div>
  </form></Modal>;
};

const IssueDialog = ({ client, workspaceId, issue, issues, workItems, onClose, onOpenIssue, onOpenSession, onOpenWorkItem }: {
  client: WorkbenchClient; workspaceId: string; issue: Issue; issues: Issue[]; workItems: WorkItem[]; onClose: () => void;
  onOpenIssue: (issueId: string) => void;
  onOpenSession: (sessionId: string, turnId?: string) => void; onOpenWorkItem: (workItemId: string) => void;
}) => {
  const [handling, setHandling] = useState(false); const [creatingWork, setCreatingWork] = useState(false);
  const [resolution, setResolution] = useState<"closed" | "duplicate">("closed"); const [reason, setReason] = useState(""); const [duplicateOf, setDuplicateOf] = useState("");
  const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  useEffect(() => { if (issue.unread) void client.request("issue.read", { workspaceId, issueId: issue.issueId }); }, [client, issue.issueId, issue.unread, workspaceId]);
  const discuss = async () => { setBusy(true); setError(undefined); try { const updated = await client.request("issue.discuss", { workspaceId, issueId: issue.issueId }); onClose(); onOpenSession(updated.discussionSessionId!, updated.discussionTurnId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const resolve = async () => { setBusy(true); setError(undefined); try { await client.request("issue.update", { workspaceId, issueId: issue.issueId, status: resolution, resolutionReason: reason, ...(resolution === "duplicate" ? { duplicateOf } : {}) }); setHandling(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const linked = issue.workItemIds.map((id) => workItems.find((item) => item.workItemId === id)).filter(Boolean) as WorkItem[];
  return <><Modal title={"Issue · " + issue.issueId} onClose={onClose} width={760}>
    <Card className="m-4" header={<>{issue.type === "suggestion" && <Badge>建议</Badge>}<Badge tone={issue.status === "decision" ? "accent" : "neutral"}>{statusLabel[issue.status]}</Badge><span className="text-caption text-muted-foreground">{issue.domainId} · {sourceLabel[issue.source]}</span></>}
      footer={<>{issue.sourceSessionId && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenSession(issue.sourceSessionId!, issue.sourceTurnId); }}>来源</Button>}{issue.duplicateOf && <Button variant="ghost" outlined onClick={() => onOpenIssue(issue.duplicateOf!)}>原议题</Button>}{linked.map((item) => <Button key={item.workItemId} variant="ghost" outlined onClick={() => { onClose(); onOpenWorkItem(item.workItemId); }}>工单</Button>)}
        {issue.discussionSessionId && <Button variant="ghost" outlined onClick={() => { onClose(); onOpenSession(issue.discussionSessionId!, issue.discussionTurnId); }}>讨论</Button>}
        {!handling && !["closed", "duplicate"].includes(issue.status) && <Button className="ml-auto" onClick={() => setHandling(true)}>处理</Button>}
        {!handling && !["closed", "duplicate"].includes(issue.status) && <Button onClick={() => setCreatingWork(true)}>创建工单</Button>}
        {!handling && !["closed", "duplicate"].includes(issue.status) && <Button variant="primary" disabled={busy} onClick={() => void discuss()}>{issue.discussionSessionId ? "继续讨论" : "进入讨论"}</Button>}
      </>}>
      <DetailSection title="议题">{issue.title}</DetailSection><DetailSection title="问题与影响">{issue.summary || "未填写"}</DetailSection>
      {issue.requirement && <DetailSection title="要求依据">{[issue.requirement.text, issue.requirement.path, issue.requirement.section, issue.requirement.commit].filter(Boolean).join("\n")}</DetailSection>}
      <DetailSection title="证据">{issue.evidence.length ? issue.evidence.map((entry) => `${evidenceLabel[entry.kind]}：${entry.text}${entry.path ? "\n" + entry.path : ""}`).join("\n\n") : "暂无证据"}</DetailSection>
      {issue.decisionQuestion && <DetailSection title="需要决定">{issue.decisionQuestion}</DetailSection>}{issue.suggestion && <DetailSection title="建议方向">{issue.suggestion}</DetailSection>}
      {issue.resolutionReason && <DetailSection title="处理结果">{issue.resolutionReason}{issue.duplicateOf ? "\n原议题：" + issue.duplicateOf : ""}</DetailSection>}
      <DetailSection title="活动">{issue.activities.map((entry) => `${new Date(entry.at).toLocaleString("zh-CN")} · ${entry.message}${entry.workItemId ? " · " + entry.workItemId : ""}`).join("\n")}</DetailSection>
      {handling && <div className="mt-3 space-y-3 border-t border-border pt-3"><Field kind="select" label="处理方式" value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)}><option value="closed">关闭</option><option value="duplicate">重复</option></Field>
        {resolution === "duplicate" && <Field kind="select" label="原议题" value={duplicateOf} onChange={(event) => setDuplicateOf(event.target.value)}><option value="">选择原议题</option>{issues.filter((entry) => entry.issueId !== issue.issueId).map((entry) => <option key={entry.issueId} value={entry.issueId}>{entry.title}</option>)}</Field>}
        <Field kind="textarea" label="处理原因" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setHandling(false)}>取消</Button><Button variant="primary" disabled={busy || !reason.trim() || (resolution === "duplicate" && !duplicateOf)} onClick={() => void resolve()}>保存</Button></div></div>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </Card>
  </Modal>{creatingWork && <CreateWorkItemDialog client={client} workspaceId={workspaceId} issue={issue} onClose={() => setCreatingWork(false)} />}</>;
};
