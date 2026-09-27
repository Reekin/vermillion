import {
  Archive, ArrowUpRight, Bot, ChevronDown, ChevronRight, Eye, FileText, Globe, Image as ImageIcon, ImagePlus, Lightbulb,
  List, ListTodo, MessageSquare, Pencil, Search, Terminal, Wrench, type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SearchHit, SearchResult, WorkbenchClient } from "@vermillion/workbench/client";
import { formatMessageTime } from "../../chat-shell/index.js";
import { Modal } from "./Modal.js";
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ListRow, SectionLabel } from "./ui.js";
import { t } from "../../../i18n/index.js";
import { useLocale, useT } from "../../../i18n/react.js";
import { toolStepResult, toolStepVerb } from "../../../i18n/tool-steps.js";

type SearchDialogProps = {
  client: WorkbenchClient;
  onClose: () => void;
  onOpenWorkItem: (hit: SearchHit) => void;
  onOpenDoc: (hit: SearchHit) => void;
  onOpenSession: (hit: SearchHit) => void;
};

/** Keystrokes settle before a scan starts; composed input waits for the IME to commit. */
const QUERY_DEBOUNCE_MS = 150;

const kindLabel = (kind: SearchHit["kind"]): string => t(`app.search.kind.${kind}`);

const kindIcon: Record<SearchHit["kind"], typeof FileText> = {
  workItem: ListTodo,
  session: MessageSquare,
  doc: FileText
};

/** Same icons as the process steps in the message area. */
const toolIcons: Record<string, LucideIcon> = {
  think: Lightbulb,
  read: Eye,
  list: List,
  search: Search,
  edit: Pencil,
  run: Terminal,
  web: Globe,
  view: ImageIcon,
  generate: ImagePlus,
  compact: Archive,
  agent: Bot,
  other: Wrench
};

type SearchSource = NonNullable<SearchHit["source"]>;

const sourceLabel = (source: SearchSource): string => t(`app.search.source.${source}`);

type ContextLine = SearchHit["context"][number];

/** Session trees without a title of their own read as untitled. */
const hitTitle = (hit: SearchHit): string => hit.treeTitle || hit.title || t("common.untitledSession");

/** Where a work item line sits in the detail ("验收 3" / "Acceptance 3"). */
const partLabel = (part: NonNullable<ContextLine["part"]>): string => {
  switch (part.kind) {
    case "acceptance":
    case "acceptanceResult":
    case "review":
      return t(`app.search.part.${part.kind}`, { index: part.index ?? 0 });
    default:
      return t(`app.search.part.${part.kind}`);
  }
};

/**
 * Tool lines carry only the object as text (what search matched); the action and result are worded
 * here, so the line reads as in the message area: "读取 README.md · 输出 3 行".
 */
const displayLine = (line: ContextLine): ContextLine => {
  if (!line.toolStep) return line;
  const step = line.toolStep as Parameters<typeof toolStepVerb>[0] & { result?: Parameters<typeof toolStepResult>[0] };
  const prefix = toolStepVerb(step) + " ";
  const object = step.kind === "list" && line.text === "." ? t("step.object.currentDirectory") : line.text;
  const result = toolStepResult(step.result);
  const shift = object === line.text ? prefix.length : 0;
  return {
    ...line,
    text: prefix + object + (result ? " · " + result : ""),
    matches: shift ? line.matches.map((match) => ({ start: match.start + shift, end: match.end + shift })) : []
  };
};

/** "你 · 第 3 轮 · 昨天 14:42" */
const sessionMeta = (hit: SearchHit): string =>
  [
    hit.source ? sourceLabel(hit.source) : undefined,
    hit.turnNumber ? t("app.search.turn", { number: hit.turnNumber }) : undefined,
    formatMessageTime(hit.messageAt)
  ].filter(Boolean).join(" · ");

const SourceMark = ({ hit }: { hit: SearchHit }) => {
  useT();
  if (hit.source === "user") {
    return <span aria-label={sourceLabel("user")} className="vm-search-source">{t("app.search.youMark")}</span>;
  }
  const Icon = hit.source === "tool" ? toolIcons[hit.toolKind ?? "other"] ?? Wrench : MessageSquare;
  return (
    <span aria-label={hit.source ? sourceLabel(hit.source) : kindLabel("session")} className="vm-search-source" data-source={hit.source}>
      <Icon size={12} aria-hidden="true" />
    </span>
  );
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return String(Math.round(bytes / 102.4) / 10) + " KB";
  return String(Math.round(bytes / (1024 * 102.4)) / 10) + " MB";
};

const resultMeta = (hit: SearchHit): string =>
  [kindLabel(hit.kind), hit.workspaceLabel, t("app.search.lineColumn", { line: hit.line, column: hit.column })]
    .filter(Boolean)
    .join(" · ");

const contextLineText = (line: ContextLine) => {
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

const matchingLine = (hit: SearchHit): ContextLine | undefined => {
  const line = hit.context.find((line) => line.line === hit.line) ??
  hit.context.find((line) => line.matches.length > 0) ??
  hit.context[0];
  return line && displayLine(line);
};

const RESULT_SNIPPET_CHARS = 96;
const RESULT_SNIPPET_PREFIX_CHARS = 20;

const snippetLine = (line: ContextLine): ContextLine => {
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
  useT();
  const hitLineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    hitLineRef.current?.scrollIntoView({ block: "center" });
  }, [hit?.id]);
  if (!hit) return <EmptyState title={t("app.search.pickHit")} hint={t("app.search.pickHitHint")} />;
  if (hit.kind !== "doc") {
    return (
      <section aria-label={hit.kind === "session" ? t("app.search.messagePreview") : t("app.search.contentPreview")} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-border px-4 py-3">
          <p className="truncate text-label font-medium text-strong" title={hitTitle(hit)}>
            {hitTitle(hit)}
          </p>
          <p className="mt-1 truncate text-caption text-muted-foreground">{hit.kind === "session" ? sessionMeta(hit) : hit.workspaceLabel}</p>
        </header>
        <div className="vm-scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {hit.context.map(displayLine).map((line) => {
            const current = line.line === hit.line;
            return (
              <div key={line.line} ref={current ? hitLineRef : undefined} data-current={current || undefined}
                className="vm-search-message">
                {(line.source || line.part) && <p className="text-micro text-muted-foreground">{line.source ? sourceLabel(line.source) : partLabel(line.part!)}</p>}
                <p className="mt-1 whitespace-pre-wrap break-words text-label">{contextLineText(line)}</p>
              </div>
            );
          })}
        </div>
      </section>
    );
  }
  return (
    <section aria-label={t("app.search.locationPreview")} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <p className="truncate text-label font-medium text-strong" title={hitTitle(hit)}>
          {hitTitle(hit)}
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
  useT();
  const Icon = kindIcon[hit.kind];
  const line = matchingLine(hit);
  const shortLine = line ? snippetLine(line) : undefined;
  const session = hit.kind === "session";
  return (
    <div
      onDoubleClick={onOpen}
      onFocusCapture={onSelect}
      onMouseDown={(event) => event.stopPropagation()}
      title={t("app.search.rowHint")}
    >
      <ListRow
        leading={session
          ? <SourceMark hit={hit} />
          : <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={
          <span className={hit.kind === "doc" ? "font-mono" : undefined}>
            {shortLine ? contextLineText(shortLine) : hit.title}
          </span>
        }
        titleClassName="vm-search-result-title"
        meta={session ? sessionMeta(hit) : hit.workspaceLabel + " · " + (line?.part ? partLabel(line.part) : t("app.search.line", { line: hit.line }))}
        trailing={session ? undefined : <Badge>{kindLabel(hit.kind)}</Badge>}
        hoverActions={<IconButton icon={ArrowUpRight} label={t("app.search.open")} size={13} onClick={onOpen} />}
        selected={selected}
        onClick={onSelect}
      />
    </div>
  );
};

type SessionTreeGroup = {
  treeId: string;
  title: string;
  activityAt: string;
  hits: SearchHit[];
};

type ResultRow = { key: string } & (
  | { type: "hit"; hit: SearchHit }
  | { type: "label"; kind: SearchHit["kind"]; count: number }
  | { type: "tree"; tree: SessionTreeGroup; expanded: boolean }
  | { type: "more"; kind: SearchHit["kind"] }
);

/** A single viewport bounds mounted rows across both trees and their matches. */
const SearchResults = ({ rows, selectedId, onSelect, onOpen, onToggleTree, onExpandKind }: {
  rows: ResultRow[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onOpen: (hit: SearchHit) => void;
  onToggleTree: (id: string) => void;
  onExpandKind: (kind: SearchHit["kind"]) => void;
}) => {
  useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) => rows[index]!.type === "hit" ? 80 : 36,
    overscan: 6
  });
  // Keyboard selection moves past the viewport; keep the selected row visible.
  useEffect(() => {
    const index = rows.findIndex((row) => row.type === "hit" && row.hit.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [rows, selectedId, virtualizer]);
  return (
    <div ref={scrollRef} className="vm-scrollbar-hidden min-h-0 flex-1 overflow-y-auto" aria-label={t("app.search.results")}>
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <li key={item.key} data-index={item.index} ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
              {row.type === "hit" ? (
                <SearchResultRow hit={row.hit} selected={row.hit.id === selectedId}
                  onSelect={() => onSelect(row.hit.id)} onOpen={() => onOpen(row.hit)} />
              ) : row.type === "label" ? (
                <SectionLabel>{kindLabel(row.kind)} <span className="font-mono text-faint-foreground">{row.count}</span></SectionLabel>
              ) : row.type === "tree" ? (
                <Button variant="ghost" size="sm" className="vm-search-tree-header w-full justify-start"
                  aria-expanded={row.expanded} onClick={() => onToggleTree(row.tree.treeId)}>
                  {row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="min-w-0 flex-1 truncate text-left" title={row.tree.title}>{row.tree.title}</span>
                  <span className="font-mono text-micro text-faint-foreground">{row.tree.hits.length}</span>
                </Button>
              ) : (
                <div className="px-3 pb-2">
                  <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onExpandKind(row.kind)}>
                    {t("app.search.showMore")}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const SearchDialog = ({ client, onClose, onOpenWorkItem, onOpenDoc, onOpenSession }: SearchDialogProps) => {
  const locale = useLocale();
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
      const group = grouped.get(hit.kind);
      if (group) group.push(hit);
      else grouped.set(hit.kind, [hit]);
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
        title: hitTitle(hit),
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
  }, [hits, locale]);

  const openHit = (hit: SearchHit) => {
    if (hit.kind === "workItem") onOpenWorkItem(hit);
    else if (hit.kind === "doc") onOpenDoc(hit);
    else onOpenSession(hit);
  };
  const rows = useMemo(() => {
    const result: ResultRow[] = [];
    const addHit = (hit: SearchHit) => result.push({ type: "hit", key: `hit:${hit.id}`, hit });
    for (const { kind, hits: kindHits } of flatGroups) {
      result.push({ type: "label", key: kind, kind, count: kindHits.length });
      (expandedKinds.has(kind) ? kindHits : kindHits.slice(0, 10)).forEach(addHit);
      if (kindHits.length > 10 && !expandedKinds.has(kind)) {
        result.push({ type: "more", key: `more:${kind}`, kind });
      }
    }
    if (sessionTrees.length) {
      result.push({ type: "label", key: "session", kind: "session", count: sessionTrees.length });
      for (const tree of expandedKinds.has("session") ? sessionTrees : sessionTrees.slice(0, 10)) {
        const expanded = !collapsedTrees.has(tree.treeId);
        result.push({ type: "tree", key: `tree:${tree.treeId}`, tree, expanded });
        if (expanded) tree.hits.forEach(addHit);
      }
      if (sessionTrees.length > 10 && !expandedKinds.has("session")) {
        result.push({ type: "more", key: "more:session", kind: "session" });
      }
    }
    return result;
  }, [flatGroups, sessionTrees, expandedKinds, collapsedTrees]);

  /** ↑↓ walk the listed matches, Enter opens the selected one; the IME and focused buttons keep their own Enter. */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (composing || event.nativeEvent.isComposing) return;
    const visible = rows.flatMap((row) => row.type === "hit" ? [row.hit] : []);
    if (event.key === "Enter") {
      if (!selected || (event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      openHit(selected);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (visible.length === 0) return;
    event.preventDefault();
    const current = visible.findIndex((hit) => hit.id === selected?.id);
    const next = event.key === "ArrowDown"
      ? Math.min(visible.length - 1, current + 1)
      : Math.max(0, current < 0 ? 0 : current - 1);
    setSelectedId(visible[next]!.id);
  };

  return (
    <Modal title={t("app.search.title")} onClose={onClose} width={980} height="74vh" contentClassName="overflow-hidden">
      <div className="flex h-full min-h-[480px] min-w-0 flex-col" onKeyDown={handleKeyDown}>
        <div className="shrink-0 border-b border-border px-4 py-3">
          <Field
            aria-label={t("app.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setQuery(event.currentTarget.value);
              setComposing(false);
            }}
            placeholder={t("app.search.placeholder")}
            autoFocus
          />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.15fr)]">
          <div className="flex min-h-0 flex-col border-b border-border md:border-b-0 md:border-r">
            {error && <InlineNotice tone="error" className="pt-3">{error}</InlineNotice>}
            {!trimmed && <EmptyState title={t("app.search.enterQuery")} />}
            {scanning && hits.length === 0 && <InlineNotice className="pt-3">{t("app.search.searching")}</InlineNotice>}
            {!scanning && trimmed && stats && hits.length === 0 && <EmptyState title={t("app.search.noResults")} hint={t("app.search.noResultsHint")} />}
            <SearchResults key={trimmed} rows={rows} selectedId={selected?.id} onSelect={setSelectedId} onOpen={openHit}
              onExpandKind={(kind) => setExpandedKinds((current) => new Set(current).add(kind))}
              onToggleTree={(id) => setCollapsedTrees((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })} />
          </div>
          <SearchPreview hit={selected} />
        </div>
        <footer className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-caption text-muted-foreground">
          <span><kbd className="vm-kbd">↑↓</kbd> {t("app.search.keySelect")}</span>
          <span><kbd className="vm-kbd">Enter</kbd> {t("app.search.keyOpen")}</span>
          <span><kbd className="vm-kbd">Esc</kbd> {t("common.close")}</span>
          <span className="ml-auto truncate">
            {stats
              ? t("app.search.stats", { hits: hits.length, sources: stats.sourcesScanned, bytes: formatBytes(stats.bytesScanned), ms: stats.durationMs })
                + (stats.truncated ? " · " + t("app.search.truncated") : "")
              : scanning
                ? t("app.search.found", { count: hits.length })
                : ""}
          </span>
        </footer>
      </div>
    </Modal>
  );
};
