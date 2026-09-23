import type { DomainSnapshot, EventEnvelope, RuntimeEvent } from "@vermillion/shared";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import { createInitialRendererStoreState } from "./state.js";
import { advanceRendererRefreshSignals } from "./refresh-signals.js";

const maxSeenEventIds = 2_048;

const splitComparableCursor = (
  cursor: string
): { prefix: string; sequence: bigint } | undefined => {
  const match = /^(.*?)(\d+)$/.exec(cursor);
  if (!match) {
    return undefined;
  }
  return {
    prefix: match[1] ?? "",
    sequence: BigInt(match[2]!)
  };
};

export const compareCursorPosition = (
  left: string | undefined,
  right: string | undefined
): number | undefined => {
  if (!left || !right) {
    return undefined;
  }
  if (left === right) {
    return 0;
  }
  const parsedLeft = splitComparableCursor(left);
  const parsedRight = splitComparableCursor(right);
  if (!parsedLeft || !parsedRight || parsedLeft.prefix !== parsedRight.prefix) {
    return undefined;
  }
  if (parsedLeft.sequence < parsedRight.sequence) {
    return -1;
  }
  if (parsedLeft.sequence > parsedRight.sequence) {
    return 1;
  }
  return 0;
};

export const isSessionWindowStale = (
  state: RendererStoreState,
  sessionId: string,
  cursor: string | undefined
): boolean => {
  const currentCursor = state.eventStream.lastCursorBySessionId?.[sessionId];
  // A member window owns only that session's history. Sibling activity must
  // not prevent a cold ancestor from acquiring its complete baseline.
  if (!cursor) return Boolean(currentCursor);
  const sessionComparison = compareCursorPosition(currentCursor, cursor);
  return sessionComparison !== undefined && sessionComparison > 0;
};

export const isGlobalSnapshotStale = (
  state: RendererStoreState,
  cursor: string | undefined
): boolean => {
  const knownCursors = [
    state.eventStream.lastCursor,
    ...Object.values(state.eventStream.lastCursorBySessionId ?? {}),
    ...Object.values(state.eventStream.lastCursorByConversationId ?? {})
  ].filter((value): value is string => Boolean(value));
  if (!cursor) return knownCursors.length > 0;
  return knownCursors.some((knownCursor) => {
    const comparison = compareCursorPosition(knownCursor, cursor);
    return comparison !== undefined && comparison > 0;
  });
};

const isEnvelopeCoveredByCursor = (
  envelope: EventEnvelope,
  cursor: string | undefined
): boolean => {
  if (!cursor) {
    return false;
  }
  const comparison = compareCursorPosition(envelope.cursor, cursor);
  return comparison !== undefined && comparison <= 0;
};

const runtimeEventSessionId = (event: RuntimeEvent): string | undefined =>
  "sessionId" in event && typeof event.sessionId === "string"
    ? event.sessionId
    : undefined;

const isEnvelopeCoveredByBarrier = (
  state: RendererStoreState,
  envelope: EventEnvelope
): boolean => {
  if (isEnvelopeCoveredByCursor(envelope, state.eventStream.cursorBarrier)) {
    return true;
  }
  const sessionId = runtimeEventSessionId(envelope.event);
  if (!sessionId) {
    return false;
  }
  return isEnvelopeCoveredByCursor(
    envelope,
    state.eventStream.cursorBarrierBySessionId?.[sessionId]
  );
};

const withEventType = (
  state: RendererStoreState,
  event: RuntimeEvent
): RendererStoreState => ({
  ...state,
  lastEventType: event.type,
  refreshSignals: advanceRendererRefreshSignals(state.refreshSignals, event)
});

const markEnvelopeInEventStream = (
  state: RendererStoreState,
  envelope: EventEnvelope
): RendererStoreState => {
  return markEnvelopesInEventStream(state, [envelope]);
};

const markGlobalCursorBarrier = (
  state: RendererStoreState,
  cursor: string | undefined,
  snapshot: DomainSnapshot
): RendererStoreState => {
  if (!cursor) {
    return state;
  }
  const barrierComparison = compareCursorPosition(
    cursor,
    state.eventStream.cursorBarrier
  );
  if (barrierComparison !== undefined && barrierComparison <= 0) {
    return state;
  }
  const lastCursorComparison = compareCursorPosition(
    cursor,
    state.eventStream.lastCursor
  );
  const lastCursor =
    lastCursorComparison !== undefined && lastCursorComparison <= 0
      ? state.eventStream.lastCursor
      : cursor;
  return {
    ...state,
    eventStream: {
      ...state.eventStream,
      lastCursor,
      cursorBarrier: cursor,
      lastCursorBySessionId: {
        ...(state.eventStream.lastCursorBySessionId ?? {}),
        ...Object.fromEntries(snapshot.sessions.map((session) => [session.sessionId, cursor]))
      },
      lastCursorByConversationId: {
        ...(state.eventStream.lastCursorByConversationId ?? {}),
        ...Object.fromEntries(snapshot.conversations.map((conversation) => [conversation.conversationId, cursor]))
      },
      conversationIdBySessionId: {
        ...(state.eventStream.conversationIdBySessionId ?? {}),
        ...Object.fromEntries(snapshot.sessions.map((session) => [session.sessionId, session.conversationId]))
      }
    }
  };
};

const markSessionCursorBarrier = (
  state: RendererStoreState,
  sessionId: string,
  cursor: string | undefined,
  conversationId?: string
): RendererStoreState => {
  if (!cursor) {
    return state;
  }
  const currentBarrier = state.eventStream.cursorBarrierBySessionId?.[sessionId];
  const comparison = compareCursorPosition(cursor, currentBarrier);
  if (comparison !== undefined && comparison <= 0) {
    return state;
  }
  return {
    ...state,
    eventStream: {
      ...state.eventStream,
      cursorBarrierBySessionId: {
        ...(state.eventStream.cursorBarrierBySessionId ?? {}),
        [sessionId]: cursor
      },
      lastCursorBySessionId: {
        ...(state.eventStream.lastCursorBySessionId ?? {}),
        [sessionId]: cursor
      },
      conversationIdBySessionId: conversationId
        ? {
            ...(state.eventStream.conversationIdBySessionId ?? {}),
            [sessionId]: conversationId
          }
        : state.eventStream.conversationIdBySessionId
    }
  };
};

const markEnvelopesInEventStream = (
  state: RendererStoreState,
  envelopes: EventEnvelope[]
): RendererStoreState => {
  if (envelopes.length === 0) {
    return state;
  }
  const recentEventIds = [
    ...(state.eventStream.recentEventIds ?? []),
    ...envelopes.map((envelope) => envelope.eventId)
  ];
  const overflow = Math.max(0, recentEventIds.length - maxSeenEventIds);
  const trimmedRecentEventIds =
    overflow > 0 ? recentEventIds.slice(overflow) : recentEventIds;
  const seenEventIds = trimmedRecentEventIds.reduce<Record<string, true>>(
    (acc, eventId) => {
      acc[eventId] = true;
      return acc;
    },
    {}
  );

  const lastEnvelope = envelopes[envelopes.length - 1]!;
  const conversationIdBySessionId = envelopes.reduce<Record<string, string>>((acc, envelope) => {
    const sessionId = runtimeEventSessionId(envelope.event);
    if (
      sessionId &&
      "conversationId" in envelope.event &&
      typeof envelope.event.conversationId === "string"
    ) {
      acc[sessionId] = envelope.event.conversationId;
    }
    return acc;
  }, { ...(state.eventStream.conversationIdBySessionId ?? {}) });
  return {
    ...state,
    eventStream: {
      lastEventId: lastEnvelope.eventId,
      lastCursor: lastEnvelope.cursor,
      lastCursorBySessionId: envelopes.reduce<Record<string, string>>((acc, envelope) => {
        const sessionId = runtimeEventSessionId(envelope.event);
        if (!sessionId || !envelope.cursor) return acc;
        const current = acc[sessionId] ?? state.eventStream.lastCursorBySessionId?.[sessionId];
        const comparison = compareCursorPosition(envelope.cursor, current);
        if (current && comparison !== undefined && comparison <= 0) return acc;
        acc[sessionId] = envelope.cursor;
        return acc;
      }, { ...(state.eventStream.lastCursorBySessionId ?? {}) }),
      lastCursorByConversationId: envelopes.reduce<Record<string, string>>((acc, envelope) => {
        const sessionId = runtimeEventSessionId(envelope.event);
        const conversationId =
          "conversationId" in envelope.event &&
          typeof envelope.event.conversationId === "string"
            ? envelope.event.conversationId
            : sessionId
              ? conversationIdBySessionId[sessionId]
              : undefined;
        if (!conversationId || !envelope.cursor) return acc;
        const current = acc[conversationId] ?? state.eventStream.lastCursorByConversationId?.[conversationId];
        const comparison = compareCursorPosition(envelope.cursor, current);
        if (current && comparison !== undefined && comparison <= 0) return acc;
        acc[conversationId] = envelope.cursor;
        return acc;
      }, { ...(state.eventStream.lastCursorByConversationId ?? {}) }),
      conversationIdBySessionId,
      cursorBarrier: state.eventStream.cursorBarrier,
      cursorBarrierBySessionId: state.eventStream.cursorBarrierBySessionId,
      lastOccurredAt: lastEnvelope.occurredAt,
      recentEventIds: trimmedRecentEventIds,
      seenEventIds
    }
  };
};

const applyRendererMetaEvent = (
  state: RendererStoreState,
  event: RuntimeEvent
): RendererStoreState => {
  const next = withEventType(state, event);
  if (event.type === "session.disposed" && state.activeSessionId === event.sessionId) {
    return {
      ...next,
      activeSessionId: undefined
    };
  }
  if (event.type !== "runtime.error") {
    return next;
  }
  return {
    ...next,
    lastError: {
      code: event.code ?? "runtime_error",
      message: event.message,
      recoverable: event.recoverable
    }
  };
};

const ingestMetaEnvelope = (
  state: RendererStoreState,
  envelope: EventEnvelope
): RendererStoreState => {
  if (
    state.eventStream.seenEventIds[envelope.eventId] ||
    isEnvelopeCoveredByBarrier(state, envelope)
  ) {
    return state;
  }
  return markEnvelopeInEventStream(
    applyRendererMetaEvent(state, envelope.event),
    envelope
  );
};

const ingestMetaEnvelopeBatch = (
  state: RendererStoreState,
  envelopes: EventEnvelope[]
): RendererStoreState => {
  const pending: EventEnvelope[] = [];
  const seenInBatch = new Set<string>();
  for (const envelope of envelopes) {
    if (
      state.eventStream.seenEventIds[envelope.eventId] ||
      seenInBatch.has(envelope.eventId) ||
      isEnvelopeCoveredByBarrier(state, envelope)
    ) {
      continue;
    }
    seenInBatch.add(envelope.eventId);
    pending.push(envelope);
  }
  if (pending.length === 0) {
    return state;
  }
  let nextState = state;
  for (const envelope of pending) {
    nextState = applyRendererMetaEvent(nextState, envelope.event);
  }
  return markEnvelopesInEventStream(nextState, pending);
};

export const rendererMetaReducer = (
  state: RendererStoreState = createInitialRendererStoreState(),
  action: RendererStoreAction
): RendererStoreState => {
  switch (action.type) {
    case "store/hydrateSnapshot":
      if (isGlobalSnapshotStale(state, action.cursor)) return state;
      return markGlobalCursorBarrier(
        {
          ...state,
          activeConversationId:
            state.activeConversationId ??
            action.snapshot.conversations.at(0)?.conversationId,
          activeSessionId:
            state.activeSessionId ?? action.snapshot.sessions.at(0)?.sessionId
        },
        action.cursor,
        action.snapshot
      );
    case "store/hydrateSessionWindow": {
      if (action.mode !== "prepend" && isSessionWindowStale(
        state,
        action.sessionId,
        action.cursor
      )) {
        return state;
      }
      const nextState =
        action.mode === "prepend"
          ? state
          : markSessionCursorBarrier(
              state,
              action.sessionId,
              action.cursor,
              action.snapshot.conversations[0]?.conversationId
            );
      if (action.mode === "prepend" || state.activeSessionId !== action.sessionId) {
        return nextState;
      }
      const restoredSession = action.snapshot.sessions.find(
        (session) => session.sessionId === action.sessionId
      );
      return restoredSession
        ? {
            ...nextState,
            activeConversationId: restoredSession.conversationId,
            activeSessionId: action.sessionId
          }
        : nextState;
    }
    case "store/hydrateSessionWindows": {
      let nextState = state;
      for (const window of action.windows) {
        nextState = rendererMetaReducer(nextState, {
          type: "store/hydrateSessionWindow",
          sessionId: window.sessionId,
          snapshot: window.snapshot,
          cursor: window.cursor,
          replaceSessionHistory: window.replaceSessionHistory
        });
      }
      return nextState;
    }
    case "store/disposeSession":
      return state.activeSessionId === action.sessionId
        ? { ...state, activeSessionId: undefined }
        : state;
    case "store/ingestEvent":
      return applyRendererMetaEvent(state, action.event);
    case "store/ingestEnvelope":
      return ingestMetaEnvelope(state, action.envelope);
    case "store/ingestEnvelopes":
      return ingestMetaEnvelopeBatch(state, action.envelopes);
    case "store/setActiveConversation":
      return { ...state, activeConversationId: action.conversationId };
    case "store/setActiveSession":
      return { ...state, activeSessionId: action.sessionId };
    case "store/sessionBrowserChanged":
      return {
        ...state,
        refreshSignals: { ...state.refreshSignals, sessionBrowser: state.refreshSignals.sessionBrowser + 1 }
      };
    default:
      return state;
  }
};
