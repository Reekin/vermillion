import { create } from "zustand";
import type { ComposerStatusNotice } from "../chat-shell/composer-status.js";
import { t } from "../../i18n/index.js";
import { formatClock, formatListTime, formatMonthDay } from "../../i18n/format.js";

export type OutputSeverity = "info" | "warning" | "error";

/** One line of the event log; identical notices collapse into one entry with a count. */
export type OutputEntry = {
  id: string;
  /** First and latest occurrence. */
  firstAt: string;
  at: string;
  severity: OutputSeverity;
  source?: ComposerStatusNotice["source"];
  message: string;
  detail?: string;
  stack?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  engineId?: string;
  count: number;
};

/** A configuration problem an engine reported; listed under current problems until the engine clears it. */
export type EngineConfigWarningView = {
  engineId: string;
  engineLabel: string;
  at: string;
  summary: string;
  details?: string;
  path?: string;
};

export const OUTPUT_LOG_LIMIT = 200;

const severityOf = (notice: ComposerStatusNotice): OutputSeverity => notice.severity ?? "info";
export const needsAttention = (severity: OutputSeverity): boolean => severity !== "info";
const identity = (entry: { severity: OutputSeverity; source?: string; message: string; detail?: string }): string =>
  JSON.stringify([entry.severity, entry.source ?? "", entry.message, entry.detail ?? ""]);

/** Newest first; a repeat of an existing notice moves it to the top and increases its count. */
export const appendOutputEntry = (
  log: readonly OutputEntry[],
  notice: ComposerStatusNotice,
  at: string,
  id: string
): OutputEntry[] => {
  const severity = severityOf(notice);
  const key = identity({ severity, source: notice.source, message: notice.message, detail: notice.detail });
  const previous = log.find((entry) => identity(entry) === key);
  const entry: OutputEntry = {
    id: previous?.id ?? id,
    firstAt: previous?.firstAt ?? at,
    at,
    severity,
    source: notice.source,
    message: notice.message,
    detail: notice.detail,
    stack: notice.stack,
    context: notice.context,
    sessionId: notice.sessionId,
    engineId: notice.engineId,
    count: (previous?.count ?? 0) + 1
  };
  return [entry, ...log.filter((existing) => existing !== previous)].slice(0, OUTPUT_LOG_LIMIT);
};

export type OutputCounts = Record<OutputSeverity, number>;

export const countOutput = (log: readonly OutputEntry[], warnings: readonly EngineConfigWarningView[]): OutputCounts => ({
  error: log.filter((entry) => entry.severity === "error").length,
  warning: log.filter((entry) => entry.severity === "warning").length + warnings.length,
  info: log.filter((entry) => entry.severity === "info").length
});

export type OutputFilter = { severities: ReadonlySet<OutputSeverity>; text: string };

export const matchesOutputFilter = (
  filter: OutputFilter,
  severity: OutputSeverity,
  texts: readonly (string | undefined)[]
): boolean => {
  if (!filter.severities.has(severity)) return false;
  const query = filter.text.trim().toLowerCase();
  return !query || texts.some((text) => text?.toLowerCase().includes(query));
};

/** Informational notices leave the status bar on their own; warnings and errors stay until the panel is opened. */
export const statusBarDismissDelayMs = (entry: OutputEntry): number | undefined =>
  needsAttention(entry.severity) ? undefined : 4_000;

type WarningContext = { engineId?: string; summary?: string; details?: string; path?: string };

/** Context keys shown under their own label; `persistent` is internal and hidden. */
const contextLabel = (key: string): string | undefined => {
  switch (key) {
    case "persistent":
      return undefined;
    case "executionRecoverySessionId":
    case "chatTreeRefreshSessionId":
    case "sessionId":
      return t("app.output.contextSession");
    default:
      return key;
  }
};

const readableValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const warningLines = (warning: WarningContext): string[] =>
  [
    warning.summary && t("app.output.detailOriginal") + "  " + warning.summary,
    warning.details && t("app.output.detailDetails") + "  " + warning.details,
    warning.path && t("app.output.detailConfig") + "  " + warning.path
  ].filter((line): line is string => Boolean(line));

/**
 * Technical details in readable sections (original text, engine warnings, context, stack), shown in the
 * detail pane and copied verbatim. Labels and values sit on "label  value" lines; section titles start with "//".
 */
export const outputEntryDetails = (entry: OutputEntry): string | undefined => {
  const sections: string[] = [];
  if (entry.detail) sections.push("// " + t("app.output.sectionOriginal") + "\n" + entry.detail);
  const { engineConfigWarnings, ...rest } = entry.context ?? {};
  for (const warning of Array.isArray(engineConfigWarnings) ? engineConfigWarnings as WarningContext[] : []) {
    sections.push(["// " + t("app.output.sectionEngineWarning"), ...warningLines(warning)].join("\n"));
  }
  const context = Object.entries(rest)
    .filter(([key, value]) => contextLabel(key) !== undefined && value !== undefined)
    .map(([key, value]) => contextLabel(key) + "  " + readableValue(value));
  if (context.length) sections.push(["// " + t("app.output.sectionContext"), ...context].join("\n"));
  if (entry.stack) sections.push("// " + t("app.output.sectionStack") + "\n" + entry.stack);
  return sections.length ? sections.join("\n\n") : undefined;
};

/** Configuration file named by the engine warnings attached to an entry. */
export const outputEntryConfigPath = (entry: OutputEntry): string | undefined => {
  const warnings = entry.context?.engineConfigWarnings;
  return Array.isArray(warnings) ? (warnings as WarningContext[]).find((warning) => warning.path)?.path : undefined;
};

/** User-facing wording of an engine configuration warning; the engine's summary is kept as original text. */
export const engineWarningReason = (engineLabel: string): { title: string; next: string } => ({
  title: t("app.output.engineWarningTitle", { engine: engineLabel }),
  next: t("app.output.engineWarningNext")
});

export const engineWarningDetails = (warning: { summary?: string; details?: string; path?: string }): string | undefined => {
  const lines = warningLines(warning);
  return lines.length ? ["// " + t("app.output.sectionEngineWarning"), ...lines].join("\n") : undefined;
};

/** Keeps the first receipt time of warnings that are still reported; new ones are stamped with now. */
export const stampEngineConfigWarnings = (
  previous: readonly EngineConfigWarningView[],
  byEngineId: Record<string, readonly { summary: string; details?: string; path?: string }[]>,
  engineLabel: (engineId: string) => string,
  now: string
): EngineConfigWarningView[] => {
  const key = (engineId: string, warning: { summary: string; details?: string; path?: string }) =>
    JSON.stringify([engineId, warning.summary, warning.details ?? "", warning.path ?? ""]);
  const receivedAt = new Map(previous.map((warning) => [key(warning.engineId, warning), warning.at]));
  return Object.entries(byEngineId).flatMap(([engineId, warnings]) =>
    warnings.map((warning) => ({
      ...warning,
      engineId,
      engineLabel: engineLabel(engineId),
      at: receivedAt.get(key(engineId, warning)) ?? now
    })));
};

const engineOperationSources = new Set<ComposerStatusNotice["source"]>(["send", "create-session"]);

/** Attaches the configuration warnings of the engine that ran a failed send, so both causes show together. */
export const withEngineConfigWarnings = (
  notice: ComposerStatusNotice,
  allWarnings: readonly EngineConfigWarningView[]
): ComposerStatusNotice => {
  const warnings = allWarnings.filter((warning) => warning.engineId === notice.engineId);
  return notice.severity !== "error" || !engineOperationSources.has(notice.source) || !warnings.length
    ? notice
    : {
        ...notice,
        context: {
          ...notice.context,
          engineConfigWarnings: warnings.map(({ engineId, summary, details, path }) => ({
            engineId,
            summary,
            ...(details ? { details } : {}),
            ...(path ? { path } : {})
          }))
        }
      };
};

export const sourceLabel = (source: NonNullable<ComposerStatusNotice["source"]>): string =>
  t(`app.output.source.${source}` as "app.output.source.send");

/** List time: 刚刚, N 分钟前, today's clock time, 昨天 HH:MM, or the date with the clock time. */
export const formatRelativeTime = (at: string, now: Date = new Date()): string => {
  const time = new Date(at);
  const listed = formatListTime(time, { now });
  return listed === formatMonthDay(time, now) ? `${listed} ${formatClock(time)}` : listed;
};

export const severityLabel = (severity: OutputSeverity): string => t(`app.output.severity.${severity}`);

export type OutputState = {
  entries: OutputEntry[];
  warnings: EngineConfigWarningView[];
  /** Entry shown in the status bar until it is dismissed or the panel is opened. */
  latestId?: string;
  open: boolean;
  report: (notice: ComposerStatusNotice) => void;
  setWarnings: (byEngineId: Parameters<typeof stampEngineConfigWarnings>[1], engineLabel: (engineId: string) => string) => void;
  setOpen: (open: boolean) => void;
  dismissLatest: (id: string) => void;
  clear: () => void;
};

/** App-shell owner of the output: every reported notice and the engines' current configuration warnings. */
export const createOutputStore = (now: () => string = () => new Date().toISOString()) => {
  let sequence = 0;
  return create<OutputState>((set, get) => ({
    entries: [],
    warnings: [],
    open: false,
    report: (reported) => {
      const notice = withEngineConfigWarnings(reported, get().warnings);
      sequence += 1;
      const entries = appendOutputEntry(get().entries, notice, now(), `output-${sequence}`);
      const entry = entries[0]!;
      set({ entries, latestId: get().open && needsAttention(entry.severity) ? undefined : entry.id });
    },
    setWarnings: (byEngineId, engineLabel) =>
      set({ warnings: stampEngineConfigWarnings(get().warnings, byEngineId, engineLabel, now()) }),
    setOpen: (open) => {
      if (!open) return set({ open });
      const latest = get().entries.find((entry) => entry.id === get().latestId);
      set({ open,
        latestId: latest && needsAttention(latest.severity) ? undefined : get().latestId });
    },
    dismissLatest: (id) => set((state) => (state.latestId === id ? { latestId: undefined } : state)),
    clear: () => set({ entries: [], latestId: undefined })
  }));
};

export type OutputStore = ReturnType<typeof createOutputStore>;
