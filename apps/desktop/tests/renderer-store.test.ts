import { describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot, type EventEnvelope } from "@vermillion/shared";
import { selectSessionsForConversation } from "../src/store/selectors.js";
import { createRendererStore } from "../src/store/store.js";

const now = "2026-04-21T00:00:00.000Z";

const sessionSnapshot = () =>
  parseDomainSnapshot({
    conversations: [
      {
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        activeSessionId: "session-a",
        sessionIds: ["session-a"],
        createdAt: now,
        updatedAt: now
      }
    ],
    sessions: [
      {
        sessionId: "session-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "idle",
        title: "Initial session",
        createdAt: now,
        updatedAt: now
      }
    ],
    participants: [
      {
        participantId: "conversation-a:agent-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        role: "primary",
        capabilities: ["chat"],
        activeSessionIds: ["session-a"]
      }
    ]
  });

const envelope = (eventId: string): EventEnvelope => ({
  eventId,
  cursor: "cursor-1",
  occurredAt: now,
  event: {
    type: "session.created",
    conversationId: "conversation-b",
    sessionId: "session-b",
    engineId: "agent-b",
    status: "idle"
  }
});

describe("renderer store domain replica", () => {
  it("confirms only complete versioned history and advances only that member's applied cursor", () => {
    const store = createRendererStore();
    const window = { sessionId: "session-a", snapshot: sessionSnapshot(), cursor: "cursor-1", revision: "epoch-a", replaceSessionHistory: true };
    store.hydrateSessionWindows([window]);
    expect(store.getKnownSessionWindows()).toEqual({ "session-a": { revision: "epoch-a", cursor: "cursor-1" } });
    store.ingestEnvelope({ ...envelope("other"), cursor: "cursor-9" });
    expect(store.getKnownSessionWindows()["session-a"]?.cursor).toBe("cursor-1");
    store.ingestEnvelope({ eventId: "own", cursor: "cursor-10", occurredAt: now, event: { type: "message.delta", sessionId: "session-a", turnId: "turn-a", messageId: "message-a", delta: "live" } });
    expect(store.getKnownSessionWindows()["session-a"]?.cursor).toBe("cursor-10");
    store.hydrateSessionWindows([{ ...window, revision: "stale-epoch", cursor: "cursor-2" }]);
    expect(store.getKnownSessionWindows()["session-a"]?.revision).toBe("epoch-a");
    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe("live");
    store.hydrateSessionWindows([{ ...window, cursor: "cursor-11", replaceSessionHistory: false }]);
    expect(store.getKnownSessionWindows()).toEqual({});
  });

  it("clears confirmations on unversioned replacement, reset, gap and disposal", () => {
    const store = createRendererStore();
    const window = { sessionId: "session-a", snapshot: sessionSnapshot(), cursor: "cursor-1", revision: "epoch-a", replaceSessionHistory: true };
    const confirm = () => { store.hydrateSessionWindows([window]); expect(store.getKnownSessionWindows()["session-a"]).toBeDefined(); };
    confirm();
    store.hydrateSessionWindow("session-a", sessionSnapshot(), "replace", "cursor-1", true);
    expect(store.getKnownSessionWindows()).toEqual({});
    confirm();
    store.clearKnownSessionWindows();
    expect(store.getKnownSessionWindows()).toEqual({});
    confirm();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    expect(store.getKnownSessionWindows()).toEqual({});
    confirm();
    store.disposeSession("session-a");
    expect(store.getKnownSessionWindows()).toEqual({});
    const empty = createRendererStore();
    empty.ingestEnvelope({ ...envelope("only-event"), cursor: "cursor-8" });
    expect(empty.getKnownSessionWindows()).toEqual({});
  });

  it("does not invalidate chat history when activation refreshes the session list", () => {
    const store = createRendererStore();
    const before = store.getState().refreshSignals;
    store.dispatch({ type: "store/sessionBrowserChanged" });
    const after = store.getState().refreshSignals;
    expect(after.sessionBrowser).toBe(before.sessionBrowser + 1);
    expect(after.chatTree).toBe(before.chatTree);
  });

  it("accepts a replaced history epoch even when no new stream event occurred", () => {
    const store = createRendererStore();
    const window = { sessionId: "session-a", snapshot: sessionSnapshot(), cursor: "cursor-1", revision: "epoch-a", replaceSessionHistory: true };
    store.hydrateSessionWindows([window]);
    store.hydrateSessionWindows([{ ...window, revision: "epoch-b" }]);
    expect(store.getKnownSessionWindows()["session-a"]).toEqual({ revision: "epoch-b", cursor: "cursor-1" });
  });

  it("hydrates a cold ancestor and its replacement while a sibling in the same conversation streams", () => {
    const store = createRendererStore();
    store.ingestEvent({ type: "session.created", conversationId: "conversation-a", sessionId: "session-b", engineId: "agent-a", status: "idle" });
    const stream = (cursor: string) => store.ingestEnvelope({ eventId: cursor, cursor, occurredAt: now, event: { type: "message.delta", sessionId: "session-b", turnId: "turn-b", messageId: "message-b", delta: "live" } });
    stream("cursor-10");
    const ancestor = sessionSnapshot();
    ancestor.turns.push({ turnId: "ancestor-turn", sessionId: "session-a", status: "completed", startedAt: now, messageIds: [], toolCallIds: [], terminalIds: [], approvalRequestIds: [], interactionRequestIds: [] });
    const window = { sessionId: "session-a", snapshot: ancestor, cursor: "cursor-5", revision: "ancestor-a", replaceSessionHistory: true };
    store.hydrateSessionWindows([window]);
    expect(store.getKnownSessionWindows()["session-a"]).toEqual({ revision: "ancestor-a", cursor: "cursor-5" });
    expect(store.getDomainReadModel().getTurn("ancestor-turn")).toBeDefined();
    stream("cursor-20");
    store.hydrateSessionWindows([{ ...window, snapshot: sessionSnapshot(), cursor: "cursor-15", revision: "ancestor-b" }]);
    expect(store.getKnownSessionWindows()["session-a"]).toEqual({ revision: "ancestor-b", cursor: "cursor-15" });
    expect(store.getDomainReadModel().getTurn("ancestor-turn")).toBeUndefined();
    expect(store.getDomainReadModel().getMessageBlock("message-b:md")?.text).toBe("livelive");
  });

  it("leaves a stale same-member response unconfirmed until a fresh complete window arrives", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    store.ingestEnvelope({ eventId: "new", cursor: "cursor-10", occurredAt: now, event: { type: "message.delta", sessionId: "session-a", turnId: "turn-a", messageId: "message-a", delta: "live" } });
    const window = { sessionId: "session-a", snapshot: sessionSnapshot(), cursor: "cursor-5", revision: "epoch", replaceSessionHistory: true };
    store.hydrateSessionWindows([window]);
    expect(store.getKnownSessionWindows()).toEqual({});
    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe("live");
    store.hydrateSessionWindows([{ ...window, cursor: "cursor-10" }]);
    expect(store.getKnownSessionWindows()["session-a"]).toEqual({ revision: "epoch", cursor: "cursor-10" });
  });

  it("keeps background and later-turn streams outside visible turn notifications while retaining content", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot());
    store.ingestEvent({ type: "session.created", conversationId: "conversation-a", sessionId: "session-b", engineId: "agent-a", status: "idle" });
    const visible = vi.fn();
    const dispose = store.subscribeTurn("turn-visible", visible);
    const meta = vi.fn();
    store.subscribeMeta(meta);
    for (const [sessionId, turnId] of [["session-a", "turn-later"], ["session-b", "turn-background"]]) {
      store.ingestEvent({ type: "message.delta", sessionId, turnId, messageId: turnId, delta: "retained" });
      expect(store.getDomainReadModel().getMessageBlock(turnId + ":md")?.text).toBe("retained");
    }
    expect(visible).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
    store.ingestEvent({ type: "message.delta", sessionId: "session-a", turnId: "turn-visible", messageId: "visible", delta: "live" });
    expect(visible).toHaveBeenCalledOnce();
    dispose();
    store.ingestEvent({ type: "message.delta", sessionId: "session-a", turnId: "turn-visible", messageId: "visible", delta: " content" });
    expect(visible).toHaveBeenCalledOnce();
    expect(store.getDomainReadModel().getMessageBlock("visible:md")?.text).toBe("live content");
  });

  it("exposes a read model backed by renderer domain state", () => {
    const store = createRendererStore();
    const initialSnapshot = store.getSubscriptionSnapshot();

    expect(store.getRevision()).toBe(0);
    expect(initialSnapshot.revision).toBe(0);
    expect(store.getDomainReadModel()).toBe(initialSnapshot.domain);
    expect(store.getDomainReadModel().listSessions()).toEqual([]);

    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");

    const subscriptionSnapshot = store.getSubscriptionSnapshot();
    expect(subscriptionSnapshot).not.toBe(initialSnapshot);
    expect(subscriptionSnapshot.revision).toBe(1);
    expect(subscriptionSnapshot.domainRevision).toBe(1);
    expect(store.getDomainReadModel()).toBe(initialSnapshot.domain);
    expect(store.getDomainReadModel().getSession("session-a")).toMatchObject({
      sessionId: "session-a",
      title: "Initial session"
    });
    expect(store.getState().entities.sessions).toEqual({});
  });

  it("keeps renderer-only selection revision separate from domain revision", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    const beforeSelection = store.getSubscriptionSnapshot();

    store.dispatch({
      type: "store/setActiveSession",
      sessionId: "session-a"
    });

    const afterSelection = store.getSubscriptionSnapshot();
    expect(afterSelection).not.toBe(beforeSelection);
    expect(afterSelection.revision).toBe(beforeSelection.revision + 1);
    expect(afterSelection.domainRevision).toBe(beforeSelection.domainRevision);
    expect(store.getDomainReadModel().getSession("session-a")).toBeDefined();
  });

  it("projects ingested envelopes only through the domain replica", () => {
    const store = createRendererStore();
    const seenRevisions: number[] = [];
    store.subscribe(() => {
      seenRevisions.push(store.getSubscriptionSnapshot().revision);
    });

    const firstEnvelope = envelope("event-session-b");
    store.ingestEnvelope(firstEnvelope);

    const state = store.getState();
    expect(store.getDomainReadModel().getSession("session-b")).toMatchObject({
      sessionId: "session-b",
      conversationId: "conversation-b"
    });
    expect(state.entities.sessions["session-b"]).toBeUndefined();
    expect(
      store
        .getDomainReadModel()
        .listSessions({ conversationId: "conversation-b" })
        .map((session) => session.sessionId)
    ).toEqual(["session-b"]);
    expect(selectSessionsForConversation(state, "conversation-b")).toEqual([]);
    expect(seenRevisions).toEqual([1]);

    const beforeDuplicate = store.getSubscriptionSnapshot();
    store.ingestEnvelope(firstEnvelope);

    expect(store.getSubscriptionSnapshot()).toBe(beforeDuplicate);
    expect(store.getRevision()).toBe(1);
    expect(store.getDomainReadModel().getRevision()).toBe(1);
  });

  it("uses the replica to replace covered session-window entities", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            activeSessionId: "session-a",
            sessionIds: ["session-a"],
            createdAt: now,
            updatedAt: now
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "running",
            createdAt: now,
            updatedAt: now,
            lastTurnId: "turn-new"
          }
        ],
        turns: [
          {
            turnId: "turn-old",
            sessionId: "session-a",
            status: "completed",
            messageIds: ["message-old"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: [],
            startedAt: "2026-04-21T00:00:00.000Z",
            completedAt: "2026-04-21T00:00:01.000Z"
          },
          {
            turnId: "turn-new",
            sessionId: "session-a",
            status: "streaming",
            messageIds: ["message-new"],
            toolCallIds: ["tool-stale"],
            terminalIds: [],
            approvalRequestIds: [],
            startedAt: "2026-04-21T00:00:02.000Z"
          }
        ],
        messageBlocks: [
          {
            blockId: "message-old:md",
            messageId: "message-old",
            sessionId: "session-a",
            turnId: "turn-old",
            role: "user",
            kind: "markdown",
            text: "old prompt",
            startedAt: "2026-04-21T00:00:00.000Z"
          },
          {
            blockId: "message-new:md",
            messageId: "message-new",
            sessionId: "session-a",
            turnId: "turn-new",
            role: "assistant",
            kind: "markdown",
            text: "stale",
            startedAt: "2026-04-21T00:00:02.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-stale",
            sessionId: "session-a",
            turnId: "turn-new",
            toolName: "shell",
            status: "running",
            startedAt: "2026-04-21T00:00:02.500Z"
          }
        ]
      })
    );

    const state = store.hydrateSessionWindow(
      "session-a",
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            activeSessionId: "session-a",
            sessionIds: ["session-a"],
            createdAt: now,
            updatedAt: "2026-04-21T00:00:03.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "running",
            createdAt: now,
            updatedAt: "2026-04-21T00:00:03.000Z",
            lastTurnId: "turn-new"
          }
        ],
        turns: [
          {
            turnId: "turn-new",
            sessionId: "session-a",
            status: "streaming",
            messageIds: ["message-new"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: [],
            startedAt: "2026-04-21T00:00:02.000Z"
          }
        ],
        messageBlocks: [
          {
            blockId: "message-new:md",
            messageId: "message-new",
            sessionId: "session-a",
            turnId: "turn-new",
            role: "assistant",
            kind: "markdown",
            text: "fresh",
            startedAt: "2026-04-21T00:00:02.000Z"
          }
        ]
      }),
      "replace",
      "cursor-20"
    );

    expect(store.getDomainReadModel().getTurn("turn-old")).toBeDefined();
    expect(store.getDomainReadModel().getToolCall("tool-stale")).toBeUndefined();
    expect(store.getDomainReadModel().getMessageBlock("message-new:md")?.text).toBe(
      "fresh"
    );
    expect(state.entities.turns["turn-old"]).toBeUndefined();
    expect(state.eventStream.cursorBarrierBySessionId?.["session-a"]).toBe(
      "cursor-20"
    );
  });

  it("replaces a complete session history when a forced reload marks it complete", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [{
          conversationId: "conversation-a",
          participantEngineIds: ["agent-a"],
          activeSessionId: "session-a",
          sessionIds: ["session-a"],
          createdAt: now,
          updatedAt: now
        }],
        sessions: [{
          sessionId: "session-a",
          conversationId: "conversation-a",
          engineId: "agent-a",
          status: "idle",
          createdAt: now,
          updatedAt: now
        }],
        turns: [{
          turnId: "turn-old",
          sessionId: "session-a",
          status: "completed",
          startedAt: now,
          messageIds: ["message-old"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: []
        }],
        messageBlocks: [{
          blockId: "message-old:block",
          messageId: "message-old",
          sessionId: "session-a",
          turnId: "turn-old",
          role: "assistant",
          kind: "markdown",
          text: "old",
          startedAt: now
        }]
      })
    );

    store.hydrateSessionWindow(
      "session-a",
      parseDomainSnapshot({
        conversations: [{
          conversationId: "conversation-a",
          participantEngineIds: ["agent-a"],
          activeSessionId: "session-a",
          sessionIds: ["session-a"],
          createdAt: now,
          updatedAt: "2026-04-21T00:00:03.000Z"
        }],
        sessions: [{
          sessionId: "session-a",
          conversationId: "conversation-a",
          engineId: "agent-a",
          status: "idle",
          createdAt: now,
          updatedAt: "2026-04-21T00:00:03.000Z"
        }],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        runtimeInteractions: [],
        participants: [],
        threadGoals: [],
        sessionRelations: []
      }),
      "replace",
      "cursor-21",
      true
    );

    expect(store.getDomainReadModel().getTurn("turn-old")).toBeUndefined();
    expect(store.getDomainReadModel().getMessageBlock("message-old:block")).toBeUndefined();
  });

  it("hydrates all chat-tree windows in one store update and advances each cursor barrier", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-0");
    store.ingestEvent({
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-b",
      engineId: "agent-a",
      status: "idle"
    });
    const notifications = vi.fn();
    store.subscribe(notifications);

    const windowSnapshot = (sessionId: string, turnId: string) => parseDomainSnapshot({
      conversations: [{
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        sessionIds: ["session-a", "session-b"],
        activeSessionId: sessionId,
        createdAt: now,
        updatedAt: "2026-04-21T00:00:01.000Z"
      }],
      sessions: [{
        sessionId,
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "idle",
        createdAt: now,
        updatedAt: "2026-04-21T00:00:01.000Z"
      }],
      turns: [{
        turnId,
        sessionId,
        status: "completed",
        startedAt: "2026-04-21T00:00:01.000Z",
        messageIds: [],
        toolCallIds: [],
        terminalIds: [],
        approvalRequestIds: [],
        interactionRequestIds: []
      }],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    });

    store.hydrateSessionWindows([
      { sessionId: "session-a", snapshot: windowSnapshot("session-a", "turn-a"), cursor: "cursor-1" },
      { sessionId: "session-b", snapshot: windowSnapshot("session-b", "turn-b"), cursor: "cursor-2" }
    ]);

    expect(notifications).toHaveBeenCalledOnce();
    expect(store.getDomainReadModel().getTurn("turn-a")).toBeDefined();
    expect(store.getDomainReadModel().getTurn("turn-b")).toBeDefined();
    expect(store.getState().eventStream.cursorBarrierBySessionId).toMatchObject({
      "session-a": "cursor-1",
      "session-b": "cursor-2"
    });
  });

  it("does not let an older window replace a newer session event", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(parseDomainSnapshot({
      conversations: [{
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        sessionIds: ["session-a"],
        activeSessionId: "session-a",
        createdAt: now,
        updatedAt: now
      }],
      sessions: [{
        sessionId: "session-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "running",
        createdAt: now,
        updatedAt: now
      }],
      turns: [{
        turnId: "turn-a",
        sessionId: "session-a",
        status: "streaming",
        startedAt: now,
        messageIds: ["message-a"],
        toolCallIds: [],
        terminalIds: [],
        approvalRequestIds: [],
        interactionRequestIds: []
      }],
      messageBlocks: [{
        blockId: "message-a:md",
        messageId: "message-a",
        sessionId: "session-a",
        turnId: "turn-a",
        role: "assistant",
        kind: "markdown",
        text: "old",
        startedAt: now
      }],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    }));
    store.ingestEnvelope({
      eventId: "event-newer",
      cursor: "cursor-2",
      occurredAt: now,
      event: {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-a",
        messageId: "message-a",
        delta: " new"
      }
    });

    store.hydrateSessionWindow("session-a", parseDomainSnapshot({
      conversations: [{
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        sessionIds: ["session-a"],
        activeSessionId: "session-a",
        createdAt: now,
        updatedAt: now
      }],
      sessions: [{
        sessionId: "session-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "running",
        createdAt: now,
        updatedAt: now
      }],
      turns: [{
        turnId: "turn-a",
        sessionId: "session-a",
        status: "streaming",
        startedAt: now,
        messageIds: ["message-a"],
        toolCallIds: [],
        terminalIds: [],
        approvalRequestIds: [],
        interactionRequestIds: []
      }],
      messageBlocks: [{
        blockId: "message-a:md",
        messageId: "message-a",
        sessionId: "session-a",
        turnId: "turn-a",
        role: "assistant",
        kind: "markdown",
        text: "stale",
        startedAt: now
      }],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    }), "replace");

    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe("old new");
    expect(store.getState().eventStream.lastCursorBySessionId?.["session-a"]).toBe("cursor-2");
  });

  it("does not let an older global snapshot replace newer state", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-2");
    const older = sessionSnapshot();
    older.sessions[0]!.title = "stale";
    store.hydrateSnapshot(older, "cursor-1");

    expect(store.getDomainReadModel().getSession("session-a")?.title).toBe("Initial session");
  });

  it("protects a window from a newer conversation-scoped event", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    store.ingestEnvelope({
      eventId: "participant-newer",
      cursor: "cursor-2",
      occurredAt: now,
      event: {
        type: "participant.updated",
        conversationId: "conversation-a",
        participantId: "conversation-a:agent-a",
        engineId: "agent-a",
        role: "primary",
        capabilities: []
      }
    });
    const olderWindow = sessionSnapshot();
    olderWindow.sessions[0]!.title = "stale";
    store.hydrateSessionWindow("session-a", olderWindow, "replace", "cursor-1");

    expect(store.getDomainReadModel().getSession("session-a")?.title).toBe("Initial session");
    expect(store.getDomainReadModel().getParticipant("conversation-a:agent-a")?.capabilities).toEqual([]);
  });

  it("advances the conversation cursor for a sibling session event", () => {
    const store = createRendererStore();
    const initial = sessionSnapshot();
    initial.conversations[0]!.sessionIds = ["session-a", "session-b"];
    initial.sessions.push({
      ...initial.sessions[0]!,
      sessionId: "session-b"
    });
    store.hydrateSnapshot(initial, "cursor-1");
    store.ingestEnvelope({
      eventId: "sibling-turn",
      cursor: "cursor-2",
      occurredAt: now,
      event: {
        type: "turn.started",
        sessionId: "session-b",
        turnId: "turn-b"
      }
    });
    const olderWindow = sessionSnapshot();
    olderWindow.sessions[0]!.title = "stale";
    store.hydrateSessionWindow("session-a", olderWindow, "replace", "cursor-1");

    expect(store.getDomainReadModel().getSession("session-a")?.title).toBe("Initial session");
    expect(store.getState().eventStream.lastCursorByConversationId?.["conversation-a"]).toBe("cursor-2");
  });

  it("notifies only the affected session scope for live events", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-0");
    const sessionA = vi.fn();
    const sessionB = vi.fn();
    store.subscribeSession("session-a", sessionA);
    store.subscribeSession("session-b", sessionB);

    store.ingestEnvelope({
      eventId: "event-a",
      cursor: "cursor-1",
      occurredAt: now,
      event: {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-a",
        messageId: "message-a",
        delta: "hello"
      }
    });

    expect(sessionA).toHaveBeenCalledTimes(1);
    expect(sessionB).not.toHaveBeenCalled();
    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe(
      "hello"
    );
  });

  it("does not commit renderer metadata or domain state for an invalid batch", () => {
    const store = createRendererStore();
    const before = store.getSubscriptionSnapshot();

    expect(() =>
      store.ingestEnvelopes([
        {
          eventId: "event-valid",
          cursor: "cursor-1",
          occurredAt: now,
          event: {
            type: "session.created",
            conversationId: "conversation-a",
            sessionId: "session-a",
            engineId: "agent-a",
            status: "idle"
          }
        },
        {
          eventId: "event-invalid",
          cursor: "cursor-2",
          occurredAt: now,
          event: {
            type: "session.created",
            conversationId: "conversation-a",
            sessionId: "session-b",
            engineId: "agent-a",
            status: "idle",
            relation: {
              relationId: "relation-cycle",
              parentSessionId: "session-b",
              childSessionId: "session-b",
              relationType: "subagent",
              createdAt: now
            }
          }
        }
      ])
    ).toThrow(/cycle/);

    expect(store.getSubscriptionSnapshot()).toBe(before);
    expect(store.getState().eventStream.lastCursor).toBeUndefined();
    expect(store.getDomainReadModel().listSessions({ includeArchived: true })).toEqual(
      []
    );
  });

  it("does not partially commit state when scoped window validation fails", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    const before = store.getSubscriptionSnapshot();

    expect(() =>
      store.hydrateSessionWindow(
        "session-a",
        parseDomainSnapshot({
          conversations: [
            {
              conversationId: "conversation-b",
              participantEngineIds: ["agent-b"],
              activeSessionId: "session-b",
              sessionIds: ["session-b"],
              createdAt: now,
              updatedAt: now
            }
          ],
          sessions: [
            {
              sessionId: "session-b",
              conversationId: "conversation-b",
              engineId: "agent-b",
              status: "idle",
              createdAt: now,
              updatedAt: now
            }
          ]
        }),
        "replace",
        "cursor-2"
      )
    ).toThrow(/outside merge scope/);

    expect(store.getSubscriptionSnapshot()).toBe(before);
    expect(store.getState().eventStream.lastCursor).toBe("cursor-1");
    expect(store.getDomainReadModel().getSession("session-a")).toBeDefined();
    expect(store.getDomainReadModel().getSession("session-b")).toBeUndefined();
  });
});
