// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describeToolStep, summarizeToolSteps, type ToolCall } from "@vermillion/shared";
import { catalog } from "../src/i18n/messages/index.js";
import { setLocale, t, translate } from "../src/i18n/index.js";
import { useT } from "../src/i18n/react.js";
import { formatDuration } from "../src/i18n/format.js";
import { toolStepWords, toolSummaryText } from "../src/i18n/tool-steps.js";

const han = /\p{Script=Han}/u;

afterEach(() => setLocale("zh"));

const call = (patch: Partial<ToolCall>): ToolCall => ({
  toolCallId: "tool-1", sessionId: "session-1", turnId: "turn-1", toolName: "commandExecution",
  status: "completed", startedAt: "2026-09-26T00:00:00.000Z", ...patch
});

describe("interface language", () => {
  it("has the same keys in both languages, and English text without Chinese", () => {
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog.zh).sort());
    const params = new Proxy({}, { get: () => "1" });
    for (const [key, message] of Object.entries(catalog.en)) {
      const text = typeof message === "function" ? (message as (p: unknown) => string)(params) : message;
      // Language names are shown in their own language in both interfaces.
      if (key === "app.settingsPage.languageZh") continue;
      expect(han.test(text), key + ": " + text).toBe(false);
    }
  });

  it("words tool steps, turn summaries and durations in the current language", () => {
    const read = describeToolStep(call({ actions: [{ kind: "read", target: "README.md" }] }), { text: "a\nb\nc" });
    const failed = describeToolStep(call({ inputSummary: "pnpm build" }), { text: "boom", exitCode: 2 });
    const summary = summarizeToolSteps([read, failed], { durationMs: 87_000 });
    expect(toolStepWords(read)).toEqual({ verb: "读取", object: "README.md", result: "输出 3 行" });
    expect(toolStepWords(failed).result).toBe("失败 · 退出码 2");
    expect(toolSummaryText(summary)).toBe("读取 1 个文件 · 运行 1 条命令 · 1 步失败 · 1 分 27 秒");
    setLocale("en");
    expect(toolStepWords(read)).toEqual({ verb: "Read", object: "README.md", result: "3 lines" });
    expect(toolStepWords(failed).result).toBe("Failed · exit code 2");
    expect(toolSummaryText(summary)).toBe("Read 1 file · Ran 1 command · 1 step failed · 1 min 27 sec");
    expect(formatDuration(3_900_000)).toBe("1 hr 5 min");
    expect(translate("zh", "common.justNow")).toBe("刚刚");
  });

  it("re-renders subscribed components when the language changes", () => {
    const Label = () => <span>{useT()("app.settings")}</span>;
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Label />));
    expect(container.textContent).toBe("设置");
    act(() => setLocale("en"));
    expect(container.textContent).toBe("Settings");
    expect(t("app.settings")).toBe("Settings");
    act(() => root.unmount());
  });
});
