import { describe, expect, it } from "vitest";
import { parseDomainSnapshot, type RuntimeEvent } from "@vermillion/shared";
import { createRendererStore } from "../src/store/store.js";

const time = "2026-09-22T00:00:00Z";
const metadata = {
  conversations: [{ conversationId: "c", participantEngineIds: ["e"], sessionIds: ["s"], createdAt: time, updatedAt: time }],
  sessions: [{ sessionId: "s", conversationId: "c", engineId: "e", status: "running", createdAt: time, updatedAt: time }]
};
const snapshot = () => parseDomainSnapshot({ ...metadata,
  turns: [{ turnId: "old", sessionId: "s", status: "completed", startedAt: time },
    { turnId: "live", sessionId: "s", status: "streaming", startedAt: time }],
  messageBlocks: [{ blockId: "old:md", messageId: "old", turnId: "old", sessionId: "s", role: "assistant", kind: "markdown", text: "cold history", startedAt: time },
    { blockId: "m:md", messageId: "m", turnId: "live", sessionId: "s", role: "assistant", kind: "markdown", text: "prefix ", startedAt: time }]
});
const fixture = () => {
  const store = createRendererStore();
  store.hydrateSnapshot(parseDomainSnapshot(metadata), "1");
  const emit = (cursor: number, event: RuntimeEvent) => store.ingestEnvelope({ eventId: `e${cursor}`, cursor: String(cursor), occurredAt: time, event });
  const delta = (cursor: number, text: string) => emit(cursor, { type: "message.delta", sessionId: "s", turnId: "live", messageId: "m", delta: text });
  const window = () => ({ sessionId: "s", snapshot: snapshot(), cursor: "10", revision: "history", replaceSessionHistory: true });
  return { store, emit, delta, window };
};

describe("in-flight history snapshot and event tail", () => {
  it("fills a cold baseline in one commit while output keeps overtaking the response", () => {
    const f = fixture();
    const finish = f.store.beginSessionWindowRead("read");
    f.emit(11, { type: "message.started", sessionId: "s", turnId: "live", messageId: "m", role: "assistant" });
    for (let cursor = 12; cursor < 32; cursor++) f.delta(cursor, `${cursor} `);
    const seen: string[] = [];
    const unsubscribe = f.store.subscribeSession("s", () => seen.push(f.store.getDomainReadModel().getMessageBlock("m:md")?.text ?? ""));
    f.store.hydrateSessionWindows([f.window()], "read");
    const expected = `prefix ${Array.from({ length: 20 }, (_, i) => `${i + 12} `).join("")}`;
    expect(f.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe(expected);
    expect(f.store.getDomainReadModel().getMessageBlock("old:md")?.text).toBe("cold history");
    expect(seen).toEqual([expected]);
    expect(f.store.getKnownSessionWindows()).toEqual({ s: { revision: "history", cursor: "31" } });
    finish();
    f.delta(32, "continues");
    expect(f.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe(expected + "continues");
    expect(f.store.getKnownSessionWindows().s.cursor).toBe("32");
    unsubscribe();
  });

  it("does not replay events already contained in the snapshot", () => {
    const f = fixture();
    const finish = f.store.beginSessionWindowRead("read");
    f.delta(8, "prefix ");
    f.delta(12, "tail");
    f.store.hydrateSessionWindows([f.window()], "read");
    expect(f.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe("prefix tail");
    finish();
  });

  it("discarded or reset reads cannot certify an older snapshot", () => {
    const f = fixture();
    const finish = f.store.beginSessionWindowRead("cancelled");
    f.delta(12, "live");
    finish();
    f.store.hydrateSessionWindows([f.window()], "cancelled");
    expect(f.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe("live");
    expect(f.store.getKnownSessionWindows()).toEqual({});
    f.store.beginSessionWindowRead("gap");
    f.store.clearKnownSessionWindows();
    f.delta(13, " newer");
    f.store.hydrateSessionWindows([f.window()], "gap");
    expect(f.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe("live newer");
  });
});
