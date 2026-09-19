import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STREAM_EVENT_CHUNK_LENGTH, type EventEnvelope } from "@vermillion/shared";
import { StreamEventAggregator } from "../src/runtime/stream-event-aggregator.js";

const message = (sessionId: string, delta: string, eventId: string): EventEnvelope => ({
  eventId,
  occurredAt: "2026-09-20T00:00:00.000Z",
  event: {
    type: "message.delta",
    sessionId,
    turnId: `turn-${sessionId}`,
    messageId: `message-${sessionId}`,
    delta
  }
});

const tool = (sessionId: string, eventId: string): EventEnvelope => ({
  eventId,
  occurredAt: "2026-09-20T00:00:00.001Z",
  event: {
    type: "tool.delta",
    sessionId,
    turnId: `turn-${sessionId}`,
    toolCallId: `tool-${sessionId}`,
    delta: "progress"
  }
});

describe("StreamEventAggregator", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps unrelated session streams aggregated across tool events", () => {
    vi.useFakeTimers();
    const emitted: EventEnvelope[] = [];
    const aggregator = new StreamEventAggregator((event) => emitted.push(event));
    for (let session = 0; session < 50; session += 1) {
      aggregator.push(message(`session-${session}`, "a", `a-${session}`));
    }
    for (let event = 0; event < 20; event += 1) {
      aggregator.push(tool("session-0", `tool-${event}`));
    }
    for (let session = 0; session < 50; session += 1) {
      aggregator.push(message(`session-${session}`, "b", `b-${session}`));
    }
    aggregator.flush();

    const deltas = emitted.filter((envelope) => envelope.event.type === "message.delta");
    expect(deltas).toHaveLength(51);
    expect(deltas.filter((envelope) => envelope.event.sessionId === "session-0")).toHaveLength(2);
    expect(deltas.filter((envelope) => envelope.event.sessionId !== "session-0").every(
      (envelope) => envelope.event.type === "message.delta" && envelope.event.delta === "ab"
    )).toBe(true);
  });

  it("flushes only the full stream target and preserves per-session barriers", () => {
    const emitted: EventEnvelope[] = [];
    const aggregator = new StreamEventAggregator((event) => emitted.push(event));
    aggregator.push(message("session-a", "x".repeat(MAX_STREAM_EVENT_CHUNK_LENGTH), "full-a"));
    aggregator.push(message("session-b", "before", "before-b"));
    aggregator.push(tool("session-a", "tool-a"));
    expect(emitted.map((envelope) => envelope.event.type)).toEqual([
      "message.delta",
      "tool.delta"
    ]);

    aggregator.push(tool("session-b", "tool-b"));
    expect(emitted.slice(-2).map((envelope) => envelope.event.type)).toEqual([
      "message.delta",
      "tool.delta"
    ]);
    expect(emitted.at(-2)?.event).toMatchObject({ sessionId: "session-b", delta: "before" });
  });

  it("flushes every pending session on dispose", () => {
    const emitted: EventEnvelope[] = [];
    const aggregator = new StreamEventAggregator((event) => emitted.push(event));
    aggregator.push(message("session-a", "a", "a"));
    aggregator.push(message("session-b", "b", "b"));
    aggregator.dispose();
    expect(emitted.map((envelope) => envelope.event)).toEqual([
      expect.objectContaining({ sessionId: "session-a", delta: "a" }),
      expect.objectContaining({ sessionId: "session-b", delta: "b" })
    ]);
  });
});
