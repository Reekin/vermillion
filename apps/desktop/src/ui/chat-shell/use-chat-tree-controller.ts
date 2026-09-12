import { isHistoricalChatTreePosition } from "./chat-tree-send-target.js";
import { recordUiOperation } from "../../diagnostics/ui-performance.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTreeSendOperation, ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import { compareCursorPosition, isSessionWindowStale } from "../../store/meta-reducer.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ChatSendInput } from "../../transport/desktop-transport.js";
import { projectChatTreeSends } from "./chat-tree-send-projection.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

const emptyOperations: ChatTreeSendOperation[] = [];
/** A new object represents a new entry, including another click on the same session. */
export type ChatTreeNavigationEntry = { focusTree?: boolean; turnId?: string };
type ChatTreeWindow = NonNullable<ChatTreeSnapshotRpc["windows"]>[number];

const windowHydrationKey = (window: ChatTreeWindow): string | undefined => {
  if (!window.revision) return undefined;
  return [
    window.revision,
    window.windowStartTurnId ?? "",
    window.windowEndTurnId ?? "",
    window.olderCursor ?? "",
    window.newerCursor ?? "",
    window.hasOlder ? "older" : "",
    window.hasNewer ? "newer" : "",
    window.replaceSessionHistory ? "complete" : ""
  ].join("\u001f");
};

export const useChatTreeController = (input: {
  store: RendererStore;
  transport: DesktopTransport;
  sessionId?: string;
  navigationEntry?: ChatTreeNavigationEntry;
  refreshSignal: number;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
}) => {
  const { store, transport, sessionId, navigationEntry, onStatusNotice } = input;
  const entry = useMemo(() => ({
    opened: { current: undefined as { sessionId: string; promise: Promise<void> } | undefined },
    activation: { current: undefined as { sessionId: string; promise: Promise<void> } | undefined },
    hydrated: { current: new Map<string, string>() }
  }), [sessionId, navigationEntry]);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const [loaded, setLoaded] = useState<{
    entrySessionId: string;
    entry: typeof entry;
    tree: ChatTreeSnapshotRpc;
  }>();
  const [failedEntry, setFailedEntry] = useState<typeof entry>();
  const [sends, setSends] = useState<{ sessionId: string; operations: ChatTreeSendOperation[] }>();
  const [selectedSend, setSelectedSend] = useState<string>();
  const selectedSendRef = useRef<string | undefined>(undefined);
  const navigationRef = useRef(0);
  const selectSend = (operationId: string | undefined) => {
    selectedSendRef.current = operationId;
    setSelectedSend(operationId);
  };
  const sessionIdRef = useRef(sessionId);
  const requestIdRef = useRef(0);
  const hydratedWindowKeyBySessionIdRef = entry.hydrated;
  const activationRef = entry.activation;
  const openedSessionRef = entry.opened;
  sessionIdRef.current = sessionId;

  const ensureSessionOpened = useCallback((): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    const current = openedSessionRef.current;
    if (current?.sessionId === sessionId) return current.promise;

    hydratedWindowKeyBySessionIdRef.current.clear();
    const opened = {
      sessionId,
      promise: (async () => {
        await transport.sessionBrowser.open(sessionId);
        if (entryRef.current !== entry) return;
        if (navigationEntry?.focusTree) {
          const activation = { sessionId, promise: transport.sessionBrowser.activate(sessionId, { focusTree: true }).then(() => undefined) };
          activationRef.current = activation;
          await activation.promise;
          if (entryRef.current !== entry) return;
        }
        if (navigationEntry?.turnId) {
          await transport.chatTree.jump({ sessionId, nodeId: navigationEntry.turnId });
          if (entryRef.current !== entry) return;
        }
        store.dispatch({ type: "store/sessionBrowserChanged" });
      })()
    };
    openedSessionRef.current = opened;
    void opened.promise.catch(() => {
      if (openedSessionRef.current === opened) openedSessionRef.current = undefined;
    });
    return opened.promise;
  }, [entry, navigationEntry, sessionId, store, transport]);

  const refreshChatTree = useCallback(async (): Promise<void> => {
    if (!sessionId || entryRef.current !== entry) return;
    const requestId = ++requestIdRef.current;
    const startedAt = performance.now();
    const isCurrent = () => entryRef.current === entry && requestId === requestIdRef.current;
    try {
      await ensureSessionOpened();
      if (!isCurrent()) return;
      const [initialTree, result] = await Promise.all([
        transport.chatTree.get(sessionId),
        transport.chatTree.operations({ sessionId })
      ]);
      if (!isCurrent()) return;
      setSends({ sessionId, operations: result.operations });
      let tree = initialTree;
      const selected = result.operations.find((op) => op.operationId === selectedSendRef.current);
      if (selected?.turnId && tree.nodes.some((node) => node.turnId === selected.turnId)) {
        const navigation = navigationRef.current;
        await transport.chatTree.jump({ sessionId, nodeId: selected.turnId });
        if (!isCurrent() || navigationRef.current !== navigation) return;
        tree = await transport.chatTree.get(sessionId);
        if (!isCurrent() || navigationRef.current !== navigation) return;
      }
      const viewedSessionId = tree.currentSessionId ?? sessionId;
      // Keep the pending activation as well as its result across refreshes.
      if (activationRef.current?.sessionId !== viewedSessionId) {
        const activation = {
          sessionId: viewedSessionId,
          promise: transport.sessionBrowser.activate(viewedSessionId).then(() => {
            if (activationRef.current === activation) {
              store.dispatch({ type: "store/sessionBrowserChanged" });
            }
          }).catch((error) => {
            if (activationRef.current === activation) activationRef.current = undefined;
            throw error;
          })
        };
        activationRef.current = activation;
      }
      await activationRef.current.promise;
      if (!isCurrent()) return;
      const windowsToHydrate = (tree.windows ?? []).filter((window) => {
        const key = windowHydrationKey(window);
        return key === undefined ||
          hydratedWindowKeyBySessionIdRef.current.get(window.sessionId) !== key;
      });
      const stateBeforeHydration = store.getState();
      const latestCursorBySessionId = new Map(
        Object.entries(stateBeforeHydration.eventStream.lastCursorBySessionId ?? {})
      );
      const latestCursorByConversationId = new Map(
        Object.entries(stateBeforeHydration.eventStream.lastCursorByConversationId ?? {})
      );
      const freshWindowsToHydrate = windowsToHydrate.filter((window) => {
        const conversationId = window.snapshot.conversations[0]?.conversationId;
        if (isSessionWindowStale(stateBeforeHydration, window.sessionId, window.cursor, conversationId)) {
          return false;
        }
        const currentCursor = latestCursorBySessionId.get(window.sessionId);
        const comparison = compareCursorPosition(currentCursor, window.cursor);
        if (currentCursor && comparison !== undefined && comparison > 0) {
          return false;
        }
        const currentConversationCursor = conversationId
          ? latestCursorByConversationId.get(conversationId)
          : undefined;
        const conversationComparison = compareCursorPosition(
          currentConversationCursor,
          window.cursor
        );
        if (
          currentConversationCursor &&
          conversationComparison !== undefined &&
          conversationComparison > 0
        ) {
          return false;
        }
        if (window.cursor) latestCursorBySessionId.set(window.sessionId, window.cursor);
        if (conversationId && window.cursor) {
          latestCursorByConversationId.set(conversationId, window.cursor);
        }
        return true;
      });
      if (freshWindowsToHydrate.length > 0) {
        store.hydrateSessionWindows(
          freshWindowsToHydrate.map((window) => ({
            sessionId: window.sessionId,
            snapshot: window.snapshot,
            cursor: window.cursor,
            replaceSessionHistory: window.replaceSessionHistory
          }))
        );
        for (const window of freshWindowsToHydrate) {
          const key = windowHydrationKey(window);
          if (key !== undefined) {
            hydratedWindowKeyBySessionIdRef.current.set(window.sessionId, key);
          }
        }
      }
      // The shell keeps selecting the tree entry; only this pane changes its viewed member.
      const entrySession = store.getDomainReadModel().getSession(sessionId);
      if (entrySession) {
        store.dispatch({ type: "store/setActiveConversation", conversationId: entrySession.conversationId });
        store.dispatch({ type: "store/setActiveSession", sessionId });
      }
      setLoaded({ entrySessionId: sessionId, entry, tree });
      if (selected?.turnId && tree.currentNodeId === selected.turnId && selectedSendRef.current === selected.operationId) {
        selectSend(undefined);
      }
      setFailedEntry(undefined);
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    } finally {
      recordUiOperation("chat-tree.refresh", startedAt, { sessionId }, "async");
    }
  }, [entry, ensureSessionOpened, sessionId, store, transport]);

  useEffect(() => {
    if (!sessionId) openedSessionRef.current = undefined;
    activationRef.current = undefined;
    setLoaded(undefined);
    setFailedEntry(undefined);
    setSends(undefined);
    selectSend(undefined);
    navigationRef.current += 1;
    return () => { requestIdRef.current += 1; };
  }, [entry]);

  useEffect(() => {
    const refresh = refreshChatTree();
    const requestId = requestIdRef.current;
    void refresh.catch((error) => {
      if (entryRef.current !== entry || requestId !== requestIdRef.current) return;
      setFailedEntry(entry);
      onStatusNotice({
        message: `Chat tree refresh failed: ${(error as Error).message}`,
        source: "chat-tree",
        ...statusNoticeErrorDetails(error)
      });
    });
  }, [refreshChatTree, input.refreshSignal, onStatusNotice]);

  const operations = sends && sends.sessionId === sessionId ? sends.operations : emptyOperations;
  const loadedTree = loaded && loaded.entry === entry ? loaded.tree : undefined;
  const chatTree = useMemo(
    () => projectChatTreeSends(loadedTree, operations, selectedSend),
    [loadedTree, operations, selectedSend]
  );
  const pendingSend = operations.find((op) =>
    (op.operationId === chatTree?.currentNodeId || op.turnId === chatTree?.currentNodeId) &&
    (!op.turnId || !chatTree?.nodes.some((node) => node.turnId === op.turnId)));

  const receiveSend = (operation: ChatTreeSendOperation) => {
    setSends((current) => ({
      sessionId: sessionId!,
      operations: current && current.sessionId === sessionId && current.operations.some((item) => item.operationId === operation.operationId)
        ? current.operations.map((item) => item.operationId === operation.operationId ? operation : item)
        : [...(current && current.sessionId === sessionId ? current.operations : []), operation]
    }));
  };
  // Explicit navigation waits for the refreshed branch/turn, never showing a cached different position.
  const isOpening = Boolean(
    sessionId && !chatTree && failedEntry !== entry &&
    (navigationEntry || !store.getDomainReadModel().getSession(sessionId))
  );

  return {
    chatTree,
    operations,
    pendingSend,
    isOpening,
    viewSessionId: chatTree?.currentSessionId ?? sessionId,
    refreshChatTree,
    onJumpChatTree: async (nodeId: string): Promise<void> => {
      if (!sessionId || isOpening) return;
      navigationRef.current += 1;
      requestIdRef.current += 1;
      const operation = operations.find((op) => op.operationId === nodeId);
      if (operation) {
        selectSend(operation.operationId);
        void refreshChatTree().catch(() => undefined);
        return;
      }
      selectSend(undefined);
      try {
        await transport.chatTree.jump({ sessionId, nodeId });
        await refreshChatTree();
      } catch (error) {
        if (sessionIdRef.current !== sessionId) return;
        onStatusNotice({
          message: `Chat tree jump failed: ${(error as Error).message}`,
          persistent: true,
          source: "chat-tree",
          ...statusNoticeErrorDetails(error)
        });
      }
    },
    submitBranch: async (payload: Omit<ChatSendInput, "sessionId">): Promise<boolean> => {
      if (!sessionId || !chatTree) return false;
      if (pendingSend) throw new Error("请等待该消息发送完成，或切换到其他节点提问。");
      const nodeId = chatTree.currentNodeId;
      if (!nodeId || !isHistoricalChatTreePosition(chatTree)) return false;
      const navigation = ++navigationRef.current;
      const operation = await transport.chatTree.submit({ ...payload, attachments: payload.attachments ?? [], sessionId: chatTree.currentSessionId ?? sessionId, nodeId });
      if (sessionIdRef.current === sessionId) {
        receiveSend(operation);
        if (navigationRef.current === navigation) selectSend(operation.operationId);
        void refreshChatTree().catch(() => undefined);
      }
      return true;
    },
    retrySend: async (operationId: string): Promise<void> => {
      try {
        const operation = await transport.chatTree.retry({ operationId });
        if (sessionIdRef.current !== sessionId) return;
        receiveSend(operation);
        void refreshChatTree().catch(() => undefined);
      } catch (error) {
        setSends((current) => current && ({ ...current, operations: current.operations.map((op) =>
          op.operationId === operationId ? { ...op, error: (error as Error).message } : op) }));
      }
    },
    prepareSend: async (): Promise<string> => {
      if (!sessionId) throw new Error("Select a session before sending.");
      const result = await transport.chatTree.prepareSend({
        sessionId: chatTree?.currentSessionId ?? sessionId,
        nodeId: chatTree?.currentNodeId
      });
      await refreshChatTree();
      return result.sessionId;
    }
  };
};
