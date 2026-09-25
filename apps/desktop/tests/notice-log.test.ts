import { describe, expect, it } from "vitest";
import {
  NOTICE_LOG_LIMIT,
  appendNoticeLogEntry,
  autoDismissesNotice,
  countUnseenNotices,
  dismissedByOpeningLog,
  engineWarningDetails,
  markNoticeLogSeen,
  noticeEntryDetails,
  stampEngineConfigWarnings,
  withEngineConfigWarnings,
  type NoticeLogEntry
} from "../src/ui/chat-shell/notice-log.js";

const at = "2026-09-26T08:00:00.000Z";
const warning = { engineId: "codex", engineLabel: "Codex", at, summary: "Invalid configuration; using defaults.",
  details: "No such file", path: "/Users/test/.codex/config.toml" };

describe("notice log", () => {
  it("lists notices newest first and counts only unseen warnings and errors", () => {
    let log: NoticeLogEntry[] = [];
    log = appendNoticeLogEntry(log, { message: "Copied" }, at, "a");
    log = appendNoticeLogEntry(log, { message: "Send failed", severity: "error", source: "send" }, at, "b");
    log = appendNoticeLogEntry(log, { message: "Slow", severity: "warning" }, at, "c");
    expect(log.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
    expect(countUnseenNotices(log)).toBe(2);
    const seen = markNoticeLogSeen(log);
    expect(countUnseenNotices(seen)).toBe(0);
    expect(markNoticeLogSeen(seen)).toBe(seen);
  });

  it("keeps a bounded history", () => {
    let log: NoticeLogEntry[] = [];
    for (let index = 0; index < NOTICE_LOG_LIMIT + 5; index += 1) {
      log = appendNoticeLogEntry(log, { message: `n${index}` }, at, `id-${index}`);
    }
    expect(log).toHaveLength(NOTICE_LOG_LIMIT);
    expect(log[0]?.id).toBe(`id-${NOTICE_LOG_LIMIT + 4}`);
  });

  it("collapses informational notices on their own and keeps warnings and errors for the log", () => {
    expect(autoDismissesNotice({ message: "Copied" })).toBe(true);
    expect(autoDismissesNotice({ message: "Failed", severity: "error" })).toBe(false);
    expect(autoDismissesNotice({ message: "Reconnecting", persistent: true })).toBe(false);
    expect(dismissedByOpeningLog({ message: "Failed", severity: "error" })).toBe(true);
    expect(dismissedByOpeningLog({ message: "Send failed", severity: "error", persistent: true })).toBe(true);
    expect(dismissedByOpeningLog({ message: "Copied" })).toBe(false);
  });

  it("stamps warnings once and keeps the first receipt time while they persist", () => {
    const first = stampEngineConfigWarnings([], { codex: [{ summary: "a" }] }, () => "Codex", "t1");
    expect(first).toEqual([{ engineId: "codex", engineLabel: "Codex", summary: "a", at: "t1" }]);
    const second = stampEngineConfigWarnings(first, { codex: [{ summary: "a" }, { summary: "b" }] }, () => "Codex", "t2");
    expect(second.map((entry) => entry.at)).toEqual(["t1", "t2"]);
    expect(stampEngineConfigWarnings(second, {}, () => "Codex", "t3")).toEqual([]);
  });

  it("attaches engine config warnings to failed sends only", () => {
    expect(withEngineConfigWarnings({ message: "Add failed", severity: "error", source: "workspace-add" }, [warning]).context)
      .toBeUndefined();
    expect(withEngineConfigWarnings({ message: "Send failed", severity: "error", source: "send", engineId: "pi" }, [warning]).context)
      .toBeUndefined();
    const error = withEngineConfigWarnings({ message: "Send failed", severity: "error", source: "send", engineId: "codex", context: { sessionId: "s" } }, [warning]);
    expect(error.context).toEqual({ sessionId: "s", engineConfigWarnings: [
      { engineId: "codex", summary: warning.summary, details: warning.details, path: warning.path }] });
    const info = { message: "Copied" };
    expect(withEngineConfigWarnings(info, [warning])).toBe(info);
    expect(noticeEntryDetails(error)).toContain("Invalid configuration; using defaults.");
    expect(noticeEntryDetails({ message: "plain" })).toBeUndefined();
    expect(engineWarningDetails(warning)).toBe("No such file\n\n配置文件：/Users/test/.codex/config.toml");
  });
});
