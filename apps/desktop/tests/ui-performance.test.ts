import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEventTimestamp, recentUiOperations, recordUiOperation } from "../src/diagnostics/ui-performance.js";

afterEach(() => vi.restoreAllMocks());

describe("UI operation context", () => {
  it("normalizes actual DOM clock conventions without losing queue delay", () => {
    const event = new Event("beforeinput");
    const handlerAt = performance.now();
    expect(normalizeEventTimestamp(event.timeStamp, handlerAt)).toBe(event.timeStamp);
    const origin = 1_789_000_000_000;
    expect(normalizeEventTimestamp(120, 400, origin)).toBe(120);
    expect(normalizeEventTimestamp(origin + 120, 400, origin)).toBe(120);
    for (const value of [0, -1, NaN, Infinity, 401, origin - 1]) {
      expect(normalizeEventTimestamp(value, 400, origin)).toBe(400);
    }
  });

  it("bounds spans, filters small work and user text, and preserves delayed overlap context", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(20_000);
    recordUiOperation("store.flush", 19_999);
    recordUiOperation("tree.rpc", 19_951, undefined, "async");
    expect(recentUiOperations(19_000, 20_000)).toEqual([]);
    for (let index = 0; index < 200; index += 1) {
      recordUiOperation("store.flush", 19_900 + index / 10, {
        count: index, active: true, text: "private draft", key: 65, path: "private/path", title: "private title"
      });
    }
    recordUiOperation("tree.rpc", 5_000, { count: 1 }, "async");
    const spans = recentUiOperations(19_000, 20_000);
    expect(spans).toHaveLength(128);
    expect(spans[0]?.details).toEqual({ count: 73, active: true });
    expect(spans.at(-1)).toMatchObject({ name: "tree.rpc", startedAt: 5_000, durationMs: 15_000, kind: "async" });
    expect(JSON.stringify(spans)).not.toMatch(/private|"key"/);
    spans[0]!.details!.count = -1;
    expect(recentUiOperations(19_000, 20_000)[0]?.details?.count).toBe(73);
    clock.mockReturnValue(28_000);
    expect(recentUiOperations(19_800, 20_100)).toHaveLength(128);
    clock.mockReturnValue(32_000);
    recordUiOperation("render.commit", 31_990);
    expect(recentUiOperations()).toHaveLength(1);
  });
});
