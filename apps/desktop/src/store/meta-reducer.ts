import type { EventEnvelope, RuntimeEvent } from "@vermillion/shared";
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

const compareCursorPosition = (
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
  cursor: string | undefined
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
      cursorBarrier: cursor
    }
  };
};

const markSessionCursorBarrier = (
  state: RendererStoreState,
  sessionId: string,
  cursor: string | undefined
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
      }
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
  return {
    ...state,
    eventStream: {
      lastEventId: lastEnvelope.eventId,
      lastCursor: lastEnvelope.cursor,
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
      return markGlobalCursorBarrier(
        {
          ...state,
          activeConversationId:
            state.activeConversationId ??
            action.snapshot.conversations.at(0)?.conversationId,
          activeSessionId:
            state.activeSessionId ?? action.snapshot.sessions.at(0)?.sessionId
        },
        action.cursor
      );
    case "store/hydrateSessionWindow": {
      const nextState =
        action.mode === "prepend"
          ? state
          : markSessionCursorBarrier(state, action.sessionId, action.cursor);
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
    default:
      return state;
  }
};
