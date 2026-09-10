import { FileText, ListTodo, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SearchHit, SearchResult, WorkbenchClient } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Badge, EmptyState, Field, InlineNotice, ListRow, SectionLabel } from "./ui.js";

type SearchDialogProps = {
  client: WorkbenchClient;
  onClose: () => void;
};

const kindLabel: Record<SearchHit["kind"], string> = {
  workItem: "工单",
  session: "会话"
};

const kindIcon: Record<SearchHit["kind"], typeof FileText> = {
  workItem: ListTodo,
  session: MessageSquare
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
      <pre className="min-h-0 flex-1 overflow-auto bg-input px-4 py-3 font-mono text-caption leading-relaxed text-foreground">
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

const SearchResultRow = ({ hit, selected, onSelect }: { hit: SearchHit; selected: boolean; onSelect: () => void }) => {
  const Icon = kindIcon[hit.kind];
  return (
    <li onMouseEnter={onSelect} onFocusCapture={onSelect}>
      <ListRow
        leading={<Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={<span title={hit.title}>{hit.title}</span>}
        meta={hit.kind === "session" ? `${hit.workspaceLabel} · 第 ${hit.line} 行` : `第 ${hit.line} 行 · ${hit.workspaceLabel}`}
        trailing={<Badge>{kindLabel[hit.kind]}</Badge>}
        selected={selected}
        onClick={onSelect}
      />
    </li>
  );
};

export const SearchDialog = ({ client, onClose }: SearchDialogProps) => {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>();
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);

  useEffect(() => {
    const value = query.trim();
    const requestGeneration = ++generation.current;
    setResult(undefined);
    setSelectedId(undefined);
    setError(undefined);
    if (!value) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void client.request("search.query", { query: value, contextLines: 3, maxResults: 200 })
        .then((next) => {
          if (requestGeneration !== generation.current) return;
          setResult(next);
          setSelectedId(next.hits[0]?.id);
          setLoading(false);
        })
        .catch((caught: unknown) => {
          if (requestGeneration !== generation.current) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [client, query]);

  const selected = useMemo(
    () => result?.hits.find((hit) => hit.id === selectedId) ?? result?.hits[0],
    [result, selectedId]
  );
  const groups = useMemo(() => {
    const grouped = new Map<SearchHit["kind"], SearchHit[]>();
    for (const hit of result?.hits ?? []) grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);
    return (["workItem", "session"] as const).flatMap((kind) => {
      const hits = grouped.get(kind);
      return hits?.length ? [{ kind, hits }] : [];
    });
  }, [result]);

  return (
    <Modal title="搜索" onClose={onClose} width={980} height="74vh">
      <div className="flex min-h-[480px] min-w-0 flex-col">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <Field
            aria-label="搜索工单和会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工单和 Vermillion 会话"
            autoFocus
          />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.15fr)]">
          <div className="min-h-0 overflow-auto border-b border-border md:border-b-0 md:border-r">
            {error && <InlineNotice tone="error" className="pt-3">{error}</InlineNotice>}
            {!query.trim() && <EmptyState title="输入关键词开始搜索" />}
            {loading && <InlineNotice className="pt-3">搜索中…</InlineNotice>}
            {!loading && query.trim() && result && result.hits.length === 0 && <EmptyState title="没有找到匹配内容" hint="换一个关键词试试。" />}
            {groups.map(({ kind, hits }) => (
              <section key={kind}>
                <SectionLabel>{kindLabel[kind]} <span className="font-mono text-faint-foreground">{hits.length}</span></SectionLabel>
                <ul>{hits.map((hit) => <SearchResultRow key={hit.id} hit={hit} selected={hit.id === selected?.id} onSelect={() => setSelectedId(hit.id)} />)}</ul>
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
