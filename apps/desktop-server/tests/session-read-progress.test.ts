import { describe, expect, it } from "vitest";
import { SessionReadProgressTracker } from "../src/session-read-progress.js";
import { beginSessionStage, reportSessionReadCounts, sessionStage, traceSessionRead } from "../src/session-load-trace.js";
import type { SessionReadProgress } from "@vermillion/shared";

describe("request scoped loading progress", () => {
  it("returns to the remaining engine wait after a parallel conversion completes", () => {
    const values: SessionReadProgress[] = [];
    const tracker = new SessionReadProgressTracker("r", "s", (value) => values.push(value));
    tracker.counts(0, 16);
    tracker.stage({ spanId: "engine", stage: "engine.rpc", phase: "begin", fields: { method: "thread/resume" } });
    tracker.stage({ spanId: "convert", stage: "history.convert", phase: "begin", fields: {} });
    expect(tracker.value.stage).toBe("converting");
    tracker.stage({ spanId: "convert", stage: "history.convert", phase: "end", fields: {} });
    tracker.counts(7, 16);
    expect(tracker.value).toMatchObject({ stage: "waiting-engine", completed: 7, total: 16 });
    const count = values.length;
    tracker.stage({ spanId: "unrelated", stage: "engine.rpc", phase: "sent", fields: {} });
    expect(values).toHaveLength(count);
  });
  it("excludes background recovery and keeps counts on their own read", async () => {
    const values: SessionReadProgress[] = [];
    const progress = new SessionReadProgressTracker("r", "s", (value) => values.push(value));
    await traceSessionRead("r", "s", () => {}, async () => {
      reportSessionReadCounts(0, 3);
      await sessionStage("execution.recovery", { background: true }, async () => {
        beginSessionStage("engine.rpc", { method: "thread/resume" }).emit("end");
      });
      reportSessionReadCounts(3, 3);
    }, progress);
    expect(values.some((value) => value.stage === "waiting-engine")).toBe(false);
    expect(progress.value.completed).toBe(3);
  });
});
