import { create } from "zustand";
import type { ComposerStatusNotice } from "../chat-shell/composer-status.js";

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
const identity = (entry: { severity: OutputSeverity; source?: string; message: string }): string =>
  JSON.stringify([entry.severity, entry.source ?? "", entry.message]);

/** Newest first; a repeat of an existing notice moves it to the top and increases its count. */
export const appendOutputEntry = (
  log: readonly OutputEntry[],
  notice: ComposerStatusNotice,
  at: string,
  id: string
): OutputEntry[] => {
  const severity = severityOf(notice);
  const key = identity({ severity, source: notice.source, message: notice.message });
  const previous = log.find((entry) => identity(entry) === key);
  const entry: OutputEntry = {
    id: previous?.id ?? id,
    firstAt: previous?.firstAt ?? at,
    at,
    severity,
    source: notice.source,
    message: notice.message,
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

/** Technical details shown in the detail pane and included when copying. */
export const outputEntryDetails = (entry: OutputEntry): string | undefined => {
  const parts = [
    entry.context && Object.keys(entry.context).length ? JSON.stringify(entry.context, null, 2) : undefined,
    entry.stack
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n\n") : undefined;
};

export const engineWarningDetails = (warning: { details?: string; path?: string }): string | undefined => {
  const parts = [warning.details, warning.path ? `配置文件：${warning.path}` : undefined]
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n\n") : undefined;
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

export const sourceLabels: Record<NonNullable<ComposerStatusNotice["source"]>, string> = {
  "engine-list": "引擎列表",
  "engine-select": "引擎选择",
  subscription: "事件订阅",
  send: "发送",
  "create-session": "新建会话",
  approval: "审批",
  "workspace-add": "添加 workspace",
  "workspace-action": "workspace 操作",
  "session-browser": "会话列表",
  "session-action": "会话操作",
  "chat-tree": "会话树",
  delegation: "委派",
  settings: "设置"
};

/** List time: 刚刚, N 分钟前, today's clock time, or 昨天 HH:MM. */
export const formatRelativeTime = (at: string, now: Date = new Date()): string => {
  const time = new Date(at);
  const seconds = Math.max(0, Math.round((now.getTime() - time.getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  const clock = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (time.toDateString() === now.toDateString()) return clock;
  if (time.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  return `${time.getMonth() + 1}月${time.getDate()}日 ${clock}`;
};

export const severityLabels: Record<OutputSeverity, string> = { error: "错误", warning: "警告", info: "信息" };

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
