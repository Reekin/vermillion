import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionLoadingState } from "../src/ui/chat-shell/SessionLoadingState.js";
import { advanceLoadingTimeline, loadingDetail } from "../src/ui/chat-shell/session-loading-progress.js";

describe("session loading presentation", () => {
  it("presents actual stages without claiming a percentage", () => {
    for (const [stage, label] of [["opening", "正在连接会话"], ["history", "正在确定阅读路径"], ["preparing", "正在排版消息"]] as const) {
      const html = renderToStaticMarkup(createElement(SessionLoadingState, { stage }));
      expect(html).toContain(label);
      expect(html).toContain('role="status"');
      expect(html).not.toMatch(/Empty thread|aria-valuenow|%/);
    }
  });
  it("ends the loading animation on failure and exposes a retry", () => {
    const html = renderToStaticMarkup(createElement(SessionLoadingState, { failed: true }));
    expect(html).toContain("is-failed");
    expect(html).toContain("暂时无法打开会话");
    expect(html).toContain("重新加载");
    expect(html).not.toContain('aria-current="step"');
  });
  it("freezes completed stage times while the following stage starts", () => {
    const opened = advanceLoadingTimeline({}, "opening", 1000);
    const reading = advanceLoadingTimeline(opened, "history", 3500);
    const preparing = advanceLoadingTimeline(reading, "preparing", 20000);
    expect(preparing.opening).toEqual({ start: 1000, end: 3500 });
    expect(preparing.history).toEqual({ start: 3500, end: 20000 });
    expect(preparing.preparing).toEqual({ start: 20000 });
    expect(opened.opening).toEqual({ start: 1000 });
  });
  it("shows actual member counts without a percentage", () => {
    expect(loadingDetail("history", { readId: "r", sessionId: "s", stage: "waiting-engine", completed: 7, total: 16 }))
      .toBe("等待引擎返回历史 · 已就绪 7 / 16 个会话");
  });
});
