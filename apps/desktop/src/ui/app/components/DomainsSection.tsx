import { Ban, FileText, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DomainConfig, DomainDefinition, Issue, PatrolRun, WorkbenchClient } from "@vermillion/workbench/client";
import { Button, Card, Checkbox, EmptyState, Field, IconButton, InlineNotice, ListRow, MarkdownPreview, OverflowMenu, PanelHeader, Select, SettingRow, StatusIcon, StatusPill, Toggle, type StatusTone } from "./ui.js";
import { Modal } from "./Modal.js";

const DOMAINS_DIR = ".vermillion/docs/domains/";
const DOCS_DIR = ".vermillion/docs/";
/** Number of recent patrols summarized in the result strip. */
const PATROL_STRIP_SIZE = 14;

const DOMAIN_TEMPLATE = `---
standards:
  - .vermillion/docs/<业务>/Standards.md
---
# <领域名>

## 覆盖什么

## 什么样的改动应该考虑它
`;

const patrolTrigger: Record<PatrolRun["trigger"], string> = { manual: "手动", change: "目录变更", scheduled: "定时" };
const onOff = (value: boolean): string => value ? "已开启" : "当前关闭";
const fileTitle = (path: string): string => path.split("/").at(-1)?.replace(/\.md$/i, "") || path;

const formatDay = (value: string): string => {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const clockTime = (value: string): string => {
  const date = new Date(value);
  return `${formatDay(value)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** Relative time for fresh records, month/day with time for older ones. */
export const patrolTime = (value: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
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
  if (runs.length === 1) return runs[0]!.summary || "无新变更，已跳过";
  const oldest = formatDay(runs.at(-1)!.startedAt);
  const newest = formatDay(runs[0]!.startedAt);
  return `${oldest === newest ? oldest : `${oldest} 至 ${newest}`} 连续 ${runs.length} 次无新变更，已跳过`;
};

/** Header state of the domain's patrol: a running patrol wins over the configured schedule. */
const patrolState = (config: DomainConfig | undefined, runs: PatrolRun[]): { tone: StatusTone; label: string } => {
  const active = runs.find((run) => run.status === "running" || run.status === "queued");
  if (active) return { tone: "running", label: active.status === "running" ? "巡检中" : "等待巡检" };
  if (!config?.enabled) return { tone: "neutral", label: "自动巡检未启用" };
  if (config.retryAt) return { tone: "failed", label: "上次巡检失败" };
  return { tone: "done", label: "自动巡检已启用" };
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
      await client.request("docs.write", { workspaceId, path, content: DOMAIN_TEMPLATE });
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
    <PanelHeader title="领域"><IconButton icon={Plus} label="新建领域" onClick={() => setCreating((value) => !value)} /></PanelHeader>
    {creating && <form className="flex items-center gap-1 px-4 pb-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <Field value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="领域 id" className="w-28" /><Button type="submit" size="sm" disabled={!draft.trim()}>创建</Button>
    </form>}
    <ul className="min-h-0 flex-1 overflow-auto">{domains.map((domain) => <li key={domain.domainId}>
      <ListRow title={<span className="vm-domain-item__title">{domain.title}{decisionDomains.has(domain.domainId) && <span className="vm-domain-item__mark" aria-label="有待决策的 Issue" />}</span>}
        meta={`${domain.domainId} · ${domain.standards.length} 个规范`} selected={domain.domainId === selected?.domainId}
        onClick={() => setSelectedId(domain.domainId)}
        hoverActions={<IconButton icon={X} size={12} label={"删除领域：" + domain.title} onClick={() => setRemoving(domain.domainId)} />} />
    </li>)}</ul>
  </div>;
  if (!selected) return <div className="flex min-h-0 flex-1">
    {listed}
    <EmptyState title="还没有领域定义" action={<Button onClick={() => setCreating(true)}>新建领域</Button>} />
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
          <Button size="sm" onClick={() => void run()}><RefreshCw size={14} aria-hidden="true" />立即巡检</Button>
          <OverflowMenu label={"更多操作：" + selected.title} items={[{ label: "删除领域", onSelect: () => setRemoving(selected.domainId) }]} />
        </header>
        {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
        <div className="vm-domain-grid">
          <Card header={<h3 className="vm-card-title">领域定义</h3>}>
            {definition === undefined ? <p className="text-caption text-muted-foreground">正在读取领域定义…</p>
              : <div className="vm-domain-definition"><MarkdownPreview content={definitionBody(definition)} documentUrl={documentUrl} onOpenLink={(href) => {
                const path = resolveDocLink(selected.path, href);
                if (path) onOpenDoc(path);
                return Boolean(path);
              }} /></div>}
          </Card>
          {config && <Card header={<h3 className="vm-card-title">巡检</h3>}>
            <SettingRow label="自动巡检" state={config.enabled ? `已开启 · 下次检查 ${clockTime(config.nextRunAt)}` : "当前关闭"}
              control={<Toggle labelHidden label="自动巡检" checked={config.enabled} onChange={(enabled) => void updateConfig({ enabled })} />} />
            <SettingRow label="目录变更后巡检" state={`${onOff(config.changeTrigger)} · ${config.triggerPaths.length} 个触发目录`}
              actions={<Button size="sm" variant="ghost" onClick={() => setPickingPaths(true)}>选择目录</Button>}
              control={<Toggle labelHidden label="目录变更后巡检" checked={config.changeTrigger} onChange={(changeTrigger) => void updateConfig({ changeTrigger })} />} />
            <SettingRow label="定时巡检" state={config.retryAt ? `上次失败，${clockTime(config.retryAt)} 重试` : undefined}
              control={<Select compact aria-label="定时巡检间隔" className="w-28" value={String(config.intervalHours)} onChange={(value) => void updateConfig({ intervalHours: Number(value) })}
                options={[3, 6, 12, 24, 48, 168].map((hours) => ({ value: String(hours), label: `每 ${hours} 小时` }))} />} />
            <SettingRow label="允许自动开单" state={`${onOff(config.autoWorkEnabled)} · 授权范围 ${config.authorizationScope.length} 项`}
              actions={<Button size="sm" variant="ghost" onClick={() => setEditingAuthorization(true)}>编辑范围</Button>}
              control={<Toggle labelHidden label="允许自动开单" checked={config.autoWorkEnabled} onChange={(autoWorkEnabled) => void updateConfig({ autoWorkEnabled })} />} />
          </Card>}
        </div>
        <Card header={<h3 className="vm-card-title">规范与指令 <span className="vm-card-title__count">{selected.standards.length + 2}</span></h3>}>
          <ul>
            <li><FileRow icon={<FileText size={14} />} name="领域定义" path={selected.path} onOpen={() => onOpenDoc(selected.path)} /></li>
            {selected.standards.map((path) => <li key={path}><FileRow icon={<ShieldCheck size={14} />} name={fileTitle(path)} path={path} onOpen={() => onOpenDoc(path)} /></li>)}
            <li><FileRow icon={<RefreshCw size={14} />} name="巡检指令" path={instructionPath} onOpen={() => onOpenInstruction(selected.domainId)} /></li>
          </ul>
        </Card>
        <Card header={<h3 className="vm-card-title">巡检记录 {runs.length > 0 && <span className="vm-card-title__count">最近 {recent.length} 次</span>}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onOpenIssues(selected.domainId)}>相关 Issues</Button></h3>}>
          {runs.length ? <>
            <div className="vm-patrol-strip" aria-label="最近巡检结果">
              {[...recent].reverse().map((patrol) => <i key={patrol.patrolRunId} data-tone={patrolTone(patrol)} title={`${patrolTime(patrol.startedAt)} · ${patrol.summary ?? ""}`} />)}
            </div>
            <ul>{groupPatrolRuns(runs).map((entry) => entry.kind === "skipped"
              ? <li key={entry.runs[0]!.patrolRunId} className="vm-patrol-entry">
                <StatusIcon tone="neutral" icon={Ban} label="已跳过" />
                <span className="vm-patrol-entry__text">{skippedSummary(entry.runs)}</span>
                <span className="vm-patrol-entry__time">{patrolTime(entry.runs[0]!.startedAt)}</span>
              </li>
              : <PatrolRow key={entry.run.patrolRunId} run={entry.run} onOpenSession={onOpenSession} onOpenIssues={() => onOpenIssues(selected.domainId)} />)}</ul>
          </> : <p className="text-caption text-muted-foreground">暂无巡检记录。</p>}
        </Card>
      </div>
    </div>
    {target && <Modal title={"删除 " + target.title} onClose={() => setRemoving(undefined)} width={460}>
      <div className="space-y-3 p-4">
        <p className="text-caption text-muted-foreground">删除后移除领域定义、巡检指令和巡检配置；该领域已有的 Issue 与巡检记录保留。领域定义的删除作为文档变更，随文档提交。</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(undefined)}>取消</Button>
          <Button variant="primary" onClick={() => void removeDomain(target.domainId)}>删除领域</Button>
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

const patrolIcons: Record<PatrolTone, { tone: StatusTone; label: string }> = {
  clean: { tone: "done", label: "无问题" }, issue: { tone: "attention", label: "发现问题" },
  failed: { tone: "failed", label: "失败" }, running: { tone: "running", label: "巡检中" }
};

const PatrolRow = ({ run, onOpenSession, onOpenIssues }: { run: PatrolRun; onOpenSession: (sessionId: string) => void; onOpenIssues: () => void }) => {
  const tone = patrolTone(run);
  const title = run.summary || (run.status === "queued" ? "等待巡检" : tone === "issue" ? `发现 ${run.issueIds.length} 个问题` : patrolIcons[tone].label);
  const meta = [patrolTrigger[run.trigger], run.changedPaths.length ? `${run.changedPaths.length} 个文件变更` : undefined].filter(Boolean).join(" · ");
  return <li className="vm-patrol-entry">
    <StatusIcon tone={patrolIcons[tone].tone} label={patrolIcons[tone].label} />
    <span className="vm-patrol-entry__text">{title}<small>{meta}</small></span>
    <span className="vm-patrol-entry__actions">
      {run.issueIds.length > 0 && <Button size="sm" variant="ghost" onClick={onOpenIssues}>{run.issueIds.length} 个 Issue</Button>}
      {run.sessionId && <Button size="sm" variant="ghost" onClick={() => onOpenSession(run.sessionId!)}>会话</Button>}
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
  return <Modal title="触发目录" onClose={onClose} width={520}><div className="space-y-3 p-4">
    <p className="text-caption text-muted-foreground">这些目录下的变更会触发巡检。勾选父目录即覆盖其全部子目录。</p>
    {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
    {paths ? <div className="max-h-[52vh] overflow-auto rounded-md border border-border bg-input p-2">{rows(tree, 0)}</div>
      : <p className="text-caption text-muted-foreground">正在读取目录…</p>}
    <div className="flex items-center gap-2">
      <span className="text-caption text-muted-foreground">已选 {chosen.length} 个目录</span>
      <Button variant="ghost" className="ml-auto" onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={!paths} onClick={() => onSave([...chosen].sort())}>保存</Button>
    </div>
  </div></Modal>;
};

const AuthorizationDialog = ({ selected, onSave, onClose }: { selected: string[]; onSave: (scope: string[]) => void; onClose: () => void }) => {
  const [value, setValue] = useState(selected.join("\n"));
  return <Modal title="自动修复授权范围" onClose={onClose} width={560}><div className="space-y-3 p-4">
    <Field kind="textarea" label="每行一项" rows={6} hint="只填写允许自动恢复的既定要求偏差；需求取舍仍进入待决策。" value={value} onChange={(event) => setValue(event.target.value)} />
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>取消</Button>
      <Button variant="primary" onClick={() => onSave(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))}>保存</Button>
    </div>
  </div></Modal>;
};
