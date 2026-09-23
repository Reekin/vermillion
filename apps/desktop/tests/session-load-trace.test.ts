import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSessionLoad, sessionContentCommitted, sessionLoadMark } from "../src/diagnostics/session-load-trace.js";

afterEach(() => vi.unstubAllGlobals());
describe("session click diagnostics", () => {
  it("records click, commit and a frame separately and suppresses duplicate commits", () => {
    const write = vi.fn(async () => {});
    let frame!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; });
    vi.stubGlobal("document", { visibilityState: "visible" });
    beginSessionLoad("s", write, "sidebar");
    sessionContentCommitted("s", 5);
    sessionContentCommitted("s", 5);
    expect(write.mock.calls.map(([entry]) => entry.context.stage)).toEqual(["navigation.click", "content.commit"]);
    frame(0);
    expect(write.mock.calls.at(-1)?.[0].context.stage).toBe("content.frame");
  });

  it("retains the original click on late work and does not attribute its frame to a new target", () => {
    const write = vi.fn(async () => {});
    let frame!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const first = beginSessionLoad("a", write, "sidebar");
    sessionContentCommitted("a", 1);
    beginSessionLoad("b", write, "sidebar");
    frame(0);
    sessionLoadMark(first, "rpc.end", { outcome: "cancelled" });
    expect(write.mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: "a", context: { traceId: first.id } });
    expect(write.mock.calls.some(([entry]) => entry.context.stage === "content.frame")).toBe(false);
  });
});
