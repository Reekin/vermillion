import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { CircleX, Copy, ExternalLink, Info, Search, Trash2, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { RendererStore } from "../../../store/store.js";
import { useEngineConfigWarningsSignal } from "../use-engine-config-warnings-signal.js";
import { writeClipboardText } from "../../chat-shell/clipboard.js";
import { cn } from "../lib/cn.js";
import { Button, IconButton } from "./ui.js";
import {
  countOutput,
  engineWarningDetails,
  matchesOutputFilter,
  outputEntryDetails,
  severityLabels,
  sourceLabels,
  statusBarDismissDelayMs,
  formatRelativeTime,
  type OutputSeverity,
  type OutputStore
} from "../output-log.js";

const severityIcons: Record<OutputSeverity, LucideIcon> = { error: CircleX, warning: TriangleAlert, info: Info };
const allSeverities: OutputSeverity[] = ["error", "warning", "info"];

const SeverityIcon = ({ severity, className, size = 14 }: { severity: OutputSeverity; className?: string; size?: number }) => {
  const Icon = severityIcons[severity];
  return <Icon size={size} aria-label={severityLabels[severity]} className={cn("vm-output-icon", className)} data-severity={severity} />;
};

const formatTime = (at: string): string => new Date(at).toLocaleTimeString([], { hour12: false });

/** Monospace details with JSON keys and string values set apart. */
const DetailCode = ({ text }: { text: string }) => (
  <pre className="vm-output-code">
    {text.split("\n").map((line, index) => {
      const match = /^(\s*)"([^"]+)": (.*)$/.exec(line);
      return (
        <span key={index}>
          {match ? <>{match[1]}<span className="vm-output-code__key">"{match[2]}"</span>{": "}
            <span className={/^"/.test(match[3]!) ? "vm-output-code__string" : undefined}>{match[3]}</span></> : line}
          {"\n"}
        </span>
      );
    })}
  </pre>
);

type Row = {
  key: string;
  group: "problems" | "events";
  severity: OutputSeverity;
  at: string;
  firstAt: string;
  source: string;
  message: string;
  count: number;
  details?: string;
  meta: ReactNode[];
  sessionId?: string;
};

export type OutputStatusProps = {
  store: OutputStore;
  sessionStore: RendererStore;
  transport: DesktopTransport;
  onOpenSession?: (sessionId: string) => boolean;
};

/** Status bar summary of the output (latest notice and problem counts) and the output panel it opens. */
export const OutputStatus = ({ store, sessionStore, transport, onOpenSession }: OutputStatusProps) => {
  const entries = store((state) => state.entries);
  const warnings = store((state) => state.warnings);
  const latestId = store((state) => state.latestId);
  const open = store((state) => state.open);
  const warningsSignal = useEngineConfigWarningsSignal(sessionStore);
  const [engineLabels, setEngineLabels] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let disposed = false;
    void Promise.all([transport.settings.get(), transport.engine.list()]).then(([settings, engines]) => {
      if (disposed) return;
      setEngineLabels(Object.fromEntries(engines.map((engine) => [engine.engineId, engine.displayName])));
      store.getState().setWarnings(settings.engineConfigWarningsByEngineId ?? {},
        (engineId) => engines.find((engine) => engine.engineId === engineId)?.displayName ?? engineId);
    }, () => undefined);
    return () => { disposed = true; };
  }, [store, transport, warningsSignal]);

  const latest = entries.find((entry) => entry.id === latestId);
  useEffect(() => {
    const delay = latest && statusBarDismissDelayMs(latest);
    if (!latest || delay === undefined) return;
    const timer = window.setTimeout(() => store.getState().dismissLatest(latest.id), delay);
    return () => window.clearTimeout(timer);
  }, [latest, store]);

  const counts = countOutput(entries, warnings);
  const setOpen = (next: boolean) => store.getState().setOpen(next);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {latest && (
        <button type="button" className="vm-output-latest" onClick={() => setOpen(true)} title={latest.message}>
          <SeverityIcon severity={latest.severity} />
          <span className="truncate">{latest.message}</span>
        </button>
      )}
      {latest && <span className="vm-output-separator" aria-hidden="true" />}
      <Popover.Trigger render={<button type="button" className="vm-output-counts" aria-label={`输出：${counts.error} 个错误，${counts.warning} 个警告`} />}>
        {(["error", "warning"] as const).map((severity) => (
          <span key={severity} className="vm-output-count" data-zero={counts[severity] === 0}>
            <SeverityIcon severity={severity} size={12} />{counts[severity]}
          </span>
        ))}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="z-50">
          <Popover.Popup aria-label="输出" className="vm-output-panel" initialFocus={searchRef}>
            <OutputPanel store={store} engineLabels={engineLabels} searchRef={searchRef} onOpenSession={onOpenSession} onClose={() => setOpen(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const OutputPanel = ({ store, engineLabels, searchRef, onOpenSession, onClose }: {
  store: OutputStore;
  engineLabels: Record<string, string>;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenSession?: (sessionId: string) => boolean;
  onClose: () => void;
}) => {
  const entries = store((state) => state.entries);
  const warnings = store((state) => state.warnings);
  const [severities, setSeverities] = useState<ReadonlySet<OutputSeverity>>(new Set(allSeverities));
  const [text, setText] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const counts = countOutput(entries, warnings);

  const rows = useMemo((): Row[] => {
    const filter = { severities, text };
    const problems = warnings.map((warning, index): Row => ({
      key: `problem-${warning.engineId}-${index}`, group: "problems", severity: "warning", at: warning.at, firstAt: warning.at,
      source: `${warning.engineLabel} 配置`, message: warning.summary, count: 1, details: engineWarningDetails(warning),
      meta: [<span key="engine">引擎 {warning.engineLabel}</span>, ...(warning.path ? [<span key="path">配置 {warning.path}</span>] : [])]
    }));
    const events = entries.map((entry): Row => ({
      key: entry.id, group: "events", severity: entry.severity, at: entry.at, firstAt: entry.firstAt,
      source: entry.source ? sourceLabels[entry.source] : "应用", message: entry.message, count: entry.count,
      details: outputEntryDetails(entry), sessionId: entry.sessionId,
      meta: entry.engineId ? [<span key="engine">引擎 {engineLabels[entry.engineId] ?? entry.engineId}</span>] : []
    }));
    return [...problems, ...events].filter((row) => matchesOutputFilter(filter, row.severity, [row.message, row.source, row.details]));
  }, [engineLabels, entries, severities, text, warnings]);

  // Without a choice, show the newest error: it is usually why the panel was opened.
  const selected = rows.find((row) => row.key === selectedKey)
    ?? rows.find((row) => row.group === "events" && row.severity === "error") ?? rows[0];
  useEffect(() => setCopyState("idle"), [selected?.key]);

  const toggleSeverity = (severity: OutputSeverity) => setSeverities((current) => {
    const next = new Set(current);
    if (next.has(severity)) next.delete(severity); else next.add(severity);
    return next;
  });
  const copy = () => {
    if (!selected) return;
    const settle = (state: "copied" | "failed") => {
      setCopyState(state);
      window.setTimeout(() => setCopyState("idle"), 1_500);
    };
    void writeClipboardText(selected.details ? `${selected.message}\n\n${selected.details}` : selected.message)
      .then(() => settle("copied"), () => settle("failed"));
  };

  const renderGroup = (group: Row["group"], title: string) => {
    const groupRows = rows.filter((row) => row.group === group);
    if (!groupRows.length) return null;
    return (
      <li>
        <div className="vm-output-section">{title}<span className="vm-output-section__count">{groupRows.length}</span></div>
        <ul>
          {groupRows.map((row) => (
            <li key={row.key}>
              <button type="button" className="vm-output-row" data-severity={row.severity} aria-selected={row === selected}
                onClick={() => setSelectedKey(row.key)}>
                <SeverityIcon severity={row.severity} />
                <span className="vm-output-time" title={formatTime(row.at)}>{formatRelativeTime(row.at)}</span>
                <span className="vm-output-source">{row.source}</span>
                <span className="vm-output-message">{row.message}</span>
                {row.count > 1 ? <span className="vm-output-repeat">×{row.count}</span> : <span />}
              </button>
            </li>
          ))}
        </ul>
      </li>
    );
  };

  return (
    <>
      <div className="vm-output-toolbar">
        <span className="vm-output-title">输出</span>
        <div className="vm-output-filters" role="group" aria-label="按级别筛选">
          {allSeverities.map((severity) => (
            <button key={severity} type="button" aria-pressed={severities.has(severity)} title={`显示${severityLabels[severity]}`}
              onClick={() => toggleSeverity(severity)}>
              <SeverityIcon severity={severity} />{counts[severity]}
            </button>
          ))}
        </div>
        <label className="vm-output-search">
          <Search size={14} aria-hidden="true" />
          <input ref={searchRef} data-ui-raw="search box inside the output popover" value={text} placeholder="筛选"
            aria-label="筛选输出" onChange={(event) => setText(event.target.value)} />
        </label>
        <IconButton icon={Trash2} label="清空事件记录" disabled={!entries.length} onClick={() => store.getState().clear()} />
        <IconButton icon={X} label="关闭" onClick={onClose} />
      </div>
      <ul className="vm-output-list">
        {renderGroup("problems", "当前问题")}
        {renderGroup("events", "事件记录")}
        {!rows.length && <li className="vm-output-empty">{entries.length || warnings.length ? "没有符合筛选的记录" : "暂无输出"}</li>}
      </ul>
      {selected && (
        <section className="vm-output-detail" aria-label="详情">
          <div className="vm-output-detail__head">
            <span className="vm-output-level" data-severity={selected.severity}>
              <SeverityIcon severity={selected.severity} />{severityLabels[selected.severity]}
            </span>
            <span>{selected.source}</span>
            <span className="vm-output-time">{selected.count > 1 ? `${formatTime(selected.firstAt)} – ${formatTime(selected.at)} · 出现 ${selected.count} 次` : formatTime(selected.at)}</span>
            <span className="vm-output-detail__actions">
              {selected.sessionId && onOpenSession && (
                <Button size="sm" variant="ghost" outlined onClick={() => { if (onOpenSession(selected.sessionId!)) onClose(); }}>
                  <ExternalLink size={14} aria-hidden="true" />打开会话
                </Button>
              )}
              <Button size="sm" variant="ghost" outlined onClick={copy}>
                <Copy size={14} aria-hidden="true" />{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
              </Button>
            </span>
          </div>
          <p className="vm-output-detail__message">{selected.message}</p>
          {selected.meta.length > 0 && <div className="vm-output-detail__meta">{selected.meta}</div>}
          {selected.details && <DetailCode text={selected.details} />}
        </section>
      )}
    </>
  );
};
