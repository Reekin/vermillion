import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionLoadingState } from "../src/ui/chat-shell/SessionLoadingState.js";

describe("session loading presentation", () => {
  it("presents actual stages without claiming a percentage", () => {
    for (const [stage, label] of [["opening", "正在打开会话"], ["history", "正在读取历史"], ["preparing", "正在整理消息"]] as const) {
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
    expect(html).not.toContain("awb-session-loading__steps");
  });
});
