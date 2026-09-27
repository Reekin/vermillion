import { Ban, FileText, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DomainConfig, DomainDefinition, Issue, PatrolRun, WorkbenchClient } from "@vermillion/workbench/client";
import { Button, Card, Checkbox, EmptyState, Field, IconButton, InlineNotice, ListRow, MarkdownPreview, OverflowMenu, PanelHeader, Select, SettingRow, StatusIcon, StatusPill, Toggle, type StatusTone } from "./ui.js";
import { Modal } from "./Modal.js";
import { serviceText, t } from "../../../i18n/index.js";
import { formatAgo, formatClock, formatMonthDay } from "../../../i18n/format.js";
import { useT } from "../../../i18n/react.js";

const DOMAINS_DIR = ".vermillion/docs/domains/";
const DOCS_DIR = ".vermillion/docs/";
/** Number of recent patrols summarized in the result strip. */
const PATROL_STRIP_SIZE = 14;

const patrolTrigger = (trigger: PatrolRun["trigger"]): string =>
  trigger === "manual" ? t("docs.domains.trigger.manual") : trigger === "change" ? t("docs.domains.trigger.change") : t("docs.domains.trigger.scheduled");
const onOff = (value: boolean): string => value ? t("docs.domains.on") : t("docs.domains.off");
const fileTitle = (path: string): string => path.split("/").at(-1)?.replace(/\.md$/i, "") || path;

const formatDay = (value: string): string => formatMonthDay(new Date(value));

const clockTime = (value: string): string => `${formatDay(value)} ${formatClock(new Date(value))}`;

/** Relative time for records of the last day, month/day with time for older ones. */
export const patrolTime = (value: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return t("common.justNow");
  if (minutes < 60) return formatAgo(minutes, "minute");
  if (minutes < 24 * 60) return formatAgo(Math.floor(minutes / 60), "hour");
  return clockTime(value);
};

export type PatrolTone = "clean" | "issue" | "failed" | "running";

export const patrolTone = (run: PatrolRun): PatrolTone =>
  run.status === "queued" || run.status === "running" ? "running"
    : run.status === "failed" ? "failed"
      : run.issueIds.length ? "issue" : "clean";

export type PatrolEntry =
  | { kind: "run"; run: PatrolRun }
  | { kind: "skipped"; runs: PatrolRun[] };

/** Newest first; consecutive skipped patrols collapse into one entry so the findings stay visible. */
export const groupPatrolRuns = (runs: PatrolRun[]): PatrolEntry[] => {
  const entries: PatrolEntry[] = [];
  for (const run of [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt))) {
    const last = entries.at(-1);
    if (run.status === "skipped" && last?.kind === "skipped") last.runs.push(run);
    else entries.push(run.status === "skipped" ? { kind: "skipped", runs: [run] } : { kind: "run", run });
  }
  return entries;
};

/** "9月14日 至 9月15日 连续 4 次无新变更，已跳过"; a single skip keeps its own summary. */
export const skippedSummary = (runs: PatrolRun[]): string => {
  if (runs.length === 1) return serviceText(runs[0]!.summary) || t("docs.domains.skippedOne");
  const oldest = formatDay(runs.at(-1)!.startedAt);
  const newest = formatDay(runs[0]!.startedAt);
  return t("docs.domains.skippedMany", { range: oldest === newest ? oldest : t("docs.domains.dayRange", { from: oldest, to: newest }), count: runs.length });
};

/** Header state of the domain's patrol: a running patrol wins over the configured schedule. */
const patrolState = (config: DomainConfig | undefined, runs: PatrolRun[]): { tone: StatusTone; label: string } => {
  const active = runs.find((run) => run.status === "running" || run.status === "queued");
  if (active) return { tone: "running", label: active.status === "running" ? t("docs.domains.state.running") : t("docs.domains.state.queued") };
  if (!config?.enabled) return { tone: "neutral", label: t("docs.domains.state.disabled") };
  if (config.retryAt) return { tone: "failed", label: t("docs.domains.state.failed") };
  return { tone: "done", label: t("docs.domains.state.enabled") };
};

/** Resolves a relative link inside a domain document to a workspace path under .vermillion/docs. */
export const resolveDocLink = (documentPath: string, href: string): string | undefined => {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("#")) return undefined;
  const base = new URL("file:///" + documentPath.split("/").slice(0, -1).join("/") + "/");
  const resolved = decodeURIComponent(new URL(href.split("#")[0]!, base).pathname).replace(/^\//, "");
  return resolved.startsWith(DOCS_DIR) ? resolved : undefined;
};

/** The detail header already shows the title, so the document's first H1 is dropped from the rendered body. */
const definitionBody = (content: string): string =>
  content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, "").replace(/^\s*#\s+[^\n]*\n/, "");

export const DomainsSection = ({ client, workspaceId, workspaceRoot, domains, patrolRuns, issues, onOpenDoc, onOpenInstruction, onOpenSession, onOpenIssues }: {
  client: WorkbenchClient; workspaceId: string; workspaceRoot: string; domains: DomainDefinition[]; patrolRuns: PatrolRun[]; issues: Issue[];
  onOpenDoc: (path: string) => void; onOpenInstruction: (domainId: string) => void; onOpenSession: (sessionId: string) => void;
  onOpenIssues: (domainId: string) => void;
}) => {
  const t = useT();
  const [selectedId, setSelectedId] = useState(domains[0]?.domainId ?? "");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [pickingPaths, setPickingPaths] = useState(false);
  const [editingAuthorization, setEditingAuthorization] = useState(false);
  const [config, setConfig] = useState<DomainConfig>();
  const [definition, setDefinition] = useState<string>();
  const [error, setError] = useState<string>();
  const selected = domains.find((domain) => domain.domainId === selectedId) ?? domains[0];
  useEffect(() => { if (selected && selected.domainId !== selectedId) setSelectedId(selected.domainId); }, [selected, selectedId]);
  useEffect(() => { setConfig(selected?.config); }, [selected]);
  // The domain object is replaced whenever its document changes, so it is the refresh signal for the rendered definition.
  useEffect(() => {
    let active = true;
    setDefinition(undefined);
    if (!selected) return;
    client.request("docs.read", { workspaceId, path: selected.path })
      .then(({ content }) => { if (active) setDefinition(content); })
      .catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [client, workspaceId, selected]);
  const decisionDomains = useMemo(() => new Set(issues.filter((issue) => issue.status === "decision").map((issue) => issue.domainId)), [issues]);
  const create = async () => {
    const id = draft.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!id) return;
    setError(undefined);
    try {
      const path = DOMAINS_DIR + id + ".md";
      await client.request("docs.write", { workspaceId, path, content: t("docs.domains.template") });
      setDraft(""); setCreating(false); setSelectedId(id); onOpenDoc(path);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const run = async () => {
    if (!selected) return;
    setError(undefined);
    try { await client.request("domain.patrol.run", { workspaceId, domainId: selected.domainId }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const updateConfig = async (changes: Partial<DomainConfig>) => {
    if (!selected || !config) return;
    const next = { ...config, ...changes };
    setConfig(next); setError(undefined);
    try {
      setConfig(await client.request("domain.config.set", { workspaceId, domainId: selected.domainId, value: {
        enabled: next.enabled, changeTrigger: next.changeTrigger, intervalHours: next.intervalHours,
        triggerPaths: next.triggerPaths, autoWorkEnabled: next.autoWorkEnabled, authorizationScope: next.authorizationScope } }));
    } catch (caught) {
      setConfig(selected.config);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const removeDomain = async (domainId: string) => {
    setError(undefined);
    try {
      await client.request("domain.remove", { workspaceId, domainId });
      setRemoving(undefined);
      setSelectedId(domains.filter((domain) => domain.domainId !== domainId)[0]?.domainId ?? "");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const target = domains.find((domain) => domain.domainId === removing);
  const listed = <div className="flex w-60 shrink-0 flex-col border-r border-border bg-app-shell">
    <PanelHeader title={t("docs.domains.title")}><IconButton icon={Plus} label={t("docs.domains.new")} onClick={() => setCreating((value) => !value)} /></PanelHeader>
    {creating && <form className="flex items-center gap-1 px-4 pb-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <Field value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("docs.domains.idPlaceholder")} className="w-28" /><Button type="submit" size="sm" disabled={!draft.trim()}>{t("docs.create")}</Button>
    </form>}
    <ul className="min-h-0 flex-1 overflow-auto">{domains.map((domain) => <li key={domain.domainId}>
      <ListRow title={<span className="vm-domain-item__title">{domain.title}{decisionDomains.has(domain.domainId) && <span className="vm-domain-item__mark" aria-label={t("docs.domains.hasDecision")} />}</span>}
        meta={<span title={[domain.summary, t("docs.domains.meta", { id: domain.domainId, count: domain.standards.length })].filter(Boolean).join("\n")}>
          {domain.summary || t("docs.domains.meta", { id: domain.domainId, count: domain.standards.length })}</span>}
        selected={domain.domainId === selected?.domainId}
        onClick={() => setSelectedId(domain.domainId)}
        hoverActions={<IconButton icon={X} size={12} label={t("docs.domains.deleteLabel", { title: domain.title })} onClick={() => setRemoving(domain.domainId)} />} />
    </li>)}</ul>
  </div>;
  if (!selected) return <div className="flex min-h-0 flex-1">
    {listed}
    <EmptyState title={t("docs.domains.empty")} action={<Button onClick={() => setCreating(true)}>{t("docs.domains.new")}</Button>} />
  </div>;
  const instructionPath = `.vermillion/roles/maintainer/${selected.domainId}.md`;
  const runs = patrolRuns.filter((patrol) => patrol.domainId === selected.domainId);
  const recent = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, PATROL_STRIP_SIZE);
  const state = patrolState(config, runs);
  const documentUrl = "file:///" + [workspaceRoot.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), ...selected.path.split("/")].join("/");
  return <div className="flex min-h-0 flex-1">
    {listed}
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="vm-domain-detail">
        <header className="vm-domain-detail__head">
          <h2 className="truncate text-title font-semibold text-strong">{selected.title}</h2>
          <span className="vm-domain-id">{selected.domainId}</span>
          <span className="ml-auto" />
          <StatusPill tone={state.tone}>{state.label}</StatusPill>
          <Button size="sm" onClick={() => void run()}><RefreshCw size={14} aria-hidden="true" />{t("docs.domains.patrolNow")}</Button>
          <OverflowMenu label={t("docs.moreActions", { name: selected.title })} items={[{ label: t("docs.domains.delete"), onSelect: () => setRemoving(selected.domainId) }]} />
        </header>
        {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
        <div className="vm-domain-grid">
          <Card header={<h3 className="vm-card-title">{t("docs.domains.definition")}</h3>}>
            {definition === undefined ? <p className="text-caption text-muted-foreground">{t("docs.domains.definitionLoading")}</p>
              : <div className="vm-domain-definition"><MarkdownPreview content={definitionBody(definition)} documentUrl={documentUrl} onOpenLink={(href) => {
                const path = resolveDocLink(selected.path, href);
                if (path) onOpenDoc(path);
                return Boolean(path);
              }} /></div>}
          </Card>
          {config && <Card header={<h3 className="vm-card-title">{t("docs.domains.patrol")}</h3>}>
            <SettingRow label={t("docs.domains.autoPatrol")} state={config.enabled ? t("docs.domains.autoPatrolNext", { time: clockTime(config.nextRunAt) }) : t("docs.domains.off")}
              control={<Toggle labelHidden label={t("docs.domains.autoPatrol")} checked={config.enabled} onChange={(enabled) => void updateConfig({ enabled })} />} />
            <SettingRow label={t("docs.domains.changePatrol")} state={t("docs.domains.changePatrolState", { state: onOff(config.changeTrigger), count: config.triggerPaths.length })}
              actions={<Button size="sm" variant="ghost" onClick={() => setPickingPaths(true)}>{t("docs.domains.chooseDirectories")}</Button>}
              control={<Toggle labelHidden label={t("docs.domains.changePatrol")} checked={config.changeTrigger} onChange={(changeTrigger) => void updateConfig({ changeTrigger })} />} />
            <SettingRow label={t("docs.domains.scheduledPatrol")} state={config.retryAt ? t("docs.domains.retry", { time: clockTime(config.retryAt) }) : undefined}
              control={<Select compact aria-label={t("docs.domains.interval")} className="w-28" value={String(config.intervalHours)} onChange={(value) => void updateConfig({ intervalHours: Number(value) })}
                options={[3, 6, 12, 24, 48, 168].map((hours) => ({ value: String(hours), label: t("docs.domains.everyHours", { hours }) }))} />} />
            <SettingRow label={t("docs.domains.autoWork")} state={t("docs.domains.autoWorkState", { state: onOff(config.autoWorkEnabled), count: config.authorizationScope.length })}
              actions={<Button size="sm" variant="ghost" onClick={() => setEditingAuthorization(true)}>{t("docs.domains.editScope")}</Button>}
              control={<Toggle labelHidden label={t("docs.domains.autoWork")} checked={config.autoWorkEnabled} onChange={(autoWorkEnabled) => void updateConfig({ autoWorkEnabled })} />} />
          </Card>}
        </div>
        <Card header={<h3 className="vm-card-title">{t("docs.domains.standards")} <span className="vm-card-title__count">{selected.standards.length + 2}</span></h3>}>
          <ul>
            <li><FileRow icon={<FileText size={14} />} name={t("docs.domains.definition")} path={selected.path} onOpen={() => onOpenDoc(selected.path)} /></li>
            {selected.standards.map((path) => <li key={path}><FileRow icon={<ShieldCheck size={14} />} name={fileTitle(path)} path={path} onOpen={() => onOpenDoc(path)} /></li>)}
            <li><FileRow icon={<RefreshCw size={14} />} name={t("docs.domains.instruction")} path={instructionPath} onOpen={() => onOpenInstruction(selected.domainId)} /></li>
          </ul>
        </Card>
        <Card header={<h3 className="vm-card-title">{t("docs.domains.history")} {runs.length > 0 && <span className="vm-card-title__count">{t("docs.domains.recentCount", { count: recent.length })}</span>}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onOpenIssues(selected.domainId)}>{t("docs.domains.relatedIssues")}</Button></h3>}>
          {runs.length ? <>
            <div className="vm-patrol-strip" aria-label={t("docs.domains.recentResults")}>
              {[...recent].reverse().map((patrol) => <i key={patrol.patrolRunId} data-tone={patrolTone(patrol)} title={`${patrolTime(patrol.startedAt)} · ${serviceText(patrol.summary) ?? ""}`} />)}
            </div>
            <ul>{groupPatrolRuns(runs).map((entry) => entry.kind === "skipped"
              ? <li key={entry.runs[0]!.patrolRunId} className="vm-patrol-entry">
                <StatusIcon tone="neutral" icon={Ban} label={t("docs.domains.skipped")} />
                <span className="vm-patrol-entry__text">{skippedSummary(entry.runs)}</span>
                <span className="vm-patrol-entry__time">{patrolTime(entry.runs[0]!.startedAt)}</span>
              </li>
              : <PatrolRow key={entry.run.patrolRunId} run={entry.run} onOpenSession={onOpenSession} onOpenIssues={() => onOpenIssues(selected.domainId)} />)}</ul>
          </> : <p className="text-caption text-muted-foreground">{t("docs.domains.noHistory")}</p>}
        </Card>
      </div>
    </div>
    {target && <Modal title={t("docs.domains.deleteTitle", { title: target.title })} onClose={() => setRemoving(undefined)} width={460}>
      <div className="space-y-3 p-4">
        <p className="text-caption text-muted-foreground">{t("docs.domains.deleteBody")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(undefined)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void removeDomain(target.domainId)}>{t("docs.domains.delete")}</Button>
        </div>
      </div>
    </Modal>}
    {config && pickingPaths && <DirectoryPickerDialog client={client} workspaceId={workspaceId} selected={config.triggerPaths}
      onSave={(triggerPaths) => { setPickingPaths(false); void updateConfig({ triggerPaths }); }} onClose={() => setPickingPaths(false)} />}
    {config && editingAuthorization && <AuthorizationDialog selected={config.authorizationScope}
      onSave={(authorizationScope) => { setEditingAuthorization(false); void updateConfig({ authorizationScope }); }} onClose={() => setEditingAuthorization(false)} />}
  </div>;
};

const FileRow = ({ icon, name, path, onOpen }: { icon: ReactNode; name: string; path: string; onOpen: () => void }) => (
  <button type="button" className="vm-domain-file" onClick={onOpen}>
    <span className="vm-domain-file__icon" aria-hidden="true">{icon}</span>
    <span className="vm-domain-file__name">{name}</span>
    <span className="vm-domain-file__path">{path.replace(/^\.vermillion\/(docs\/)?/, "")}</span>
  </button>
);

const patrolIcon = (tone: PatrolTone): { tone: StatusTone; label: string } =>
  tone === "clean" ? { tone: "done", label: t("docs.domains.result.clean") }
    : tone === "issue" ? { tone: "attention", label: t("docs.domains.result.issue") }
      : tone === "failed" ? { tone: "failed", label: t("docs.domains.result.failed") }
        : { tone: "running", label: t("docs.domains.state.running") };

const PatrolRow = ({ run, onOpenSession, onOpenIssues }: { run: PatrolRun; onOpenSession: (sessionId: string) => void; onOpenIssues: () => void }) => {
  const t = useT();
  const tone = patrolTone(run);
  const icon = patrolIcon(tone);
  const title = serviceText(run.summary) || (run.status === "queued" ? t("docs.domains.state.queued") : tone === "issue" ? t("docs.domains.issuesFound", { count: run.issueIds.length }) : icon.label);
  const meta = [patrolTrigger(run.trigger), run.changedPaths.length ? t("docs.domains.filesChanged", { count: run.changedPaths.length }) : undefined].filter(Boolean).join(" · ");
  return <li className="vm-patrol-entry">
    <StatusIcon tone={icon.tone} label={icon.label} />
    <span className="vm-patrol-entry__text">{title}<small>{meta}</small></span>
    <span className="vm-patrol-entry__actions">
      {run.issueIds.length > 0 && <Button size="sm" variant="ghost" onClick={onOpenIssues}>{t("docs.domains.issueCount", { count: run.issueIds.length })}</Button>}
      {run.sessionId && <Button size="sm" variant="ghost" onClick={() => onOpenSession(run.sessionId!)}>{t("docs.domains.session")}</Button>}
    </span>
    <span className="vm-patrol-entry__time">{patrolTime(run.startedAt)}</span>
  </li>;
};

type DirectoryNode = { path: string; name: string; children: DirectoryNode[] };

const directoryTree = (paths: string[]): DirectoryNode => {
  const root: DirectoryNode = { path: "", name: "", children: [] };
  for (const path of paths) {
    let node = root;
    let accumulated = "";
    for (const part of path.split("/")) {
      accumulated = accumulated ? accumulated + "/" + part : part;
      let child = node.children.find((entry) => entry.name === part);
      if (!child) { child = { path: accumulated, name: part, children: [] }; node.children.push(child); }
      node = child;
    }
  }
  return root;
};

const findDirectory = (node: DirectoryNode, path: string): DirectoryNode | undefined =>
  node.path === path ? node : node.children.map((child) => findDirectory(child, path)).find(Boolean);

/** True when the directory itself, or one of its ancestors, is part of the selection. */
const isCovers = (selected: string[], path: string): boolean => selected.some((entry) => entry === path || path.startsWith(entry + "/"));

const withoutBranch = (selected: string[], path: string): string[] =>
  selected.filter((entry) => entry !== path && !entry.startsWith(path + "/"));

/** Minimal set of directories covering `node` minus the excluded branch. */
const remainderOf = (node: DirectoryNode, exclude: string): string[] => {
  if (node.path === exclude) return [];
  if (!exclude.startsWith(node.path + "/")) return [node.path];
  return node.children.flatMap((child) => remainderOf(child, exclude));
};

/** Picks the directories whose changes trigger a patrol; the tree comes from Git-tracked files. */
const DirectoryPickerDialog = ({ client, workspaceId, selected, onSave, onClose }: {
  client: WorkbenchClient; workspaceId: string; selected: string[]; onSave: (paths: string[]) => void; onClose: () => void;
}) => {
  const t = useT();
  const [paths, setPaths] = useState<string[]>();
  const [chosen, setChosen] = useState<string[]>(selected);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    client.request("workspace.directories", { workspaceId })
      .then((listed) => { if (active) setPaths(listed); })
      .catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [client, workspaceId]);
  const tree = useMemo(() => directoryTree(paths ?? []), [paths]);
  const toggle = (path: string, next: boolean) => {
    const ancestor = chosen.find((entry) => path.startsWith(entry + "/"));
    const branch = ancestor ? findDirectory(tree, ancestor) : undefined;
    setChosen(next
      ? [...withoutBranch(chosen, path), path]
      : [...withoutBranch(chosen, path).filter((entry) => entry !== ancestor), ...(branch ? remainderOf(branch, path) : [])]);
  };
  const rows = (node: DirectoryNode, depth: number): ReactNode[] => node.children.flatMap((child) => [
    <div key={child.path} style={{ paddingLeft: depth * 14 }}>
      <Checkbox label={child.name} checked={isCovers(chosen, child.path)}
        indeterminate={!isCovers(chosen, child.path) && chosen.some((entry) => entry.startsWith(child.path + "/"))}
        onChange={(next) => toggle(child.path, next)} />
    </div>,
    ...rows(child, depth + 1)
  ]);
  return <Modal title={t("docs.domains.triggerDirectories")} onClose={onClose} width={520}><div className="space-y-3 p-4">
    <p className="text-caption text-muted-foreground">{t("docs.domains.triggerDirectoriesBody")}</p>
    {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
    {paths ? <div className="max-h-[52vh] overflow-auto rounded-md border border-border bg-input p-2">{rows(tree, 0)}</div>
      : <p className="text-caption text-muted-foreground">{t("docs.domains.directoriesLoading")}</p>}
    <div className="flex items-center gap-2">
      <span className="text-caption text-muted-foreground">{t("docs.domains.directoriesSelected", { count: chosen.length })}</span>
      <Button variant="ghost" className="ml-auto" onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={!paths} onClick={() => onSave([...chosen].sort())}>{t("common.save")}</Button>
    </div>
  </div></Modal>;
};

const AuthorizationDialog = ({ selected, onSave, onClose }: { selected: string[]; onSave: (scope: string[]) => void; onClose: () => void }) => {
  const t = useT();
  const [value, setValue] = useState(selected.join("\n"));
  return <Modal title={t("docs.domains.authorization")} onClose={onClose} width={560}><div className="space-y-3 p-4">
    <Field kind="textarea" label={t("docs.domains.authorizationField")} rows={6} hint={t("docs.domains.authorizationHint")} value={value} onChange={(event) => setValue(event.target.value)} />
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={() => onSave(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))}>{t("common.save")}</Button>
    </div>
  </div></Modal>;
};
