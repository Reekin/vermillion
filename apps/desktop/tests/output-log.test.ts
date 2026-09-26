import { describe, expect, it } from "vitest";
import {
  OUTPUT_LOG_LIMIT,
  appendOutputEntry,
  countOutput,
  createOutputStore,
  engineWarningDetails,
  matchesOutputFilter,
  markOutputSeen,
  outputEntryDetails,
  stampEngineConfigWarnings,
  statusBarDismissDelayMs,
  withEngineConfigWarnings,
  type OutputEntry
} from "../src/ui/app/output-log.js";

const at = "2026-09-26T08:00:00.000Z";
const warning = { engineId: "codex", engineLabel: "Codex", at, summary: "Invalid configuration; using defaults.",
  details: "No such file", path: "/Users/test/.codex/config.toml" };

describe("output log", () => {
  it("lists newest first and merges repeats into one counted entry", () => {
    let log: OutputEntry[] = [];
    log = appendOutputEntry(log, { message: "Send failed", severity: "error", source: "send" }, "t1", "a");
    log = appendOutputEntry(log, { message: "Copied" }, "t2", "b");
    log = appendOutputEntry(log, { message: "Send failed", severity: "error", source: "send" }, "t3", "c");
    expect(log.map((entry) => [entry.id, entry.count, entry.at])).toEqual([["a", 2, "t3"], ["b", 1, "t2"]]);
    expect(log[0]?.seen).toBe(false);
    expect(log[1]?.seen).toBe(true);
    expect(markOutputSeen(log).every((entry) => entry.seen)).toBe(true);
  });

  it("keeps a bounded history", () => {
    let log: OutputEntry[] = [];
    for (let index = 0; index < OUTPUT_LOG_LIMIT + 5; index += 1) log = appendOutputEntry(log, { message: `n${index}` }, at, `id-${index}`);
    expect(log).toHaveLength(OUTPUT_LOG_LIMIT);
    expect(log[0]?.id).toBe(`id-${OUTPUT_LOG_LIMIT + 4}`);
  });

  it("counts engine warnings with warnings and filters by level and text", () => {
    const log = appendOutputEntry([], { message: "Send failed", severity: "error", source: "send" }, at, "a");
    expect(countOutput(log, [warning])).toEqual({ error: 1, warning: 1, info: 0 });
    const filter = { severities: new Set(["error"] as const), text: "send" };
    expect(matchesOutputFilter(filter, "error", ["Send failed"])).toBe(true);
    expect(matchesOutputFilter(filter, "warning", ["Send failed"])).toBe(false);
    expect(matchesOutputFilter({ ...filter, text: "copy" }, "error", ["Send failed"])).toBe(false);
  });

  it("dismisses only informational notices from the status bar on a timer", () => {
    const [info] = appendOutputEntry([], { message: "Copied" }, at, "a");
    const [error] = appendOutputEntry([], { message: "Failed", severity: "error", persistent: true }, at, "b");
    expect(statusBarDismissDelayMs(info!)).toBeGreaterThan(0);
    expect(statusBarDismissDelayMs(error!)).toBeUndefined();
  });

  it("clears events but keeps current problems, and opening marks errors seen and hides them from the status bar", () => {
    const store = createOutputStore(() => at);
    store.getState().setWarnings({ codex: [{ summary: "bad config" }] }, () => "Codex");
    store.getState().report({ message: "Send failed", severity: "error", source: "send", engineId: "codex" });
    expect(store.getState().latestId).toBeDefined();
    expect(outputEntryDetails(store.getState().entries[0]!)).toContain("bad config");
    store.getState().setOpen(true);
    expect(store.getState().latestId).toBeUndefined();
    expect(store.getState().entries.every((entry) => entry.seen)).toBe(true);
    store.getState().clear();
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().warnings).toHaveLength(1);
  });

  it("stamps warnings once and keeps the first receipt time while they persist", () => {
    const first = stampEngineConfigWarnings([], { codex: [{ summary: "a" }] }, () => "Codex", "t1");
    const second = stampEngineConfigWarnings(first, { codex: [{ summary: "a" }, { summary: "b" }] }, () => "Codex", "t2");
    expect(second.map((entry) => entry.at)).toEqual(["t1", "t2"]);
    expect(stampEngineConfigWarnings(second, {}, () => "Codex", "t3")).toEqual([]);
  });

  it("attaches the sending engine's warnings to failed sends only", () => {
    expect(withEngineConfigWarnings({ message: "Add failed", severity: "error", source: "workspace-add", engineId: "codex" }, [warning]).context).toBeUndefined();
    expect(withEngineConfigWarnings({ message: "Send failed", severity: "error", source: "send", engineId: "pi" }, [warning]).context).toBeUndefined();
    const error = withEngineConfigWarnings({ message: "Send failed", severity: "error", source: "send", engineId: "codex" }, [warning]);
    expect(error.context).toEqual({ engineConfigWarnings: [{ engineId: "codex", summary: warning.summary, details: warning.details, path: warning.path }] });
    expect(engineWarningDetails(warning)).toBe("No such file\n\n配置文件：/Users/test/.codex/config.toml");
  });
});
