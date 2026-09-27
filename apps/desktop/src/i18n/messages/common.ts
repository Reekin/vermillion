import { defineMessages } from "../define.js";

/** Wording shared across areas: time, duration and generic actions. */
export const common = defineMessages(
  {
    "common.justNow": "刚刚",
    "common.yesterdayAt": (p: { time: string }) => `昨天 ${p.time}`,
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
    "common.yesterdayAt": (p) => `Yesterday ${p.time}`,
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
