import { useEffect, useMemo, useState } from "react";
import type { Issue, WorkbenchClient, WorkItem } from "@vermillion/workbench/client";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog.js";
import { Modal } from "./Modal.js";
import { Badge, Button, Card, DetailSection, EmptyState, Field, InlineNotice, ListRow, Select } from "./ui.js";
import { serviceText, t } from "../../../i18n/index.js";
import { formatAgo, formatDate, formatDateTime } from "../../../i18n/format.js";
import { useT } from "../../../i18n/react.js";

const statusLabel = (status: Issue["status"]): string => ({
  open: t("docs.issues.status.open"), investigating: t("docs.issues.status.investigating"), decision: t("docs.issues.status.decision"),
  started: t("docs.issues.status.started"), closed: t("docs.issues.status.closed"), duplicate: t("docs.issues.status.duplicate")
})[status];
const sourceLabel = (source: Issue["source"]): string => source === "user" ? t("docs.issues.source.user") : source === "maintainer" ? "Maintainer" : "Liaison";
const evidenceLabel = (kind: Issue["evidence"][number]["kind"]): string => ({
  static: t("docs.issues.evidence.static"), reproduced: t("docs.issues.evidence.reproduced"),
  unverified: t("docs.issues.evidence.unverified"), user: t("docs.issues.evidence.user")
})[kind];
const relativeTime = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return t("common.justNow");
  if (minutes < 60) return formatAgo(minutes, "minute");
  if (minutes < 24 * 60) return formatAgo(Math.floor(minutes / 60), "hour");
  return formatDate(value);
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
  const t = useT();
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
      <Field compact aria-label={t("docs.issues.search")} placeholder={t("docs.issues.search")} className="min-w-48 flex-1" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Select compact aria-label={t("docs.issues.statusFilter")} className="w-32" value={filter} onChange={setFilter} options={[
        { value: "decision", label: statusLabel("decision") }, { value: "all", label: t("docs.issues.all") }, { value: "open", label: statusLabel("open") },
        { value: "investigating", label: statusLabel("investigating") }, { value: "started", label: statusLabel("started") }, { value: "suggestion", label: t("docs.issues.suggestion") },
        { value: "closed", label: statusLabel("closed") }, { value: "duplicate", label: statusLabel("duplicate") }]} />
      <Select compact aria-label={t("docs.issues.domainFilter")} className="w-40" value={domainId} onChange={setDomainId}
        options={[{ value: "", label: t("docs.issues.allDomains") }, ...availableDomainIds.map((id) => ({ value: id, label: id }))]} />
      <Button size="sm" onClick={() => setCreating(true)}>{t("docs.issues.new")}</Button>
    </div>
    {visible.length ? <ul className="max-w-6xl px-4">
      {visible.map((issue) => <li key={issue.issueId} className="border-b border-border">
        <ListRow title={<span title={issue.title}>{issue.unread && <span aria-label={t("docs.issues.unread")}>• </span>}{issue.title}</span>}
          meta={<span className="font-mono text-micro">{issue.issueId} · {issue.evidence[0] ? evidenceLabel(issue.evidence[0].kind) : t("docs.issues.noEvidence")}</span>}
          onClick={() => setSelectedId(issue.issueId)}
          columns={{ info: <span>{issue.type === "suggestion" && t("docs.issues.suggestionPrefix")}{issue.domainId} · {sourceLabel(issue.source)} · {relativeTime(issue.updatedAt)}</span>, status: <Badge tone={issue.status === "decision" ? "accent" : "neutral"}>{statusLabel(issue.status)}</Badge> }} />
      </li>)}
    </ul> : <EmptyState title={filter === "decision" ? t("docs.issues.emptyDecision") : t("docs.issues.emptyFiltered")} hint={t("docs.issues.emptyHint")} />}
    {creating && <CreateIssueDialog client={client} workspaceId={workspaceId} domainIds={availableDomainIds} onCreated={(issue) => { setCreating(false); setSelectedId(issue.issueId); }} onClose={() => setCreating(false)} />}
    {selected && <IssueDialog key={selected.issueId} client={client} workspaceId={workspaceId} issue={selected} issues={issues} workItems={workItems}
      onClose={() => setSelectedId(undefined)} onOpenIssue={setSelectedId} onOpenSession={onOpenSession} onOpenWorkItem={onOpenWorkItem} />}
  </div>;
};

const CreateIssueDialog = ({ client, workspaceId, domainIds, onCreated, onClose }: {
  client: WorkbenchClient; workspaceId: string; domainIds: string[]; onCreated: (issue: Issue) => void; onClose: () => void;
}) => {
  const t = useT();
  const [title, setTitle] = useState(""); const [summary, setSummary] = useState(""); const [domainId, setDomainId] = useState(domainIds[0] ?? "general");
  const [type, setType] = useState<Issue["type"]>("problem"); const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); setError(undefined); try {
    onCreated(await client.request("issue.create", { workspaceId, title, summary, domainId, type, evidence: [{ kind: "user", text: summary || title }] }));
  } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  return <Modal title={t("docs.issues.new")} onClose={onClose} width={560}><form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); if (title.trim() && !busy) void create(); }}>
    <Field label={t("docs.issues.titleField")} autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
    <Field kind="textarea" label={t("docs.issues.summary")} rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} />
    <Select label={t("docs.issues.domain")} value={domainId} onChange={setDomainId} options={domainIds.map((id) => ({ value: id, label: id }))} />
    <Select label={t("docs.issues.type")} value={type} onChange={(value) => setType(value as Issue["type"])} options={[{ value: "problem", label: t("docs.issues.problem") }, { value: "suggestion", label: t("docs.issues.suggestion") }]} />
    {error && <InlineNotice tone="error">{error}</InlineNotice>}<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" type="submit" disabled={busy || !title.trim()}>{t("docs.create")}</Button></div>
  </form></Modal>;
};

const IssueDialog = ({ client, workspaceId, issue, issues, workItems, onClose, onOpenIssue, onOpenSession, onOpenWorkItem }: {
  client: WorkbenchClient;
  workspaceId: string;
  issue: Issue;
  issues: Issue[];
  workItems: WorkItem[];
  onClose: () => void;
  onOpenIssue: (issueId: string) => void;
  onOpenSession: (sessionId: string, turnId?: string) => void;
  onOpenWorkItem: (workItemId: string) => void;
}) => {
  const t = useT();
  const [handling, setHandling] = useState(false);
  const [creatingWork, setCreatingWork] = useState(false);
  const [resolution, setResolution] = useState<"closed" | "duplicate">("closed");
  const [reason, setReason] = useState("");
  const [duplicateOf, setDuplicateOf] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (issue.unread) void client.request("issue.read", { workspaceId, issueId: issue.issueId });
  }, [client, issue.issueId, issue.unread, workspaceId]);

  const discuss = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await client.request("issue.discuss", { workspaceId, issueId: issue.issueId });
      onClose();
      onOpenSession(updated.discussionSessionId!, updated.discussionTurnId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request("issue.update", {
        workspaceId,
        issueId: issue.issueId,
        status: resolution,
        resolutionReason: reason,
        ...(resolution === "duplicate" ? { duplicateOf } : {})
      });
      setHandling(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const linked = issue.workItemIds
    .map((id) => workItems.find((item) => item.workItemId === id))
    .filter((item): item is WorkItem => !!item);
  const canAct = !handling && !["closed", "duplicate"].includes(issue.status);

  return <>
    <Modal title={"Issue · " + issue.issueId} onClose={onClose} width={760}>
      <Card
        className="m-4"
        header={<>
          {issue.type === "suggestion" && <Badge>{t("docs.issues.suggestion")}</Badge>}
          <Badge tone={issue.status === "decision" ? "accent" : "neutral"}>{statusLabel(issue.status)}</Badge>
          <span className="text-caption text-muted-foreground">{issue.domainId} · {sourceLabel(issue.source)}</span>
        </>}
        footer={<>
          {issue.sourceSessionId && <Button variant="ghost" outlined onClick={() => {
            onClose(); onOpenSession(issue.sourceSessionId!, issue.sourceTurnId);
          }}>{t("docs.issues.patrolSession")}</Button>}
          {issue.duplicateOf && <Button variant="ghost" outlined onClick={() => onOpenIssue(issue.duplicateOf!)}>{t("docs.issues.original")}</Button>}
          {linked.map((item) => <Button key={item.workItemId} variant="ghost" outlined onClick={() => {
            onClose(); onOpenWorkItem(item.workItemId);
          }}>{t("docs.issues.workItem")}</Button>)}
          {issue.discussionSessionId && <Button variant="ghost" outlined onClick={() => {
            onClose(); onOpenSession(issue.discussionSessionId!, issue.discussionTurnId);
          }}>{t("docs.issues.discussion")}</Button>}
          {canAct && <Button className="ml-auto" onClick={() => setHandling(true)}>{t("docs.issues.handle")}</Button>}
          {canAct && <Button onClick={() => setCreatingWork(true)}>{t("docs.issues.createWorkItem")}</Button>}
          {canAct && <Button variant="primary" disabled={busy} onClick={() => void discuss()}>
            {issue.discussionSessionId ? t("docs.issues.continueDiscussion") : t("docs.issues.startDiscussion")}
          </Button>}
        </>}
      >
        <DetailSection title="Issue">{issue.title}</DetailSection>
        <DetailSection title={t("docs.issues.summary")}>{issue.summary || t("docs.issues.notProvided")}</DetailSection>
        {issue.requirement && <DetailSection title={t("docs.issues.requirement")}>
          {[issue.requirement.text, issue.requirement.path, issue.requirement.section, issue.requirement.commit].filter(Boolean).join("\n")}
        </DetailSection>}
        <DetailSection title={t("docs.issues.evidence")}>
          {issue.evidence.length
            ? issue.evidence.map((entry) => `${t("docs.issues.evidenceEntry", { label: evidenceLabel(entry.kind), text: entry.text })}${entry.path ? "\n" + entry.path : ""}`).join("\n\n")
            : t("docs.issues.noEvidence")}
        </DetailSection>
        {issue.decisionQuestion && <DetailSection title={t("docs.issues.decisionQuestion")}>{issue.decisionQuestion}</DetailSection>}
        {issue.suggestion && <DetailSection title={t("docs.issues.suggestionDirection")}>{issue.suggestion}</DetailSection>}
        {issue.resolutionReason && <DetailSection title={t("docs.issues.resolution")}>
          {issue.resolutionReason}{issue.duplicateOf ? t("docs.issues.originalLine", { issueId: issue.duplicateOf }) : ""}
        </DetailSection>}
        <DetailSection title={t("docs.issues.activity")}>
          <div className="space-y-1">
            {issue.activities.map((entry, index) => <div key={index} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{formatDateTime(entry.at)} · {serviceText(entry.message)}{entry.workItemId ? " · " + entry.workItemId : ""}</span>
              {entry.sessionId && <Button size="sm" variant="ghost" outlined className="shrink-0" onClick={() => {
                onClose(); onOpenSession(entry.sessionId!);
              }}>{t("docs.issues.patrolSession")}</Button>}
            </div>)}
          </div>
        </DetailSection>
        {handling && <div className="mt-3 space-y-3 border-t border-border pt-3">
          <Select label={t("docs.issues.resolutionKind")} value={resolution} onChange={(value) => setResolution(value as typeof resolution)}
            options={[{ value: "closed", label: statusLabel("closed") }, { value: "duplicate", label: statusLabel("duplicate") }]} />
          {resolution === "duplicate" && <Select label={t("docs.issues.original")} value={duplicateOf} onChange={setDuplicateOf} placeholder={t("docs.issues.selectOriginal")}
            options={issues.filter((entry) => entry.issueId !== issue.issueId).map((entry) => ({ value: entry.issueId, label: entry.title }))} />}
          <Field kind="textarea" label={t("docs.issues.reason")} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setHandling(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={busy || !reason.trim() || (resolution === "duplicate" && !duplicateOf)} onClick={() => void resolve()}>{t("common.save")}</Button>
          </div>
        </div>}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </Card>
    </Modal>
    {creatingWork && <CreateWorkItemDialog client={client} workspaceId={workspaceId} issue={issue} onClose={() => setCreatingWork(false)} />}
  </>;
};
