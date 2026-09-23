import { describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@vermillion/shared";
import { createRendererStore } from "../src/store/store.js";
import { connectDesktopTransportToStore } from "../src/transport/store-bridge.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";

describe("history confirmation on reconnect", () => {
  it("invalidates before requesting a gap recovery snapshot, including snapshot failure", async () => {
    const store = createRendererStore();
    store.hydrateSessionWindows([{ sessionId: "a", snapshot: parseDomainSnapshot({}), replaceSessionHistory: true, revision: "epoch", cursor: "cursor-1" }]);
    const snapshot = vi.fn(async () => {
      expect(store.getKnownSessionWindows()).toEqual({});
      throw new Error("offline");
    });
    const transport = { events: { replay: vi.fn(async () => ({ status: "gap", envelopes: [] })) }, domain: { snapshot } } as unknown as DesktopTransport;
    await expect(connectDesktopTransportToStore({ transport, store, fromCursor: "cursor-1", hydrateSnapshot: false })).rejects.toThrow("offline");
    expect(store.getKnownSessionWindows()).toEqual({});
  });

  it("keeps complete baselines through gap-free replay", async () => {
    const store = createRendererStore();
    store.ingestEvent({ type: "session.created", sessionId: "a", conversationId: "c", engineId: "e", status: "idle" });
    store.hydrateSessionWindows([{ sessionId: "a", snapshot: parseDomainSnapshot({}), replaceSessionHistory: true, revision: "epoch", cursor: "cursor-1" }]);
    const transport = { events: {
      replay: vi.fn(async () => ({ status: "ok", envelopes: [{ eventId: "2", cursor: "cursor-2", occurredAt: "2026-09-22T00:00:00Z", event: { type: "message.delta", sessionId: "a", turnId: "t", messageId: "m", delta: "retained" } }] })),
      subscribe: vi.fn(async () => ({ subscriptionId: "test", unsubscribe: async () => {} }))
    } } as unknown as DesktopTransport;
    await connectDesktopTransportToStore({ transport, store, fromCursor: "cursor-1", hydrateSnapshot: false });
    expect(store.getKnownSessionWindows()).toEqual({ a: { revision: "epoch", cursor: "cursor-2" } });
    expect(store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe("retained");
  });
});
