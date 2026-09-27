import { intlLocale, t } from "./index.js";

type DurationParts = { hours?: number; minutes?: number; seconds?: number };
/** Intl.DurationFormat (ES2025) is available in the Electron runtime; the ES2022 lib does not declare it. */
const DurationFormat = (Intl as unknown as {
  DurationFormat: new (locale: string, options: { style: "short" }) => { format: (duration: DurationParts) => string };
}).DurationFormat;

/** "1分钟27秒", "1小时5分钟" / "1 min, 27 sec", "1 hr, 5 min": the two largest units, formatted by Intl. */
export const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const parts: DurationParts = hours > 0
    ? { hours, ...(minutes > 0 ? { minutes } : {}) }
    : minutes > 0 ? { minutes, ...(seconds % 60 > 0 ? { seconds: seconds % 60 } : {}) } : { seconds };
  return new DurationFormat(intlLocale(), { style: "short" }).format(parts);
};

/** "5分钟前" / "5 minutes ago", formatted by Intl. */
export const formatAgo = (count: number, unit: "minute" | "hour" | "day"): string =>
  new Intl.RelativeTimeFormat(intlLocale(), { numeric: "always" }).format(-count, unit);

/** 24-hour clock time, "22:10" or "22:10:05". */
export const formatClock = (date: Date, withSeconds = false): string =>
  date.toLocaleTimeString(intlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false
  });

/** "9月11日" / "Sep 11", with the year when it is not the current one. */
export const formatMonthDay = (date: Date, now = new Date()): string =>
  date.toLocaleDateString(intlLocale(), {
    month: intlLocale() === "zh-CN" ? "long" : "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {})
  });

/** Full date and time for detail views. */
export const formatDateTime = (value: string | Date): string =>
  (typeof value === "string" ? new Date(value) : value).toLocaleString(intlLocale(), { hour12: false });

/** Calendar date only. */
export const formatDate = (value: string | Date): string =>
  (typeof value === "string" ? new Date(value) : value).toLocaleDateString(intlLocale());

const sameDay = (left: Date, right: Date): boolean => left.toDateString() === right.toDateString();

/**
 * List time: "刚刚", "5 分钟前", optionally "3 小时前", today's clock, "昨天 22:10", then the date.
 * `hoursAgo` counts hours for today's older times instead of showing the clock.
 */
export const formatListTime = (value: string | Date, options: { now?: Date; hoursAgo?: boolean; withSeconds?: boolean } = {}): string => {
  const date = typeof value === "string" ? new Date(value) : value;
  const now = options.now ?? new Date();
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return t("common.justNow");
  if (seconds < 3600) return formatAgo(Math.floor(seconds / 60), "minute");
  if (sameDay(date, now)) {
    return options.hoursAgo ? formatAgo(Math.floor(seconds / 3600), "hour") : formatClock(date, options.withSeconds);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return t("common.yesterdayAt", { time: formatClock(date, options.withSeconds) });
  return formatMonthDay(date, now);
};

/** Joins short items in the interface language ("a、b" / "a, b"). */
export const joinList = (items: string[]): string => items.join(t("common.listSeparator"));
