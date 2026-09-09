import { useMemo, useRef, useSyncExternalStore } from "react";
import type { AgentParticipant } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { RendererStoreState } from "../../store/types.js";

export const useRendererStoreState = (
  store: RendererStore
): RendererStoreState =>
  useSyncExternalStore(
    (onStoreChange) => store.subscribeMeta(onStoreChange),
    () => store.getSubscriptionSnapshot(),
    () => store.getSubscriptionSnapshot()
  ).state;

export const useRendererSessionRevision = (
  store: RendererStore,
  sessionId: string | undefined
): number =>
  useSyncExternalStore(
    (onStoreChange) =>
      sessionId ? store.subscribeSession(sessionId, onStoreChange) : () => undefined,
    () =>
      sessionId
        ? store.getDomainReadModel().getSessionRevision(sessionId)
        : store.getDomainReadModel().getRevision(),
    () =>
      sessionId
        ? store.getDomainReadModel().getSessionRevision(sessionId)
        : store.getDomainReadModel().getRevision()
  );

export const useRendererSessionsRevision = (
  store: RendererStore,
  sessionIds: string[]
): string =>
  useSyncExternalStore(
    (onStoreChange) => {
      const unsubscribe = sessionIds.map((id) => store.subscribeSession(id, onStoreChange));
      return () => unsubscribe.forEach((dispose) => dispose());
    },
    () => sessionIds.map((id) => store.getDomainReadModel().getSessionRevision(id)).join(":"),
    () => sessionIds.map((id) => store.getDomainReadModel().getSessionRevision(id)).join(":")
  );

export const useRendererConversationRevision = (
  store: RendererStore,
  conversationId: string | undefined
): number =>
  useSyncExternalStore(
    (onStoreChange) =>
      conversationId
        ? store.subscribeConversation(conversationId, onStoreChange)
        : () => undefined,
    () =>
      conversationId
        ? store.getDomainReadModel().getConversationRevision(conversationId)
        : store.getDomainReadModel().getRevision(),
    () =>
      conversationId
        ? store.getDomainReadModel().getConversationRevision(conversationId)
        : store.getDomainReadModel().getRevision()
  );

export const useRendererVisibleTurnsRevision = (
  store: RendererStore,
  turnIds: string[],
  initialSessionId?: string
): string =>
  useSyncExternalStore(
    (onStoreChange) => {
      const unsubscribe = initialSessionId
        ? [store.subscribeSession(initialSessionId, onStoreChange)]
        : turnIds.map((id) => store.subscribeTurn(id, onStoreChange));
      return () => unsubscribe.forEach((dispose) => dispose());
    },
    () => initialSessionId
      ? String(store.getDomainReadModel().getSessionRevision(initialSessionId))
      : turnIds.map((id) => store.getDomainReadModel().getTurnRevision(id)).join(":"),
    () => initialSessionId
      ? String(store.getDomainReadModel().getSessionRevision(initialSessionId))
      : turnIds.map((id) => store.getDomainReadModel().getTurnRevision(id)).join(":")
  );

export const useRendererConversationParticipants = (
  store: RendererStore,
  conversationId?: string
): AgentParticipant[] => {
  // Read-model participants are materialized copies; compare their fields, not
  // the conversation revision, which also advances for streamed output.
  const getSnapshot = () => JSON.stringify(conversationId
    ? store.getDomainReadModel().listParticipants({ conversationId }).map((participant) => ({
        ...participant, activeSessionIds: [...participant.activeSessionIds].sort()
      }))
    : []);
  const snapshot = useSyncExternalStore(
    (onStoreChange) => conversationId
      ? store.subscribeConversation(conversationId, onStoreChange)
      : () => undefined,
    getSnapshot,
    getSnapshot
  );
  return useMemo(() => JSON.parse(snapshot) as AgentParticipant[], [snapshot]);
};

export const useRendererSessionSelection = <T extends object>(
  store: RendererStore,
  sessionId: string | undefined,
  select: () => T,
  signature: (value: T) => string = JSON.stringify
): T => {
  const cached = useRef<{ key: string; value: T } | undefined>(undefined);
  const getSnapshot = () => {
    const value = select();
    const key = signature(value);
    if (!cached.current || cached.current.key !== key) cached.current = { key, value };
    return cached.current.value;
  };
  return useSyncExternalStore(
    (onStoreChange) => sessionId
      ? store.subscribeSession(sessionId, onStoreChange)
      : () => undefined,
    getSnapshot,
    getSnapshot
  );
};
