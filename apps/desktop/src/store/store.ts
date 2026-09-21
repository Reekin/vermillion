import {
  createIngestEnvelopeAction,
  createIngestEnvelopesAction,
  createHydrateSnapshotAction,
  createIngestEventAction
} from "./intake.js";
import { recordUiOperation } from "../diagnostics/ui-performance.js";
import {
  compareCursorPosition,
  isGlobalSnapshotStale,
  isSessionWindowStale,
  rendererMetaReducer
} from "./meta-reducer.js";
import {
  createInitialRendererStoreState,
  normalizeRendererDomainSnapshot
} from "./state.js";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import {
  DomainReplica,
  type DomainChangeSet,
  type DomainReadModel
} from "@vermillion/core";
import type {
  DomainSnapshot,
  EventEnvelope,
  RuntimeEvent
} from "@vermillion/shared";

type Listener = (state: RendererStoreState, action: RendererStoreAction) => void;
type RevisionListener = () => void;
type KnownWindow = { revision: string; cursor?: string };
type HydratedWindow = Extract<RendererStoreAction, { type: "store/hydrateSessionWindows" }>["windows"][number];

const normalizeSessionWindow = (
  replica: DomainReplica,
  state: RendererStoreState,
  snapshot: DomainSnapshot,
  cursor?: string
): DomainSnapshot => {
  const normalized = normalizeRendererDomainSnapshot(snapshot);
  const hasNewerMetadata = (conversationId: string): boolean => {
    const latest = state.eventStream.lastCursorByConversationId?.[conversationId];
    return Boolean(latest && (!cursor || (compareCursorPosition(latest, cursor) ?? 0) > 0));
  };
  const domain = replica.readModel;
  // Member body and conversation metadata have different owners. A sibling
  // update keeps current metadata without discarding this member's history.
  return {
    ...normalized,
    conversations: normalized.conversations.map((item) => hasNewerMetadata(item.conversationId)
      ? domain.getConversation(item.conversationId) ?? item : item),
    sessions: normalized.sessions.map((item) => hasNewerMetadata(item.conversationId)
      ? domain.getSession(item.sessionId) ?? item : item),
    participants: normalized.participants.map((item) => hasNewerMetadata(item.conversationId)
      ? domain.getParticipant(item.participantId) ?? item : item),
    sessionRelations: normalized.sessionRelations.map((item) => {
      const conversationId = domain.resolveConversationIdBySessionId(item.childSessionId);
      return conversationId && hasNewerMetadata(conversationId)
        ? domain.getSessionRelation(item.relationId) ?? item : item;
    })
  };
};

export type RendererStoreSubscriptionSnapshot = {
  revision: number;
  domainRevision: number;
  state: RendererStoreState;
  domain: DomainReadModel;
};

export type RendererStore = {
  getState: () => RendererStoreState;
  getKnownSessionWindows: () => Record<string, KnownWindow>;
  clearKnownSessionWindows: () => void;
  beginSessionWindowRead: (readId: string) => () => void;
  getRevision: () => number;
  getDomainReadModel: () => DomainReadModel;
  getSubscriptionSnapshot: () => RendererStoreSubscriptionSnapshot;
  dispatch: (action: RendererStoreAction) => RendererStoreState;
  subscribe: (listener: Listener) => () => void;
  subscribeMeta: (listener: RevisionListener) => () => void;
  subscribeSession: (sessionId: string, listener: RevisionListener) => () => void;
  subscribeTurn: (turnId: string, listener: RevisionListener) => () => void;
  subscribeConversation: (
    conversationId: string,
    listener: RevisionListener
  ) => () => void;
  hydrateSnapshot: (snapshot: DomainSnapshot, cursor?: string) => RendererStoreState;
  hydrateSessionWindow: (
    sessionId: string,
    snapshot: DomainSnapshot,
    mode?: "replace" | "prepend",
    cursor?: string,
    replaceSessionHistory?: boolean
  ) => RendererStoreState;
  hydrateSessionWindows: (
    windows: HydratedWindow[], readId?: string
  ) => RendererStoreState;
  disposeSession: (sessionId: string) => RendererStoreState;
  ingestEvent: (event: RuntimeEvent) => RendererStoreState;
  ingestEnvelope: (envelope: EventEnvelope) => RendererStoreState;
  ingestEnvelopes: (envelopes: EventEnvelope[]) => RendererStoreState;
};

const applySnapshotActionToReplica = (
  replica: DomainReplica,
  action: RendererStoreAction,
  state: RendererStoreState,
  confirmWindow: (window: HydratedWindow) => void
): DomainSnapshot[] => {
  switch (action.type) {
    case "store/hydrateSnapshot":
      if (isGlobalSnapshotStale(state, action.cursor)) return [];
      {
        const snapshot = normalizeRendererDomainSnapshot(action.snapshot);
        replica.replaceSnapshot(snapshot);
        return [snapshot];
      }
    case "store/hydrateSessionWindow": {
      if (action.mode !== "prepend" && isSessionWindowStale(
        state,
        action.sessionId,
        action.cursor
      )) {
        return [];
      }
      const snapshot = normalizeSessionWindow(replica, state, action.snapshot, action.cursor);
      if (action.mode === "prepend") {
        replica.mergeSnapshot(snapshot, {
          scope: { sessionId: action.sessionId }
        });
        return [snapshot];
      }
      if (action.replaceSessionHistory) {
        replica.replaceSessionHistorySnapshot(action.sessionId, snapshot);
      } else {
        replica.replaceSessionWindowSnapshot(action.sessionId, snapshot);
      }
      confirmWindow(action);
      return [snapshot];
    }
    case "store/hydrateSessionWindows": {
      const latestCursorBySessionId = new Map(
        Object.entries(state.eventStream.lastCursorBySessionId ?? {})
      );
      const freshWindows = action.windows.flatMap((window) => {
        if (isSessionWindowStale(state, window.sessionId, window.cursor)) {
          return [];
        }
        const currentCursor = latestCursorBySessionId.get(window.sessionId);
        const comparison = compareCursorPosition(currentCursor, window.cursor);
        if (
          currentCursor &&
          comparison !== undefined &&
          comparison > 0
        ) {
          return [];
        }
        if (window.cursor) latestCursorBySessionId.set(window.sessionId, window.cursor);
        return [{
          ...window,
          sessionId: window.sessionId,
          snapshot: normalizeSessionWindow(replica, state, window.snapshot, window.cursor),
          replaceSessionHistory: window.replaceSessionHistory
        }];
      });
      const completeWindows = freshWindows.filter((window) => window.replaceSessionHistory);
      for (const window of completeWindows) {
        replica.replaceSessionHistorySnapshot(window.sessionId, window.snapshot);
      }
      replica.replaceSessionWindowSnapshots(
        freshWindows.filter((window) => !window.replaceSessionHistory)
      );
      for (const window of freshWindows) {
        if (window.replayEnvelopes?.length) replica.applyBatch(window.replayEnvelopes);
        if (replica.getSession(window.sessionId)) confirmWindow(window);
      }
      return freshWindows.map((window) => replica.getSessionSnapshot(window.sessionId));
    }
    default:
      return [];
  }
};

const createSubscriptionSnapshot = (
  state: RendererStoreState,
  revision: number,
  domainReplica: DomainReplica
): RendererStoreSubscriptionSnapshot => ({
  revision,
  domainRevision: domainReplica.getRevision(),
  state,
  domain: domainReplica.readModel
});

export const createRendererStore = (
  initialState?: RendererStoreState
): RendererStore => {
  let state = initialState ?? createInitialRendererStoreState();
  const domainReplica = new DomainReplica();
  const knownWindows = new Map<string, KnownWindow>();
  // Only in-flight reads retain an event tail. The canonical body remains in the replica.
  const windowReads = new Map<string, { fromCursor?: string; envelopes: EventEnvelope[] }>();
  const retainReadEvents = (envelopes: EventEnvelope[]): void => {
    for (const read of windowReads.values()) read.envelopes.push(...envelopes);
  };
  const confirmWindow = (window: HydratedWindow): void => {
    // Partial or unversioned replacement cannot certify the whole member.
    if (window.replaceSessionHistory && window.revision) {
      knownWindows.set(window.sessionId, { revision: window.revision, cursor: window.cursor });
    } else {
      knownWindows.delete(window.sessionId);
    }
  };
  let revision = 0;
  let subscriptionSnapshot = createSubscriptionSnapshot(
    state,
    revision,
    domainReplica
  );
  const listeners = new Set<Listener>();
  const metaListeners = new Set<RevisionListener>();
  const sessionListeners = new Map<string, Set<RevisionListener>>();
  const turnListeners = new Map<string, Set<RevisionListener>>();
  const conversationListeners = new Map<string, Set<RevisionListener>>();

  const notifyDomain = (changes: DomainChangeSet): void => {
    if (changes.fullReset) {
      for (const listenersForScope of sessionListeners.values()) {
        for (const listener of listenersForScope) listener();
      }
      for (const listenersForScope of conversationListeners.values()) {
        for (const listener of listenersForScope) listener();
      }
      for (const listenersForScope of turnListeners.values()) {
        for (const listener of listenersForScope) listener();
      }
      return;
    }
    for (const sessionId of changes.sessionIds) {
      for (const listener of sessionListeners.get(sessionId) ?? []) listener();
    }
    for (const turnId of changes.turnIds) {
      for (const listener of turnListeners.get(turnId) ?? []) listener();
    }
    for (const conversationId of changes.conversationIds) {
      for (const listener of conversationListeners.get(conversationId) ?? []) listener();
    }
  };

  const subscribeScoped = (
    registry: Map<string, Set<RevisionListener>>,
    id: string,
    listener: RevisionListener
  ): (() => void) => {
    const scoped = registry.get(id) ?? new Set<RevisionListener>();
    scoped.add(listener);
    registry.set(id, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) registry.delete(id);
    };
  };

  const dispatch = (action: RendererStoreAction): RendererStoreState => {
    const startedAt = performance.now();
    const previousState = state;
    if (action.type === "store/hydrateSessionWindows" && action.readId) {
      const read = windowReads.get(action.readId);
      if (read) action = { ...action, windows: action.windows.map((window) => {
        // A read may replay only when it captured the entire interval after this snapshot.
        if (!window.replaceSessionHistory ||
            (read.fromCursor && (compareCursorPosition(window.cursor, read.fromCursor) ?? -1) < 0)) return window;
        const replayEnvelopes = read.envelopes.filter(({ event, cursor }) =>
          "sessionId" in event && event.sessionId === window.sessionId &&
          (compareCursorPosition(cursor, window.cursor ?? "0") ?? -1) > 0);
        if (!replayEnvelopes.length) return window;
        return { ...window, snapshot: normalizeSessionWindow(domainReplica, state, window.snapshot, window.cursor),
          cursor: replayEnvelopes.at(-1)!.cursor, replayEnvelopes };
      }) };
    }
    const disposedConversationIdBeforeMutation =
      action.type === "store/disposeSession"
        ? domainReplica.resolveConversationIdBySessionId(action.sessionId)
        : undefined;
    let reducedState = rendererMetaReducer(state, action);
    let changes: DomainChangeSet | undefined;

    if (
      action.type === "store/hydrateSnapshot" ||
      action.type === "store/hydrateSessionWindow" ||
      action.type === "store/hydrateSessionWindows"
    ) {
      const beforeRevision = domainReplica.getRevision();
      const snapshots = applySnapshotActionToReplica(domainReplica, action, state, confirmWindow);
      if (action.type === "store/hydrateSnapshot" && snapshots.length > 0) {
        knownWindows.clear();
        windowReads.clear();
      }
      if (snapshots.length > 0 && domainReplica.getRevision() !== beforeRevision) {
        changes = {
          revision: domainReplica.getRevision(),
          fullReset: action.type === "store/hydrateSnapshot",
          conversationIds: new Set(snapshots.flatMap((snapshot) => snapshot.conversations.map((item) => item.conversationId))),
          sessionIds: new Set(snapshots.flatMap((snapshot) => snapshot.sessions.map((item) => item.sessionId))),
          turnIds: new Set(snapshots.flatMap((snapshot) => snapshot.turns.map((item) => item.turnId)))
        };
      }
    } else if (action.type === "store/disposeSession") {
      knownWindows.delete(action.sessionId);
      const beforeRevision = domainReplica.getRevision();
      const conversationId = domainReplica.resolveConversationIdBySessionId(action.sessionId);
      if (conversationId) {
        changes = domainReplica.applyBatch([
          {
            occurredAt: new Date().toISOString(),
            event: {
              type: "session.disposed",
              conversationId,
              sessionId: action.sessionId,
              disposedAt: new Date().toISOString()
            }
          }
        ]);
      }
      if (domainReplica.getRevision() !== beforeRevision) {
        changes ??= {
          revision: domainReplica.getRevision(),
          fullReset: false,
          conversationIds: new Set(conversationId ? [conversationId] : []),
          sessionIds: new Set([action.sessionId]),
          turnIds: new Set()
        };
      }
    } else if (action.type === "store/ingestEvent") {
      if ("sessionId" in action.event && action.event.sessionId) knownWindows.delete(action.event.sessionId);
      changes = domainReplica.applyBatch([{ event: action.event }]);
    } else if (action.type === "store/ingestEnvelope") {
      if (reducedState !== previousState) {
        changes = domainReplica.applyBatch([action.envelope]);
        retainReadEvents([action.envelope]);
      }
    } else if (action.type === "store/ingestEnvelopes") {
      const accepted = action.envelopes.filter(
        (envelope) =>
          !previousState.eventStream.seenEventIds[envelope.eventId] &&
          Boolean(reducedState.eventStream.seenEventIds[envelope.eventId])
      );
      if (accepted.length > 0) {
        changes = domainReplica.applyBatch(accepted);
        retainReadEvents(accepted);
      }
    }

    const events = action.type === "store/ingestEnvelopes" ? action.envelopes.map((item) => item.event)
      : action.type === "store/ingestEnvelope" ? [action.envelope.event] : [];
    for (const event of events) {
      if (event.type === "session.disposed") knownWindows.delete(event.sessionId);
    }

    const disposedEvent =
      action.type === "store/ingestEvent" && action.event.type === "session.disposed"
        ? action.event
        : action.type === "store/ingestEnvelope" &&
            action.envelope.event.type === "session.disposed"
          ? action.envelope.event
          : action.type === "store/ingestEnvelopes"
            ? [...action.envelopes]
                .reverse()
                .map((envelope) => envelope.event)
                .find((event) => event.type === "session.disposed")
            : undefined;
    const disposedSessionId =
      action.type === "store/disposeSession"
        ? action.sessionId
        : disposedEvent?.type === "session.disposed"
          ? disposedEvent.sessionId
          : undefined;
    const disposedConversationId =
      disposedEvent?.type === "session.disposed"
        ? disposedEvent.conversationId
        : disposedConversationIdBeforeMutation;
    if (
      disposedSessionId &&
      previousState.activeSessionId === disposedSessionId
    ) {
      const nextSession =
        (disposedConversationId
          ? domainReplica.getConversation(disposedConversationId)?.activeSessionId
          : undefined) ?? domainReplica.listSessions().at(0)?.sessionId;
      reducedState = {
        ...reducedState,
        activeConversationId: nextSession
          ? domainReplica.resolveConversationIdBySessionId(nextSession)
          : disposedConversationId ?? reducedState.activeConversationId,
        activeSessionId: nextSession
      };
    }

    if (reducedState !== previousState || changes) {
      state = reducedState;
      revision += 1;
      subscriptionSnapshot = createSubscriptionSnapshot(
        state,
        revision,
        domainReplica
      );
    }
    if (
      reducedState.activeConversationId !== previousState.activeConversationId ||
      reducedState.activeSessionId !== previousState.activeSessionId ||
      reducedState.refreshSignals !== previousState.refreshSignals ||
      reducedState.lastError !== previousState.lastError
    ) {
      for (const listener of metaListeners) listener();
    }
    if (changes) notifyDomain(changes);
    for (const listener of listeners) {
      listener(state, action);
    }
    recordUiOperation("store." + action.type, startedAt, {
      events: action.type === "store/ingestEnvelopes" ? action.envelopes.length : 1,
      sessions: changes?.sessionIds.size ?? 0,
      turns: changes?.turnIds.size ?? 0
    });
    return state;
  };

  return {
    getState: () => state,
    getKnownSessionWindows: () => Object.fromEntries([...knownWindows].map(([sessionId, known]) => {
      const cursor = state.eventStream.lastCursorBySessionId?.[sessionId];
      return [sessionId, { ...known, cursor: cursor && (!known.cursor || (compareCursorPosition(cursor, known.cursor) ?? -1) >= 0) ? cursor : known.cursor }];
    })),
    clearKnownSessionWindows: () => { knownWindows.clear(); windowReads.clear(); },
    beginSessionWindowRead: (readId) => {
      const read = { fromCursor: state.eventStream.lastCursor, envelopes: [] as EventEnvelope[] };
      windowReads.set(readId, read);
      return () => {
        if (windowReads.get(readId) === read) windowReads.delete(readId);
        read.envelopes.length = 0;
      };
    },
    getRevision: () => revision,
    getDomainReadModel: () => domainReplica.readModel,
    getSubscriptionSnapshot: () => subscriptionSnapshot,
    dispatch,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeMeta: (listener) => {
      metaListeners.add(listener);
      return () => metaListeners.delete(listener);
    },
    subscribeSession: (sessionId, listener) =>
      subscribeScoped(sessionListeners, sessionId, listener),
    subscribeTurn: (turnId, listener) =>
      subscribeScoped(turnListeners, turnId, listener),
    subscribeConversation: (conversationId, listener) =>
      subscribeScoped(conversationListeners, conversationId, listener),
    hydrateSnapshot: (snapshot: DomainSnapshot, cursor?: string) =>
      dispatch(createHydrateSnapshotAction(snapshot, cursor)),
    hydrateSessionWindow: (
      sessionId,
      snapshot,
      mode = "replace",
      cursor,
      replaceSessionHistory
    ) =>
      dispatch({
        type: "store/hydrateSessionWindow",
        sessionId,
        snapshot,
        mode,
        cursor,
        replaceSessionHistory
      }),
    hydrateSessionWindows: (windows, readId) =>
      dispatch({
        type: "store/hydrateSessionWindows",
        windows, readId
      }),
    disposeSession: (sessionId) =>
      dispatch({
        type: "store/disposeSession",
        sessionId
      }),
    ingestEvent: (event: RuntimeEvent) =>
      dispatch(createIngestEventAction(event)),
    ingestEnvelope: (envelope: EventEnvelope) =>
      dispatch(createIngestEnvelopeAction(envelope)),
    ingestEnvelopes: (envelopes: EventEnvelope[]) =>
      dispatch(createIngestEnvelopesAction(envelopes))
  };
};
