import { ArrowUpRight, FileText, ListTodo, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SearchHit, SearchResult, WorkbenchClient } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Badge, Button, EmptyState, Field, InlineNotice, ListRow, SectionLabel } from "./ui.js";

type SearchDialogProps = {
  client: WorkbenchClient;
  onClose: () => void;
  onOpenWorkItem: (hit: SearchHit) => void;
  onOpenDoc: (hit: SearchHit) => void;
  onOpenSession: (hit: SearchHit) => void;
};

const kindLabel: Record<SearchHit["kind"], string> = {
  workItem: "工单",
  session: "会话",
  doc: "文档"
};

const kindIcon: Record<SearchHit["kind"], typeof FileText> = {
  workItem: ListTodo,
  session: MessageSquare,
  doc: FileText
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (102.4 * 102.4)) / 10} MB`;
};

const resultMeta = (hit: SearchHit): string =>
  [kindLabel[hit.kind], hit.workspaceLabel, `第 ${hit.line} 行 · 第 ${hit.column} 列`]
    .filter(Boolean)
    .join(" · ");

const contextLineText = (line: SearchHit["context"][number]) => {
  if (line.matches.length === 0) return line.text;
  const parts: ReactElement[] = [];
  let cursor = 0;
  line.matches.forEach((match, index) => {
    const start = Math.max(cursor, Math.min(line.text.length, match.start));
    const end = Math.max(start, Math.min(line.text.length, match.end));
    if (start > cursor) parts.push(<span key={`text-${index}`}>{line.text.slice(cursor, start)}</span>);
    if (end > start) parts.push(<mark key={`match-${index}`} className="rounded-sm bg-surface-selected px-0.5 text-strong">{line.text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < line.text.length) parts.push(<span key="text-tail">{line.text.slice(cursor)}</span>);
  return parts;
};

const SearchPreview = ({ hit }: { hit: SearchHit | undefined }) => {
  if (!hit) return <EmptyState title="选择一个命中位置" hint="右侧显示该位置附近的原文上下文。" />;
  return (
    <section aria-label="命中位置预览" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <p className="truncate text-label font-medium text-strong" title={hit.title}>{hit.title}</p>
        <p className="mt-1 truncate font-mono text-caption text-muted-foreground" title={hit.path}>{hit.path ?? resultMeta(hit)}</p>
      </header>
      <pre className="vm-scrollbar-hidden min-h-0 flex-1 overflow-y-auto bg-input px-4 py-3 font-mono text-caption leading-relaxed text-foreground">
        {hit.context.map((line) => (
          <div key={line.line} className="flex gap-3">
            <span className="w-10 shrink-0 select-none text-right text-faint-foreground">{line.line}</span>
            <code className="min-w-0 whitespace-pre-wrap break-words">{contextLineText(line)}</code>
          </div>
        ))}
      </pre>
    </section>
  );
};

const SearchResultRow = ({ hit, selected, onSelect, onOpen }: { hit: SearchHit; selected: boolean; onSelect: () => void; onOpen: () => void }) => {
  const Icon = kindIcon[hit.kind];
  return (
    <li onMouseEnter={onSelect} onFocusCapture={onSelect} onMouseDown={(event) => event.stopPropagation()}>
      <ListRow
        leading={<Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={<span title={hit.title}>{hit.title}</span>}
        meta={hit.kind === "session" ? `${hit.workspaceLabel} · 第 ${hit.line} 行` : `${hit.workspaceLabel} · 第 ${hit.line} 行`}
        trailing={<><Badge>{kindLabel[hit.kind]}</Badge><ArrowUpRight size={13} className="text-muted-foreground" aria-label="打开" /></>}
        selected={selected}
        onClick={onOpen}
      />
    </li>
  );
};

export const SearchDialog = ({ client, onClose, onOpenWorkItem, onOpenDoc, onOpenSession }: SearchDialogProps) => {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>();
  const [selectedId, setSelectedId] = useState<string>();
  const [expandedKinds, setExpandedKinds] = useState<Set<SearchHit["kind"]>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const latestQuery = useRef("");
  const queuedQuery = useRef("");
  const changedAt = useRef(0);
  const running = useRef(false);
  const mounted = useRef(true);

  const runSearch = useCallback(async () => {
    if (running.current || !queuedQuery.current) return;
    running.current = true;
    try {
      while (queuedQuery.current) {
        const waitFor = Math.max(0, 180 - (Date.now() - changedAt.current));
        if (waitFor > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, waitFor));
        const value = queuedQuery.current;
        queuedQuery.current = "";
        if (!value) break;
        try {
          const next = await client.request("search.query", { query: value, contextLines: 3, maxResults: 200 });
          if (mounted.current && latestQuery.current === value) {
            setResult(next);
            setSelectedId(next.hits[0]?.id);
            setLoading(false);
          }
        } catch (caught: unknown) {
          if (mounted.current && latestQuery.current === value) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setLoading(false);
          }
        }
      }
    } finally {
      running.current = false;
      if (queuedQuery.current) void runSearch();
    }
  }, [client]);

  useEffect(() => {
    const value = query.trim();
    latestQuery.current = value;
    queuedQuery.current = value;
    changedAt.current = Date.now();
    setResult(undefined);
    setSelectedId(undefined);
    setExpandedKinds(new Set());
    setError(undefined);
    if (!value) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void runSearch();
  }, [query, runSearch]);

  useEffect(() => () => {
    mounted.current = false;
    queuedQuery.current = "";
  }, []);

  const selected = useMemo(
    () => result?.hits.find((hit) => hit.id === selectedId) ?? result?.hits[0],
    [result, selectedId]
  );
  const groups = useMemo(() => {
    const grouped = new Map<SearchHit["kind"], SearchHit[]>();
    for (const hit of result?.hits ?? []) grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);
    return (["workItem", "session", "doc"] as const).flatMap((kind) => {
      const hits = grouped.get(kind);
      return hits?.length ? [{ kind, hits }] : [];
    });
  }, [result]);

  return (
    <Modal title="搜索" onClose={onClose} width={980} height="74vh" contentClassName="overflow-hidden">
      <div className="flex h-full min-h-[480px] min-w-0 flex-col">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <Field
            aria-label="搜索工单、会话和文档"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工单、会话和文档"
            autoFocus
          />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.15fr)]">
          <div className="vm-scrollbar-hidden min-h-0 overflow-y-auto border-b border-border md:border-b-0 md:border-r">
            {error && <InlineNotice tone="error" className="pt-3">{error}</InlineNotice>}
            {!query.trim() && <EmptyState title="输入关键词开始搜索" />}
            {loading && <InlineNotice className="pt-3">搜索中…</InlineNotice>}
            {!loading && query.trim() && result && result.hits.length === 0 && <EmptyState title="没有找到匹配内容" hint="换一个关键词试试。" />}
            {groups.map(({ kind, hits }) => (
              <section key={kind}>
                <SectionLabel>{kindLabel[kind]} <span className="font-mono text-faint-foreground">{hits.length}</span></SectionLabel>
                <ul>{(expandedKinds.has(kind) ? hits : hits.slice(0, 10)).map((hit) => <SearchResultRow
                  key={hit.id}
                  hit={hit}
                  selected={hit.id === selected?.id}
                  onSelect={() => setSelectedId(hit.id)}
                  onOpen={() => {
                    if (hit.kind === "workItem") onOpenWorkItem(hit);
                    else if (hit.kind === "doc") onOpenDoc(hit);
                    else onOpenSession(hit);
                  }}
                />)}</ul>
                {hits.length > 10 && !expandedKinds.has(kind) && (
                  <div className="px-3 pb-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => setExpandedKinds((current) => new Set(current).add(kind))}
                    >
                      展开更多
                    </Button>
                  </div>
                )}
              </section>
            ))}
          </div>
          <SearchPreview hit={selected} />
        </div>
        <footer className="shrink-0 border-t border-border px-4 py-2 text-caption text-muted-foreground">
          {result ? `扫描 ${result.stats.sourcesScanned} 项 · ${formatBytes(result.stats.bytesScanned)} · ${result.stats.durationMs} ms${result.stats.truncated ? " · 结果已截断" : ""}` : "搜索结果将在这里显示。"}
        </footer>
      </div>
    </Modal>
  );
};
