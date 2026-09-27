import { defineMessages, plural } from "../define.js";

/** Wording shared across areas: time, duration and generic actions. */
export const common = defineMessages(
  {
    "common.justNow": "刚刚",
    "common.minutesAgo": (p: { count: number }) => `${p.count} 分钟前`,
    "common.hoursAgo": (p: { count: number }) => `${p.count} 小时前`,
    "common.yesterdayAt": (p: { time: string }) => `昨天 ${p.time}`,
    "common.durationSeconds": (p: { seconds: number }) => `${p.seconds} 秒`,
    "common.durationMinutes": (p: { minutes: number }) => `${p.minutes} 分钟`,
    "common.durationMinutesSeconds": (p: { minutes: number; seconds: number }) => `${p.minutes} 分 ${p.seconds} 秒`,
    "common.durationHours": (p: { hours: number }) => `${p.hours} 小时`,
    "common.durationHoursMinutes": (p: { hours: number; minutes: number }) => `${p.hours} 小时 ${p.minutes} 分`,
    "common.untitledSession": "未命名会话",
    "common.cancel": "取消",
    "common.confirm": "确认",
    "common.save": "保存",
    "common.close": "关闭",
    "common.copy": "复制",
    "common.copied": "已复制",
    "common.retry": "重试",
    "common.delete": "删除",
    "common.loading": "加载中…",
    "common.listSeparator": "、"
  },
  {
    "common.justNow": "Just now",
    "common.minutesAgo": (p) => `${p.count} min ago`,
    "common.hoursAgo": (p) => `${plural(p.count, "hr")} ago`,
    "common.yesterdayAt": (p) => `Yesterday ${p.time}`,
    "common.durationSeconds": (p) => `${p.seconds} sec`,
    "common.durationMinutes": (p) => `${p.minutes} min`,
    "common.durationMinutesSeconds": (p) => `${p.minutes} min ${p.seconds} sec`,
    "common.durationHours": (p) => plural(p.hours, "hr"),
    "common.durationHoursMinutes": (p) => `${plural(p.hours, "hr")} ${p.minutes} min`,
    "common.untitledSession": "Untitled session",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.save": "Save",
    "common.close": "Close",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.retry": "Retry",
    "common.delete": "Delete",
    "common.loading": "Loading…",
    "common.listSeparator": ", "
  }
);
