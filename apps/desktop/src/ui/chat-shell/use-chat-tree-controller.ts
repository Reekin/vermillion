import { isHistoricalChatTreePosition } from "./chat-tree-send-target.js";
import { recordUiOperation } from "../../diagnostics/ui-performance.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTreeSendOperation, ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import { createCoalescedRefresh } from "./coalesced-refresh.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ChatSendInput } from "../../transport/desktop-transport.js";
import { projectChatTreeSends } from "./chat-tree-send-projection.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

const emptyOperations: ChatTreeSendOperation[] = [];
/** Explicit navigation supplied by a work-item, search or session link. */
export type ChatTreeNavigationEntry = { focusTree?: boolean; turnId?: string };
type SessionRequest = { sessionId: string; promise: Promise<void>; signal?: AbortSignal };
type ChatTreeEntry = {
  opened: { current: SessionRequest | undefined };
  activation: { current: SessionRequest | undefined };
  refresh: ReturnType<typeof createCoalescedRefresh>;
  /** 当前查看路径：先于整棵树到达，驱动消息区展示。 */
  path?: ChatTreeSnapshotRpc;
  tree?: ChatTreeSnapshotRpc;
  operations: ChatTreeSendOperation[];
  appliedNavigation?: ChatTreeNavigationEntry;
};

export const hasExplicitChatTreeNavigation = (
  navigationEntry: ChatTreeNavigationEntry | undefined
): boolean => Boolean(navigationEntry?.focusTree || navigationEntry?.turnId);

export const canDisplayCachedChatTree = (
  tree: ChatTreeSnapshotRpc | undefined,
  sessionId: string | undefined,
  navigationEntry: ChatTreeNavigationEntry | undefined
): boolean => {
  if (!tree || !hasExplicitChatTreeNavigation(navigationEntry)) return Boolean(tree);
  if (navigationEntry?.turnId) {
    const currentNode = tree.nodes.find((node) => node.nodeId === tree.currentNodeId);
    return (currentNode?.turnId ?? tree.currentNodeId) === navigationEntry.turnId;
  }
  return !navigationEntry?.focusTree || tree.currentSessionId === sessionId;
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
  const entriesRef = useRef(new Map<string, ChatTreeEntry>());
  let entry: ChatTreeEntry | undefined;
  if (sessionId) {
    entry = entriesRef.current.get(sessionId);
    if (!entry) {
      entry = {
        opened: { current: undefined },
        activation: { current: undefined },
        refresh: createCoalescedRefresh(),
        operations: []
      };
      entriesRef.current.set(sessionId, entry);
    }
  }
  const entryRef = useRef<ChatTreeEntry | undefined>(entry);
  entryRef.current = entry;
  const [, setCacheRevision] = useState(0);
  const [failedEntry, setFailedEntry] = useState<ChatTreeEntry | undefined>();
  const [treeFailure, setTreeFailure] = useState<{ entry: ChatTreeEntry; message: string }>();
  const [recoveredSends, setRecoveredSends] = useState<ChatTreeSendOperation[]>([]);
  const consumeRecoveredSend = useCallback((operationId: string) => {
    setRecoveredSends((current) => current.filter((item) => item.operationId !== operationId));
  }, []);
  const [selectedSend, setSelectedSend] = useState<string>();
  const selectedSendRef = useRef<string | undefined>(undefined);
  const navigationRef = useRef(0);
  const selectSend = (operationId: string | undefined) => {
    selectedSendRef.current = operationId;
    setSelectedSend(operationId);
  };
  const sessionIdRef = useRef(sessionId);
  const navigationEntryRef = useRef(navigationEntry);
  const navigationRequestRef = useRef<{
    entry: ChatTreeEntry;
    navigationEntry: ChatTreeNavigationEntry;
    promise: Promise<void>;
  } | undefined>(undefined);
  sessionIdRef.current = sessionId;
  navigationEntryRef.current = navigationEntry;

  const ensureSessionOpened = useCallback((signal: AbortSignal): Promise<void> => {
    if (!sessionId || !entry) return Promise.resolve();
    const current = entry.opened.current;
    if (current?.sessionId === sessionId && !current.signal?.aborted) return current.promise;

    const opened: SessionRequest = {
      sessionId,
      signal,
      promise: transport.sessionBrowser.open(sessionId, { includeWindow: false, signal }).then(() => undefined)
    };
    entry.opened.current = opened;
    void opened.promise.catch(() => {
      if (entry.opened.current === opened) entry.opened.current = undefined;
    });
    return opened.promise;
  }, [entry, sessionId, transport]);

  const ensureNavigation = useCallback((
    requestedNavigation: ChatTreeNavigationEntry | undefined
  ): Promise<void> => {
    if (!entry || !sessionId || !hasExplicitChatTreeNavigation(requestedNavigation)) {
      return Promise.resolve();
    }
    const current = navigationRequestRef.current;
    if (
      current?.entry === entry &&
      current.navigationEntry === requestedNavigation
    ) {
      return current.promise;
    }
    const pending: {
      entry: ChatTreeEntry;
      navigationEntry: ChatTreeNavigationEntry;
      promise: Promise<void>;
    } = {
      entry,
      navigationEntry: requestedNavigation!,
      promise: Promise.resolve()
    };
    navigationRequestRef.current = pending;
    const isCurrent = () =>
      navigationRequestRef.current === pending &&
      navigationEntryRef.current === requestedNavigation &&
      entryRef.current === entry;
    pending.promise = (async () => {
      if (!isCurrent()) return;
      if (requestedNavigation?.focusTree) {
        const activation: SessionRequest = {
          sessionId,
          promise: transport.sessionBrowser.activate(sessionId, { focusTree: true }).then(() => undefined)
        };
        entry.activation.current = activation;
        await activation.promise;
        if (!isCurrent()) return;
      } else {
        entry.activation.current = undefined;
      }
      if (requestedNavigation?.turnId) {
        if (!isCurrent()) return;
        await transport.chatTree.jump({ sessionId, nodeId: requestedNavigation.turnId });
      }
      if (isCurrent() && entryRef.current === entry) {
        store.dispatch({ type: "store/sessionBrowserChanged" });
      }
    })();
    void pending.promise.catch(() => {
      if (navigationRequestRef.current === pending) {
        navigationRequestRef.current = undefined;
      }
    });
    return pending.promise;
  }, [entry, sessionId, store, transport]);

  const activateViewedSession = useCallback((
    viewedEntry: ChatTreeEntry,
    viewedSessionId: string
  ): Promise<void> => {
    const current = viewedEntry.activation.current;
    if (current?.sessionId === viewedSessionId) return current.promise;
    const activation: SessionRequest = {
      sessionId: viewedSessionId,
      promise: transport.sessionBrowser.activate(viewedSessionId).then(() => {
        if (viewedEntry.activation.current === activation) {
          store.dispatch({ type: "store/sessionBrowserChanged" });
        }
      })
    };
    viewedEntry.activation.current = activation;
    void activation.promise.catch(() => {
      if (viewedEntry.activation.current === activation) viewedEntry.activation.current = undefined;
    });
    return activation.promise;
  }, [store, transport]);

  /** 展示当前查看路径：注水该路径成员的正文，并把查看位置交给消息区。 */
  const applyViewPath = useCallback(async (
    viewedEntry: ChatTreeEntry,
    path: ChatTreeSnapshotRpc,
    navigationForRequest: ChatTreeNavigationEntry | undefined,
    isCurrent: () => boolean,
    readId?: string
  ): Promise<boolean> => {
    if (!sessionId) return false;
    const entry = viewedEntry;
    const viewedSessionId = path.currentSessionId ?? sessionId;
    await activateViewedSession(entry, viewedSessionId);
    if (!isCurrent()) return false;
    {
      const freshWindowsToHydrate = path.windows ?? [];
      if (freshWindowsToHydrate.length > 0) {
        const batchSize = 2;
        for (let start = 0; start < freshWindowsToHydrate.length; start += batchSize) {
          if (!isCurrent()) return false;
          const batch = freshWindowsToHydrate.slice(start, start + batchSize);
          store.hydrateSessionWindows(
            batch.map((window) => ({
              sessionId: window.sessionId,
              snapshot: window.snapshot,
              cursor: window.cursor,
              replaceSessionHistory: window.replaceSessionHistory,
              revision: !window.hasOlder && !window.hasNewer ? window.revision : undefined
            })),
            readId
          );
          if (start + batchSize < freshWindowsToHydrate.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
      }
    }
    // The shell keeps selecting the tree entry; only this pane changes its viewed member.
    const entrySession = store.getDomainReadModel().getSession(sessionId);
    if (entrySession) {
      store.dispatch({ type: "store/setActiveConversation", conversationId: entrySession.conversationId });
      store.dispatch({ type: "store/setActiveSession", sessionId });
    }
    entry.path = { ...path, windows: undefined };
    entry.appliedNavigation = navigationForRequest;
    setCacheRevision((revision) => revision + 1);
    return true;
  }, [activateViewedSession, sessionId, store]);

  const refreshChatTree = useCallback(async (
    requestedNavigation?: ChatTreeNavigationEntry
  ): Promise<void> => {
    if (!sessionId || !entry || entryRef.current !== entry) return;
    return entry.refresh.request(async (signal, consumePending) => {
      const startedAt = performance.now();
      const readId = globalThis.crypto.randomUUID();
      let finishRead = () => {};
      const isCurrent = () => entryRef.current === entry && !signal.aborted;
      const navigationForRequest = requestedNavigation ?? navigationEntry;
      try {
        await ensureSessionOpened(signal);
        if (!isCurrent()) return;
        await ensureNavigation(navigationForRequest);
        if (!isCurrent()) return;
        consumePending();
        finishRead = store.beginSessionWindowRead(readId);
        signal.addEventListener("abort", finishRead, { once: true });
        const [initialPath, result] = await Promise.all([
          transport.chatTree.get(sessionId, { scope: "path", knownWindows: store.getKnownSessionWindows(), readId, signal }),
          transport.chatTree.operations({ sessionId })
        ]);
        if (!isCurrent()) return;
        entry.operations = result.operations;
        if (!await applyViewPath(entry, initialPath, navigationForRequest, isCurrent, readId)) return;
        setFailedEntry(undefined);
        setTreeFailure(undefined);
        let tree = await transport.chatTree.get(sessionId, { signal });
        if (!isCurrent()) return;
        const selected = result.operations.find((op) => op.operationId === selectedSendRef.current);
        if (selected?.turnId && tree.nodes.some((node) => node.turnId === selected.turnId)) {
          const navigation = navigationRef.current;
          await transport.chatTree.jump({ sessionId, nodeId: selected.turnId });
          if (!isCurrent() || navigationRef.current !== navigation) return;
          const [jumpedTree, jumpedPath] = await Promise.all([
            transport.chatTree.get(sessionId, { signal }),
            transport.chatTree.get(sessionId, { scope: "path", knownWindows: store.getKnownSessionWindows(), signal })
          ]);
          if (!isCurrent() || navigationRef.current !== navigation) return;
          tree = jumpedTree;
          if (!await applyViewPath(entry, jumpedPath, navigationForRequest, isCurrent, readId)) return;
        }
        entry.tree = { ...tree, windows: undefined };
        setCacheRevision((revision) => revision + 1);
        if (selected?.turnId && tree.currentNodeId === selected.turnId && selectedSendRef.current === selected.operationId) {
          selectSend(undefined);
        }
        setFailedEntry(undefined);
        setTreeFailure(undefined);
      } catch (error) {
        if (!isCurrent()) return;
        throw error;
      } finally {
        signal.removeEventListener("abort", finishRead);
        finishRead();
        recordUiOperation("chat-tree.refresh", startedAt, { sessionId }, "async");
      }
    });
  }, [applyViewPath, entry, ensureNavigation, ensureSessionOpened, navigationEntry, sessionId, store, transport]);

  useEffect(() => {
    if (entry) {
      entry.opened.current = undefined;
      entry.activation.current = undefined;
    }
    navigationRequestRef.current = undefined;
    setFailedEntry(undefined);
    setTreeFailure(undefined);
    selectSend(undefined);
    navigationRef.current += 1;
    return () => { entry?.refresh.cancel(); };
  }, [entry]);

  useEffect(() => () => { entry?.refresh.cancel(); }, [entry, navigationEntry]);

  useEffect(() => {
    const refresh = refreshChatTree(navigationEntry);
    void refresh.catch((error) => {
      if (entryRef.current !== entry) return;
      setFailedEntry(entry);
      setTreeFailure({ entry: entry!, message: `Chat tree refresh failed: ${(error as Error).message}` });
      onStatusNotice({
        message: `Chat tree refresh failed: ${(error as Error).message}`,
        source: "chat-tree",
        ...statusNoticeErrorDetails(error)
      });
    });
  }, [entry, input.refreshSignal, navigationEntry, onStatusNotice, refreshChatTree]);

  useEffect(() => {
    const pending = navigationRequestRef.current;
    if (pending && pending.entry === entry && pending.navigationEntry !== navigationEntry) {
      navigationRequestRef.current = undefined;
    }
  }, [entry, navigationEntry]);

  const operations = entry?.operations ?? emptyOperations;
  const pendingNavigation = entry?.appliedNavigation === navigationEntry
    ? undefined
    : navigationEntry;
  // 消息区跟随当前查看路径，切分支时不等整棵树；树面板只用整棵树。
  const displayedTree = entry?.path ?? entry?.tree;
  const loadedTree = canDisplayCachedChatTree(displayedTree, sessionId, pendingNavigation)
    ? displayedTree
    : undefined;
  const loadedGraph = canDisplayCachedChatTree(entry?.tree, sessionId, pendingNavigation)
    ? entry?.tree
    : undefined;
  const chatTree = useMemo(
    () => projectChatTreeSends(loadedTree, operations, selectedSend),
    [loadedTree, operations, selectedSend]
  );
  const chatTreeGraph = useMemo(
    () => projectChatTreeSends(loadedGraph, operations, selectedSend),
    [loadedGraph, operations, selectedSend]
  );
  const pendingSend = operations.find((op) =>
    (op.operationId === chatTree?.currentNodeId || op.turnId === chatTree?.currentNodeId) &&
    (!op.turnId || !chatTree?.nodes.some((node) => node.turnId === op.turnId)));

  const receiveSend = (operation: ChatTreeSendOperation) => {
    if (!entry || !sessionId) return;
    entry.operations = entry.operations.some((item) => item.operationId === operation.operationId)
      ? entry.operations.map((item) => item.operationId === operation.operationId ? operation : item)
      : [...entry.operations, operation];
    setCacheRevision((revision) => revision + 1);
  };
  const hasCachedTargetTree = canDisplayCachedChatTree(displayedTree, sessionId, pendingNavigation);
  const isOpening = Boolean(
    sessionId && failedEntry !== entry && !hasCachedTargetTree &&
    (hasExplicitChatTreeNavigation(navigationEntry) || !store.getDomainReadModel().getSession(sessionId))
  );
  const isChatTreeLoading = Boolean(sessionId && entry && failedEntry !== entry && !chatTreeGraph);

  return {
    chatTree,
    chatTreeGraph,
    chatTreeError: treeFailure && treeFailure.entry === entry ? treeFailure.message : undefined,
    isChatTreeLoading,
    operations,
    pendingSend,
    isOpening,
    viewSessionId: chatTree?.currentSessionId ?? sessionId,
    refreshChatTree,
    onJumpChatTree: async (nodeId: string): Promise<void> => {
      if (!sessionId || isOpening) return;
      navigationRef.current += 1;
      entry?.refresh.cancel();
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
        if (entry && sessionIdRef.current === sessionId) {
          entry.operations = entry.operations.map((op) =>
            op.operationId === operationId ? { ...op, error: (error as Error).message } : op
          );
          setCacheRevision((revision) => revision + 1);
        }
      }
    },
    cancelSend: async (operationId: string, action: "cancel" | "remove"): Promise<void> => {
      if (!entry || !sessionId) return;
      const navigation = navigationRef.current;
      const operation = await transport.chatTree[action]({ operationId });
      const selected = selectedSendRef.current === operationId && navigationRef.current === navigation;
      entry.operations = entry.operations.filter((item) => item.operationId !== operationId);
      setRecoveredSends((current) => current.some((item) => item.operationId === operation.operationId)
        ? current : [...current, operation]);
      if (selected) {
        selectSend(undefined);
        await transport.chatTree.jump({ sessionId, nodeId: operation.nodeId });
        await refreshChatTree();
      } else {
        setCacheRevision((revision) => revision + 1);
      }
    },
    recoveredSends,
    consumeRecoveredSend,
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
