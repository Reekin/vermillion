import type { ComposerStatusNotice } from "./composer-status.js";

export type NoticeLogEntry = ComposerStatusNotice & {
  id: string;
  at: string;
  seen: boolean;
};

/** A configuration problem an engine reported; shown in the log until the engine clears it. */
export type EngineConfigWarningView = {
  engineId: string;
  engineLabel: string;
  summary: string;
  details?: string;
  path?: string;
};

export const NOTICE_LOG_LIMIT = 200;

const needsAttention = (notice: ComposerStatusNotice): boolean =>
  notice.severity === "warning" || notice.severity === "error";

/** Newest first; informational notices count as seen immediately. */
export const appendNoticeLogEntry = (
  log: readonly NoticeLogEntry[],
  notice: ComposerStatusNotice,
  at: string,
  id: string
): NoticeLogEntry[] =>
  [{ ...notice, id, at, seen: !needsAttention(notice) }, ...log].slice(0, NOTICE_LOG_LIMIT);

export const markNoticeLogSeen = (log: NoticeLogEntry[]): NoticeLogEntry[] =>
  log.every((entry) => entry.seen) ? log : log.map((entry) => (entry.seen ? entry : { ...entry, seen: true }));

export const countUnseenNotices = (log: readonly NoticeLogEntry[]): number =>
  log.filter((entry) => !entry.seen).length;

/** Informational notices leave the status line on their own; warnings and errors stay until the log is opened. */
export const autoDismissesNotice = (notice: ComposerStatusNotice): boolean =>
  !notice.persistent && !needsAttention(notice);

/** A notice that stays only until the user has seen it in the log. */
export const dismissedByOpeningLog = (notice: ComposerStatusNotice): boolean =>
  !notice.persistent && needsAttention(notice);

export const noticeEntryDetails = (entry: ComposerStatusNotice): string | undefined => {
  const parts = [
    entry.context && Object.keys(entry.context).length
      ? JSON.stringify(entry.context, null, 2)
      : undefined,
    entry.stack
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n\n") : undefined;
};

export const engineWarningDetails = (warning: EngineConfigWarningView): string | undefined => {
  const parts = [warning.details, warning.path ? `配置文件：${warning.path}` : undefined]
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n\n") : undefined;
};

/** Attaches the engine's active configuration warnings to an error so the log shows both causes together. */
export const withEngineConfigWarnings = (
  notice: ComposerStatusNotice,
  warnings: readonly EngineConfigWarningView[]
): ComposerStatusNotice =>
  notice.severity !== "error" || !warnings.length
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
