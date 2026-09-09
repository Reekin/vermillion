import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsWriteInputRpc } from "@vermillion/shared";
import { createBoundedDiagnosticWriter, useRendererDiagnostics } from "../src/ui/chat-shell/use-renderer-diagnostics.js";

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect)
}));

describe("renderer diagnostics writer", () => {
  it("allows one write in flight, coalesces pending entries, and enforces cooldown", async () => {
    const resolvers: Array<() => void> = [];
    const writes: DiagnosticsWriteInputRpc[] = [];
    const write = vi.fn((entry: DiagnosticsWriteInputRpc) => {
      writes.push(entry);
      return new Promise<{ logged: true; entryId: string; logPath: string }>((resolve) => {
        resolvers.push(() => resolve({ logged: true, entryId: "entry", logPath: "log" }));
      });
    });
    let nowMs = 1_000;
    const writer = createBoundedDiagnosticWriter({
      transport: { diagnostics: { write } } as never,
      getContext: () => ({ activeSessionId: "session-1" }),
      nowMs: () => nowMs,
      maxBytes: 1_024
    });

    writer.write(
      { kind: "renderer-stall", context: { huge: "x".repeat(5_000) } },
      { cooldownKey: "stall", cooldownMs: 60_000 }
    );
    writer.write({ kind: "renderer-stall" }, { cooldownKey: "stall" });
    writer.write({ kind: "renderer-heartbeat", message: "first pending" });
    writer.write({ kind: "renderer-heartbeat", message: "latest pending" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(new TextEncoder().encode(JSON.stringify(writes[0])).byteLength).toBeLessThanOrEqual(
      1_024
    );
    expect(writes[0]?.context).toMatchObject({ truncated: true });
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(writes[1]).toMatchObject({
      kind: "renderer-heartbeat",
      message: "latest pending",
      sessionId: "session-1",
      metrics: {
        droppedByCooldown: 1,
        droppedByOverwrite: 1
      }
    });

    nowMs += 60_000;
    resolvers.shift()?.();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    writer.write({ kind: "renderer-stall" }, { cooldownKey: "stall" });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    writer.dispose();
  });
});

describe("renderer input monitoring", () => {
  it("measures queue and frame separately, counts suppressed IME inputs, and cancels pending frames", async () => {
    let now = 500;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const listeners = new Map<string, (event: Event) => void>();
    const intervals = new Map<number, () => void>();
    let frame: (() => void) | undefined;
    const cancelAnimationFrame = vi.fn();
    const writes: DiagnosticsWriteInputRpc[] = [];
    vi.stubGlobal("Element", class {});
    const page = { visibilityState: "visible",
      addEventListener: (name: string, fn: (event: Event) => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name)
    };
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", {
      performance,
      location: { href: "http://localhost" },
      setInterval: (fn: () => void, ms: number) => { intervals.set(ms, fn); return ms; },
      clearInterval: vi.fn(),
      addEventListener: (name: string, fn: (event: Event) => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
      requestAnimationFrame: (fn: () => void) => { frame = fn; return 1; },
      cancelAnimationFrame
    });
    let observeEntries: (list: { getEntries: () => PerformanceEntry[] }) => void;
    const disconnect = vi.fn();
    vi.stubGlobal("PerformanceObserver", class {
      static supportedEntryTypes = ["longtask"];
      constructor(callback: typeof observeEntries) { observeEntries = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const transport = { diagnostics: { write: vi.fn(async (entry: DiagnosticsWriteInputRpc) => { writes.push(entry); }) } };
    effects.length = 0;
    useRendererDiagnostics({ transport: transport as never });
    const cleanups = effects.map((effect) => effect());
    const input = (type: string, timestamp: number) => listeners.get(type)!({ type, timeStamp: timestamp, target: null, data: "PRIVATE", key: "SECRET" } as unknown as Event);
    try {
      input("beforeinput", 300);
      input("compositionupdate", performance.timeOrigin + 310);
      now = 520;
      frame!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes[0]?.metrics).toMatchObject({ queueDelayMs: 200, frameDelayMs: 20, delayMs: 220, startTimeMs: 300, timeOriginMs: performance.timeOrigin, inputCount: 2 });
      expect(writes[0]?.context).toMatchObject({ eventType: "beforeinput", recentOperations: [] });
      now = 700;
      input("compositionend", 600);
      now = 720;
      frame!();
      intervals.get(30_000)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes.filter((entry) => entry.kind === "ui-input-delay")).toHaveLength(1);
      expect(writes.at(-1)?.metrics).toMatchObject({ inputCount: 3, delayedQueueInputCount: 3, delayedInputFrameCount: 2, droppedByCooldown: 1 });
      expect(JSON.stringify(writes)).not.toMatch(/PRIVATE|SECRET/);
      const longTask = { name: "self", entryType: "longtask", startTime: 500, duration: 110, attribution: [{ name: "unknown", entryType: "taskattribution", startTime: 0, duration: 0, containerSrc: "PRIVATE" }] } as unknown as PerformanceEntry;
      observeEntries!({ getEntries: () => [longTask, longTask] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes.at(-1)).toMatchObject({ kind: "renderer-long-task", metrics: { durationMs: 110, startTimeMs: 500, timeOriginMs: performance.timeOrigin }, context: { recentOperations: [], attribution: [{ name: "unknown" }] } });
      intervals.get(30_000)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes.at(-1)?.metrics).toMatchObject({ longTaskCount: 2, totalLongTaskDurationMs: 220, droppedByCooldown: 1 });
      expect(JSON.stringify(writes)).not.toContain("PRIVATE");
      input("keydown", 710);
      page.visibilityState = "hidden";
      listeners.get("visibilitychange")!({} as Event);
      const beforeHidden = writes.length;
      now += 60_000;
      intervals.get(1_000)!();
      input("keydown", 710);
      expect(writes).toHaveLength(beforeHidden);
      page.visibilityState = "visible";
      listeners.get("visibilitychange")!({} as Event);
      intervals.get(1_000)!();
      expect(writes).toHaveLength(beforeHidden);
    } finally {
      for (const cleanup of cleanups) cleanup?.();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
      expect(listeners.size).toBe(0);
      expect(disconnect).toHaveBeenCalledOnce();
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
