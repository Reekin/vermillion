// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsWriteInputRpc } from "@vermillion/shared";
import { createBoundedDiagnosticWriter, useRendererDiagnostics } from "../src/ui/chat-shell/use-renderer-diagnostics.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
      { kind: "renderer-stall", severity: "warning", context: { huge: "x".repeat(5_000) } },
      { cooldownKey: "stall", cooldownMs: 60_000 }
    );
    writer.write({ kind: "renderer-stall", severity: "warning" }, { cooldownKey: "stall" });
    writer.write({ kind: "renderer-heartbeat", severity: "info", message: "first pending" });
    writer.write({ kind: "renderer-heartbeat", severity: "info", message: "latest pending" });

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
    writer.write({ kind: "renderer-stall", severity: "warning" }, { cooldownKey: "stall" });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    writer.dispose();
  });
});

describe("renderer input monitoring", () => {
  it("measures queue and frame separately, counts suppressed IME inputs, and cancels pending frames", async () => {
    let now = 500;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const intervals = new Map<number, () => void>();
    let frame: (() => void) | undefined;
    const cancelAnimationFrame = vi.fn();
    const writes: DiagnosticsWriteInputRpc[] = [];
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(window, "setInterval").mockImplementation((fn, ms) => {
      intervals.set(ms!, fn as () => void);
      return ms! as unknown as ReturnType<typeof window.setInterval>;
    });
    const clearInterval = vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => { frame = () => fn(now); return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelAnimationFrame);
    const removeListener = vi.spyOn(window, "removeEventListener");
    let observeEntries: (list: { getEntries: () => PerformanceEntry[] }) => void;
    const disconnect = vi.fn();
    vi.stubGlobal("PerformanceObserver", class {
      static supportedEntryTypes = ["longtask"];
      constructor(callback: typeof observeEntries) { observeEntries = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const transport = { diagnostics: { write: vi.fn(async (entry: DiagnosticsWriteInputRpc) => { writes.push(entry); }) } };
    const view = renderHook(() => useRendererDiagnostics({ transport: transport as never }));
    const input = (type: string, timestamp: number) => {
      const event = new Event(type);
      Object.defineProperties(event, { timeStamp: { value: timestamp }, data: { value: "PRIVATE" }, key: { value: "SECRET" } });
      window.dispatchEvent(event);
    };
    try {
      input("beforeinput", 300);
      input("compositionupdate", performance.timeOrigin + 310);
      now = 520;
      frame!();
      await waitFor(() => expect(writes[0]?.metrics).toMatchObject({ queueDelayMs: 200, frameDelayMs: 20, delayMs: 220, startTimeMs: 300, timeOriginMs: performance.timeOrigin, inputCount: 2 }));
      expect(writes[0]?.context).toMatchObject({ eventType: "beforeinput", recentOperations: [] });
      now = 700;
      input("compositionend", 600);
      now = 720;
      frame!();
      intervals.get(30_000)!();
      await waitFor(() => expect(writes.at(-1)?.kind).toBe("renderer-heartbeat"));
      expect(writes.filter((entry) => entry.kind === "ui-input-delay")).toHaveLength(1);
      expect(writes.at(-1)?.metrics).toMatchObject({ inputCount: 3, delayedQueueInputCount: 3, delayedInputFrameCount: 2, droppedByCooldown: 1 });
      expect(JSON.stringify(writes)).not.toMatch(/PRIVATE|SECRET/);
      const longTask = { name: "self", entryType: "longtask", startTime: 500, duration: 110, attribution: [{ name: "unknown", entryType: "taskattribution", startTime: 0, duration: 0, containerSrc: "PRIVATE" }] } as unknown as PerformanceEntry;
      observeEntries!({ getEntries: () => [longTask, longTask] });
      await waitFor(() => expect(writes.at(-1)?.kind).toBe("renderer-long-task"));
      expect(writes.at(-1)).toMatchObject({ kind: "renderer-long-task", metrics: { durationMs: 110, startTimeMs: 500, timeOriginMs: performance.timeOrigin }, context: { recentOperations: [], attribution: [{ name: "unknown" }] } });
      intervals.get(30_000)!();
      await waitFor(() => expect(writes.at(-1)?.kind).toBe("renderer-heartbeat"));
      expect(writes.at(-1)?.metrics).toMatchObject({ longTaskCount: 2, totalLongTaskDurationMs: 220, droppedByCooldown: 1 });
      expect(JSON.stringify(writes)).not.toContain("PRIVATE");
      input("keydown", 710);
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      const beforeHidden = writes.length;
      now += 60_000;
      intervals.get(1_000)!();
      input("keydown", 710);
      expect(writes).toHaveLength(beforeHidden);
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      intervals.get(1_000)!();
      expect(writes).toHaveLength(beforeHidden);
    } finally {
      view.unmount();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
      for (const name of ["pointerdown", "keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
        expect(removeListener).toHaveBeenCalledWith(name, expect.any(Function), { capture: true });
      }
      expect(clearInterval).toHaveBeenCalledWith(1_000);
      expect(clearInterval).toHaveBeenCalledWith(30_000);
      expect(disconnect).toHaveBeenCalledOnce();
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
