import { defineMessages } from "../define.js";

/** Application shell: navigation, settings, search, output panel, status bar, desktop notifications. */
export const app = defineMessages(
  {
    "app.askSourceTitle": (p: { question: string }) => `澄清 · ${p.question}`,
    "app.notify.sessionCompleted": (p: { title: string }) => `「${p.title}」会话已完成`,
    "app.notify.decision": (p: { question: string }) => `需要你决定：${p.question}`,
    "app.notify.merged": (p: { title: string }) => `已合入：${p.title}`
  },
  {
    "app.askSourceTitle": (p) => `Clarify · ${p.question}`,
    "app.notify.sessionCompleted": (p) => `Session "${p.title}" finished`,
    "app.notify.decision": (p) => `Decision needed: ${p.question}`,
    "app.notify.merged": (p) => `Merged: ${p.title}`
  }
);
