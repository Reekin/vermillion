import { describe, expect, it, vi } from "vitest";
import { createCoalescedRefresh } from "../src/ui/chat-shell/coalesced-refresh.js";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("chat tree refresh ownership", () => {
  it("coalesces notifications before the read into the same request", async () => {
    const refresh = createCoalescedRefresh();
    const opened = deferred();
    const read = vi.fn();
    const run = vi.fn(async (_signal, consumePending) => {
      await opened.promise;
      consumePending();
      read();
    });
    const first = refresh.request(run);
    expect(refresh.request(run)).toBe(first);
    expect(refresh.request(run)).toBe(first);
    opened.resolve();
    await first;
    expect(read).toHaveBeenCalledOnce();
  });

  it("runs one trailing read for any number of during-read notifications", async () => {
    const refresh = createCoalescedRefresh();
    const response = deferred();
    const run = vi.fn(async (_signal, consumePending) => {
      consumePending();
      await response.promise;
    });
    const first = refresh.request(run);
    refresh.request(run);
    refresh.request(run);
    expect(run).toHaveBeenCalledOnce();
    response.resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("isolates returning targets from late failures and old finally cleanup", async () => {
    const refresh = createCoalescedRefresh();
    const old = deferred();
    let oldSignal!: AbortSignal;
    const first = refresh.request(async (signal) => { oldSignal = signal; await old.promise; });
    refresh.cancel();
    const next = deferred();
    const run = vi.fn(async () => { await next.promise; });
    const second = refresh.request(run);
    old.reject(new Error("old target failed"));
    await expect(first).resolves.toBeUndefined();
    expect(oldSignal.aborted).toBe(true);
    expect(refresh.request(run)).toBe(second);
    next.resolve();
    await second;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not poll when a completed refresh receives no invalidation", async () => {
    const refresh = createCoalescedRefresh();
    const run = vi.fn(async () => {});
    await refresh.request(run);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
  });
});
