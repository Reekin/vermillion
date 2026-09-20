import { ArrowUpRight, ChevronDown, ChevronRight, FileText, ListTodo, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SearchHit, SearchResult, WorkbenchClient } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ListRow, SectionLabel } from "./ui.js";

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
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return String(Math.round(bytes / 102.4) / 10) + " KB";
  return String(Math.round(bytes / (1024 * 102.4)) / 10) + " MB";
};

const resultMeta = (hit: SearchHit): string =>
  [kindLabel[hit.kind], hit.workspaceLabel, "第 " + hit.line + " 行 · 第 " + hit.column + " 列"]
    .filter(Boolean)
    .join(" · ");

const contextLineText = (line: SearchHit["context"][number]) => {
  if (line.matches.length === 0) return line.text;
  const parts: ReactElement[] = [];
  let cursor = 0;
  line.matches.forEach((match, index) => {
    const start = Math.max(cursor, Math.min(line.text.length, match.start));
    const end = Math.max(start, Math.min(line.text.length, match.end));
    if (start > cursor) parts.push(<span key={"text-" + index}>{line.text.slice(cursor, start)}</span>);
    if (end > start) {
      parts.push(
        <mark key={"match-" + index} className="vm-search-match px-0.5 font-medium">
          {line.text.slice(start, end)}
        </mark>
      );
    }
    cursor = end;
  });
  if (cursor < line.text.length) parts.push(<span key="text-tail">{line.text.slice(cursor)}</span>);
  return parts;
};

const matchingLine = (hit: SearchHit): SearchHit["context"][number] | undefined =>
  hit.context.find((line) => line.line === hit.line) ??
  hit.context.find((line) => line.matches.length > 0) ??
  hit.context[0];

const RESULT_SNIPPET_CHARS = 96;
const RESULT_SNIPPET_PREFIX_CHARS = 20;

const snippetLine = (line: SearchHit["context"][number]): SearchHit["context"][number] => {
  if (line.matches.length === 0) return line;
  const focus = line.matches[0]!.start;
  const desiredStart = Math.max(0, focus - RESULT_SNIPPET_PREFIX_CHARS);
  const start = desiredStart;
  const end = start + RESULT_SNIPPET_CHARS;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.text.length ? "…" : "";
  return {
    line: line.line,
    text: prefix + line.text.slice(start, end) + suffix,
    matches: line.matches
      .filter((match) => match.end > start && match.start < end)
      .map((match) => ({
        start: prefix.length + Math.max(0, match.start - start),
        end: prefix.length + Math.min(RESULT_SNIPPET_CHARS, match.end - start)
      }))
  };
};

const SearchPreview = ({ hit }: { hit: SearchHit | undefined }) => {
  const hitLineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    hitLineRef.current?.scrollIntoView({ block: "center" });
  }, [hit?.id]);
  if (!hit) return <EmptyState title="选择一个命中位置" hint="右侧显示该位置附近的原文上下文。" />;
  return (
    <section aria-label="命中位置预览" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <p className="truncate text-label font-medium text-strong" title={hit.treeTitle ?? hit.title}>
          {hit.treeTitle ?? hit.title}
        </p>
        <p className="mt-1 truncate font-mono text-caption text-muted-foreground" title={hit.path}>
          {hit.path ?? resultMeta(hit)}
        </p>
      </header>
      <pre className="vm-scrollbar-hidden min-h-0 flex-1 overflow-y-auto bg-input px-4 py-3 font-mono text-caption leading-relaxed text-foreground">
        {hit.context.map((line) => (
          <div key={line.line} ref={line.line === hit.line ? hitLineRef : undefined} className="flex gap-3">
            <span className="w-10 shrink-0 select-none text-right text-faint-foreground">{line.line}</span>
            <code className="min-w-0 whitespace-pre-wrap break-words">{contextLineText(line)}</code>
          </div>
        ))}
      </pre>
    </section>
  );
};

const SearchResultRow = ({
  hit,
  selected,
  onSelect,
  onOpen
}: {
  hit: SearchHit;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) => {
  const Icon = kindIcon[hit.kind];
  const line = matchingLine(hit);
  const shortLine = line ? snippetLine(line) : undefined;
  return (
    <li
      onDoubleClick={onOpen}
      onFocusCapture={onSelect}
      onMouseDown={(event) => event.stopPropagation()}
      title="单击预览，双击打开"
    >
      <ListRow
        leading={<Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={
          <span className="font-mono">
            {shortLine ? contextLineText(shortLine) : hit.title}
          </span>
        }
        titleClassName="vm-search-result-title"
        meta={hit.workspaceLabel + " · 第 " + hit.line + " 行"}
        trailing={<Badge>{kindLabel[hit.kind]}</Badge>}
        hoverActions={<IconButton icon={ArrowUpRight} label="打开" size={13} onClick={onOpen} />}
        selected={selected}
        onClick={onSelect}
      />
    </li>
  );
};

type SessionTreeGroup = {
  treeId: string;
  title: string;
  activityAt: string;
  hits: SearchHit[];
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
  const [collapsedTrees, setCollapsedTrees] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();

  const trimmed = query.trim();

  useEffect(() => {
    setHits([]);
    setStats(undefined);
    setSelectedId(undefined);
    setExpandedKinds(new Set());
    setCollapsedTrees(new Set());
    setError(undefined);
    setQueryId(undefined);
    if (!trimmed || composing) {
      setScanning(false);
      return;
    }
    setScanning(true);
    let dropped = false;
    const timer = window.setTimeout(() => {
      void client.request("search.start", { query: trimmed, contextLines: 8 })
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
  const flatGroups = useMemo(() => {
    const grouped = new Map<SearchHit["kind"], SearchHit[]>();
    for (const hit of hits) {
      if (hit.kind === "session") continue;
      grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);
    }
    return (["workItem", "doc"] as const).flatMap((kind) => {
      const items = grouped.get(kind);
      return items?.length ? [{ kind, hits: items }] : [];
    });
  }, [hits]);
  const sessionTrees = useMemo<SessionTreeGroup[]>(() => {
    const grouped = new Map<string, SessionTreeGroup>();
    for (const hit of hits) {
      if (hit.kind !== "session") continue;
      const treeId = hit.treeId ?? hit.sessionId ?? hit.id;
      const existing = grouped.get(treeId);
      if (existing) {
        existing.hits.push(hit);
        continue;
      }
      grouped.set(treeId, {
        treeId,
        title: hit.treeTitle ?? hit.title,
        activityAt: hit.treeActivityAt ?? hit.sessionActivityAt ?? "",
        hits: [hit]
      });
    }
    return [...grouped.values()]
      .map((tree) => ({
        ...tree,
        hits: [...tree.hits].sort((left, right) =>
          (right.sessionActivityAt ?? "").localeCompare(left.sessionActivityAt ?? "") ||
          left.line - right.line ||
          left.id.localeCompare(right.id)
        )
      }))
      .sort((left, right) =>
        right.activityAt.localeCompare(left.activityAt) ||
        left.treeId.localeCompare(right.treeId)
      );
  }, [hits]);

  const openHit = (hit: SearchHit) => {
    if (hit.kind === "workItem") onOpenWorkItem(hit);
    else if (hit.kind === "doc") onOpenDoc(hit);
    else onOpenSession(hit);
  };
  const renderFlatGroup = (kind: "workItem" | "doc", kindHits: SearchHit[]) => (
    <section key={kind}>
      <SectionLabel>{kindLabel[kind]} <span className="font-mono text-faint-foreground">{kindHits.length}</span></SectionLabel>
      <ul>
        {(expandedKinds.has(kind) ? kindHits : kindHits.slice(0, 10)).map((hit) => (
          <SearchResultRow
            key={hit.id}
            hit={hit}
            selected={hit.id === selected?.id}
            onSelect={() => setSelectedId(hit.id)}
            onOpen={() => openHit(hit)}
          />
        ))}
      </ul>
      {kindHits.length > 10 && !expandedKinds.has(kind) && (
        <div className="px-3 pb-2">
          <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => setExpandedKinds((current) => new Set(current).add(kind))}>
            展开更多
          </Button>
        </div>
      )}
    </section>
  );

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
            {flatGroups.map(({ kind, hits: kindHits }) => renderFlatGroup(kind, kindHits))}
            {sessionTrees.length > 0 && (
              <section>
                <SectionLabel>会话 <span className="font-mono text-faint-foreground">{sessionTrees.length}</span></SectionLabel>
                {(expandedKinds.has("session") ? sessionTrees : sessionTrees.slice(0, 10)).map((tree) => {
                  const expanded = !collapsedTrees.has(tree.treeId);
                  return (
                    <section key={tree.treeId} className="border-b border-border last:border-b-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="vm-search-tree-header w-full justify-start"
                        aria-expanded={expanded}
                        onClick={() => setCollapsedTrees((current) => {
                          const next = new Set(current);
                          if (next.has(tree.treeId)) next.delete(tree.treeId);
                          else next.add(tree.treeId);
                          return next;
                        })}
                      >
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <span className="min-w-0 flex-1 truncate text-left" title={tree.title}>{tree.title}</span>
                        <span className="font-mono text-micro text-faint-foreground">{tree.hits.length}</span>
                      </Button>
                      {expanded && (
                        <ul>
                          {tree.hits.map((hit) => (
                            <SearchResultRow
                              key={hit.id}
                              hit={hit}
                              selected={hit.id === selected?.id}
                              onSelect={() => setSelectedId(hit.id)}
                              onOpen={() => openHit(hit)}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
                {sessionTrees.length > 10 && !expandedKinds.has("session") && (
                  <div className="px-3 pb-2">
                    <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => setExpandedKinds((current) => new Set(current).add("session"))}>
                      展开更多
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
          <SearchPreview hit={selected} />
        </div>
        <footer className="shrink-0 border-t border-border px-4 py-2 text-caption text-muted-foreground">
          {stats
            ? "扫描 " + stats.sourcesScanned + " 项 · " + formatBytes(stats.bytesScanned) + " · " + stats.durationMs + " ms" + (stats.truncated ? " · 结果已截断" : "")
            : scanning
              ? "已找到 " + hits.length + " 条"
              : "搜索结果将在这里显示。"}
        </footer>
      </div>
    </Modal>
  );
};
