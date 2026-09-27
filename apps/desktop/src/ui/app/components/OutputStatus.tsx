import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { CircleX, Copy, ExternalLink, Info, Search, Trash2, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { RendererStore } from "../../../store/store.js";
import { useEngineConfigWarningsSignal } from "../use-engine-config-warnings-signal.js";
import { writeClipboardText } from "../../chat-shell/clipboard.js";
import { cn } from "../lib/cn.js";
import { Button, IconButton } from "./ui.js";
import { formatClock } from "../../../i18n/format.js";
import { useLocale, useT } from "../../../i18n/react.js";
import {
  countOutput,
  engineWarningDetails,
  engineWarningReason,
  matchesOutputFilter,
  outputEntryConfigPath,
  outputEntryDetails,
  severityLabel,
  sourceLabel,
  statusBarDismissDelayMs,
  formatRelativeTime,
  type OutputSeverity,
  type OutputStore
} from "../output-log.js";

const severityIcons: Record<OutputSeverity, LucideIcon> = { error: CircleX, warning: TriangleAlert, info: Info };
const allSeverities: OutputSeverity[] = ["error", "warning", "info"];

const SeverityIcon = ({ severity, className, size = 14 }: { severity: OutputSeverity; className?: string; size?: number }) => {
  const Icon = severityIcons[severity];
  useT();
  return <Icon size={size} aria-label={severityLabel(severity)} className={cn("vm-output-icon", className)} data-severity={severity} />;
};

/** Paths show the file name first with its folder after it; the full path is in the tooltip. */
const fileName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? `${parts.at(-1)} · ${parts.at(-2)}` : path;
};

const formatTime = (at: string): string => formatClock(new Date(at), true);

/** Monospace details: section titles and labels muted, values in the body colour; text matches what is copied. */
const DetailCode = ({ text }: { text: string }) => (
  <pre className="vm-output-code">
    {text.split("\n").map((line, index) => {
      const labelled = /^(\S+?)  (.*)$/.exec(line);
      return (
        <span key={index}>
          {line.startsWith("//") ? <span className="vm-output-code__section">{line}</span>
            : labelled ? <><span className="vm-output-code__key">{labelled[1]}</span>{"  "}<span className="vm-output-code__value">{labelled[2]}</span></>
            : line}
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
  /** What the user can do about it; shown under the message in the detail pane. */
  next?: string;
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
  sessionTitle?: (sessionId: string) => string | undefined;
};

/** Status bar summary of the output (latest notice and problem counts) and the output panel it opens. */
export const OutputStatus = ({ store, sessionStore, transport, onOpenSession, sessionTitle }: OutputStatusProps) => {
  const t = useT();
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
      <Popover.Trigger render={<button type="button" className="vm-output-counts" aria-label={t("app.output.countsLabel", { errors: counts.error, warnings: counts.warning })} />}>
        {(["error", "warning"] as const).map((severity) => (
          <span key={severity} className="vm-output-count" data-zero={counts[severity] === 0}>
            <SeverityIcon severity={severity} size={12} />{counts[severity]}
          </span>
        ))}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="z-50">
          <Popover.Popup aria-label={t("app.output.title")} className="vm-output-panel" initialFocus={searchRef}>
            <OutputPanel store={store} engineLabels={engineLabels} searchRef={searchRef} onOpenSession={onOpenSession} sessionTitle={sessionTitle} onClose={() => setOpen(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const OutputPanel = ({ store, engineLabels, searchRef, onOpenSession, sessionTitle, onClose }: {
  store: OutputStore;
  engineLabels: Record<string, string>;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenSession?: (sessionId: string) => boolean;
  sessionTitle?: (sessionId: string) => string | undefined;
  onClose: () => void;
}) => {
  const t = useT();
  const locale = useLocale();
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
      source: t("app.output.engineConfigSource", { engine: warning.engineLabel }), message: engineWarningReason(warning.engineLabel).title, next: engineWarningReason(warning.engineLabel).next,
      count: 1, details: engineWarningDetails(warning),
      meta: [<span key="engine">{t("app.output.metaEngine", { value: warning.engineLabel })}</span>, ...(warning.path ? [<span key="path" title={warning.path}>{t("app.output.metaConfig", { value: fileName(warning.path) })}</span>] : [])]
    }));
    const events = entries.map((entry): Row => ({
      key: entry.id, group: "events", severity: entry.severity, at: entry.at, firstAt: entry.firstAt,
      source: entry.source ? sourceLabel(entry.source) : t("app.output.sourceApp"), message: entry.message, count: entry.count,
      details: outputEntryDetails(entry), sessionId: entry.sessionId,
      meta: [
        ...(entry.sessionId ? [<span key="session">{t("app.output.metaSession", { value: sessionTitle?.(entry.sessionId) ?? entry.sessionId })}</span>] : []),
        ...(entry.engineId ? [<span key="engine">{t("app.output.metaEngine", { value: engineLabels[entry.engineId] ?? entry.engineId })}</span>] : []),
        ...(outputEntryConfigPath(entry) ? [<span key="path" title={outputEntryConfigPath(entry)}>{t("app.output.metaConfig", { value: fileName(outputEntryConfigPath(entry)!) })}</span>] : [])
      ]
    }));
    return [...problems, ...events].filter((row) => matchesOutputFilter(filter, row.severity, [row.message, row.source, row.details]));
  }, [engineLabels, entries, sessionTitle, severities, text, warnings, locale, t]);

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
    void writeClipboardText([selected.message, selected.next, selected.details].filter(Boolean).join("\n\n"))
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
        <span className="vm-output-title">{t("app.output.title")}</span>
        <div className="vm-output-filters" role="group" aria-label={t("app.output.filterBySeverity")}>
          {allSeverities.map((severity) => (
            <button key={severity} type="button" aria-pressed={severities.has(severity)} title={t("app.output.showSeverity", { severity: severityLabel(severity) })}
              onClick={() => toggleSeverity(severity)}>
              <SeverityIcon severity={severity} />{counts[severity]}
            </button>
          ))}
        </div>
        <label className="vm-output-search">
          <Search size={14} aria-hidden="true" />
          <input ref={searchRef} data-ui-raw="search box inside the output popover" value={text} placeholder={t("app.output.filter")}
            aria-label={t("app.output.filterLabel")} onChange={(event) => setText(event.target.value)} />
        </label>
        <IconButton icon={Trash2} label={t("app.output.clear")} disabled={!entries.length} onClick={() => store.getState().clear()} />
        <IconButton icon={X} label={t("common.close")} onClick={onClose} />
      </div>
      <ul className="vm-output-list">
        {renderGroup("problems", t("app.output.problems"))}
        {renderGroup("events", t("app.output.events"))}
        {!rows.length && <li className="vm-output-empty">{entries.length || warnings.length ? t("app.output.noMatches") : t("app.output.empty")}</li>}
      </ul>
      {selected && (
        <section className="vm-output-detail" aria-label={t("app.output.detail")}>
          <div className="vm-output-detail__head">
            <span className="vm-output-level" data-severity={selected.severity}>
              <SeverityIcon severity={selected.severity} />{severityLabel(selected.severity)}
            </span>
            <span>{selected.source}</span>
            <span className="vm-output-time">{selected.count > 1 ? t("app.output.occurrences", { first: formatTime(selected.firstAt), last: formatTime(selected.at), count: selected.count }) : formatTime(selected.at)}</span>
            <span className="vm-output-detail__actions">
              {selected.sessionId && onOpenSession && (
                <Button size="sm" variant="ghost" outlined onClick={() => { if (onOpenSession(selected.sessionId!)) onClose(); }}>
                  <ExternalLink size={14} aria-hidden="true" />{t("app.output.openSession")}
                </Button>
              )}
              <Button size="sm" variant="ghost" outlined onClick={copy}>
                <Copy size={14} aria-hidden="true" />{copyState === "copied" ? t("common.copied") : copyState === "failed" ? t("app.output.copyFailed") : t("common.copy")}
              </Button>
            </span>
          </div>
          <p className="vm-output-detail__message">{selected.message}</p>
          {selected.next && <p className="vm-output-detail__next">{selected.next}</p>}
          {selected.meta.length > 0 && <div className="vm-output-detail__meta">{selected.meta}</div>}
          {selected.details && <DetailCode text={selected.details} />}
        </section>
      )}
    </>
  );
};
