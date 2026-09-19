import { ArrowUpRight, FileText, ListTodo, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
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

/** Keystrokes settle before a scan starts; composed input waits for the IME to commit. */
const QUERY_DEBOUNCE_MS = 150;

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
        meta={`${hit.workspaceLabel} · 第 ${hit.line} 行`}
        trailing={<><Badge>{kindLabel[hit.kind]}</Badge><ArrowUpRight size={13} className="text-muted-foreground" aria-label="打开" /></>}
        selected={selected}
        onClick={onOpen}
      />
    </li>
  );
};

export const SearchDialog = ({ client, onClose, onOpenWorkItem, onOpenDoc, onOpenSession }: SearchDialogProps) => {
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [queryId, setQueryId] = useState<string>();
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [stats, setStats] = useState<SearchResult["stats"]>();
  const [scanning, setScanning] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [expandedKinds, setExpandedKinds] = useState<Set<SearchHit["kind"]>>(() => new Set());
  const [error, setError] = useState<string>();

  const trimmed = query.trim();

  // Each keyword starts one scan. Dropping the previous queryId stops its scan, so a slow query is
  // never in front of the current one.
  useEffect(() => {
    setHits([]);
    setStats(undefined);
    setSelectedId(undefined);
    setExpandedKinds(new Set());
    setError(undefined);
    setQueryId(undefined);
    if (!trimmed || composing) {
      setScanning(false);
      return;
    }
    setScanning(true);
    let dropped = false;
    const timer = window.setTimeout(() => {
      void client.request("search.start", { query: trimmed, contextLines: 3, maxResults: 200 })
        .then((started) => {
          if (dropped) {
            void client.request("search.cancel", { queryId: started.queryId });
            return;
          }
          setQueryId(started.queryId);
        })
        .catch((caught: unknown) => {
          if (dropped) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          setScanning(false);
        });
    }, QUERY_DEBOUNCE_MS);
    return () => {
      dropped = true;
      window.clearTimeout(timer);
    };
  }, [client, trimmed, composing]);

  // Stops the scan behind a superseded keyword and when the dialog closes.
  useEffect(() => {
    if (!queryId) return;
    return () => { void client.request("search.cancel", { queryId }); };
  }, [client, queryId]);

  useEffect(() => client.subscribe((event) => {
    if (event.type === "search.hits") {
      if (event.queryId !== queryId) return;
      setHits((current) => [...current, ...event.hits]);
      setSelectedId((current) => current ?? event.hits[0]?.id);
    } else if (event.type === "search.completed") {
      if (event.queryId !== queryId) return;
      setStats(event.stats);
      setScanning(false);
      if (event.error) setError(event.error);
    }
  }), [client, queryId]);

  const selected = useMemo(
    () => hits.find((hit) => hit.id === selectedId) ?? hits[0],
    [hits, selectedId]
  );
  const groups = useMemo(() => {
    const grouped = new Map<SearchHit["kind"], SearchHit[]>();
    for (const hit of hits) grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);
    return (["workItem", "session", "doc"] as const).flatMap((kind) => {
      const items = grouped.get(kind);
      return items?.length ? [{ kind, hits: items }] : [];
    });
  }, [hits]);

  return (
    <Modal title="搜索" onClose={onClose} width={980} height="74vh" contentClassName="overflow-hidden">
      <div className="flex h-full min-h-[480px] min-w-0 flex-col">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <Field
            aria-label="搜索工单、会话和文档"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setQuery(event.currentTarget.value);
              setComposing(false);
            }}
            placeholder="搜索工单、会话和文档"
            autoFocus
          />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.15fr)]">
          <div className="vm-scrollbar-hidden min-h-0 overflow-y-auto border-b border-border md:border-b-0 md:border-r">
            {error && <InlineNotice tone="error" className="pt-3">{error}</InlineNotice>}
            {!trimmed && <EmptyState title="输入关键词开始搜索" />}
            {scanning && hits.length === 0 && <InlineNotice className="pt-3">搜索中…</InlineNotice>}
            {!scanning && trimmed && stats && hits.length === 0 && <EmptyState title="没有找到匹配内容" hint="换一个关键词试试。" />}
            {groups.map(({ kind, hits: kindHits }) => (
              <section key={kind}>
                <SectionLabel>{kindLabel[kind]} <span className="font-mono text-faint-foreground">{kindHits.length}</span></SectionLabel>
                <ul>{(expandedKinds.has(kind) ? kindHits : kindHits.slice(0, 10)).map((hit) => <SearchResultRow
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
                {kindHits.length > 10 && !expandedKinds.has(kind) && (
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
          {stats
            ? `扫描 ${stats.sourcesScanned} 项 · ${formatBytes(stats.bytesScanned)} · ${stats.durationMs} ms${stats.truncated ? " · 结果已截断" : ""}`
            : scanning
              ? `搜索中… 已找到 ${hits.length} 条`
              : "搜索结果将在这里显示。"}
        </footer>
      </div>
    </Modal>
  );
};
