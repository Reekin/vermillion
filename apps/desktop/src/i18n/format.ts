import { intlLocale, t } from "./index.js";

/** "45 秒", "1 分 27 秒", "1 小时 5 分" / "45 sec", "1 min 27 sec", "1 hr 5 min". */
export const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return t("common.durationSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? t("common.durationMinutesSeconds", { minutes, seconds: rest }) : t("common.durationMinutes", { minutes });
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? t("common.durationHoursMinutes", { hours, minutes: restMinutes }) : t("common.durationHours", { hours });
};

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
  if (seconds < 3600) return t("common.minutesAgo", { count: Math.floor(seconds / 60) });
  if (sameDay(date, now)) {
    return options.hoursAgo ? t("common.hoursAgo", { count: Math.floor(seconds / 3600) }) : formatClock(date, options.withSeconds);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return t("common.yesterdayAt", { time: formatClock(date, options.withSeconds) });
  return formatMonthDay(date, now);
};

/** Joins short items in the interface language ("a、b" / "a, b"). */
export const joinList = (items: string[]): string => items.join(t("common.listSeparator"));
