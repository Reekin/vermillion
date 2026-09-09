import { isHistoricalChatTreePosition } from "./chat-tree-send-target.js";
import { recordUiOperation } from "../../diagnostics/ui-performance.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTreeSendOperation, ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ChatSendInput } from "../../transport/desktop-transport.js";
import { projectChatTreeSends } from "./chat-tree-send-projection.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

const emptyOperations: ChatTreeSendOperation[] = [];

export const useChatTreeController = (input: {
  store: RendererStore;
  transport: DesktopTransport;
  sessionId?: string;
  refreshSignal: number;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
}) => {
  const { store, transport, sessionId, onStatusNotice } = input;
  const [loaded, setLoaded] = useState<{
    entrySessionId: string;
    tree: ChatTreeSnapshotRpc;
  }>();
  const [failedSessionId, setFailedSessionId] = useState<string>();
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
  const activationRef = useRef<{ sessionId: string; promise: Promise<void> } | undefined>(undefined);
  sessionIdRef.current = sessionId;

  const refreshChatTree = useCallback(async (): Promise<void> => {
    if (!sessionId || sessionIdRef.current !== sessionId) return;
    const requestId = ++requestIdRef.current;
    const startedAt = performance.now();
    const isCurrent = () => sessionIdRef.current === sessionId && requestId === requestIdRef.current;
    try {
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
      for (const window of tree.windows ?? []) {
        store.hydrateSessionWindow(window.sessionId, window.snapshot, "replace", window.cursor);
      }
      // The shell keeps selecting the tree entry; only this pane changes its viewed member.
      const entry = store.getDomainReadModel().getSession(sessionId);
      if (entry) {
        store.dispatch({ type: "store/setActiveConversation", conversationId: entry.conversationId });
        store.dispatch({ type: "store/setActiveSession", sessionId });
      }
      setLoaded({ entrySessionId: sessionId, tree });
      if (selected?.turnId && tree.currentNodeId === selected.turnId && selectedSendRef.current === selected.operationId) {
        selectSend(undefined);
      }
      setFailedSessionId(undefined);
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    } finally {
      recordUiOperation("chat-tree.refresh", startedAt, { sessionId }, "async");
    }
  }, [sessionId, store, transport]);

  useEffect(() => {
    activationRef.current = undefined;
    setLoaded(undefined);
    setFailedSessionId(undefined);
    setSends(undefined);
    selectSend(undefined);
    navigationRef.current += 1;
    return () => { requestIdRef.current += 1; };
  }, [sessionId]);

  useEffect(() => {
    const refresh = refreshChatTree();
    const requestId = requestIdRef.current;
    void refresh.catch((error) => {
      if (sessionIdRef.current !== sessionId || requestId !== requestIdRef.current) return;
      setFailedSessionId(sessionId);
      onStatusNotice({
        message: `Chat tree refresh failed: ${(error as Error).message}`,
        source: "chat-tree",
        ...statusNoticeErrorDetails(error)
      });
    });
  }, [refreshChatTree, input.refreshSignal, onStatusNotice]);

  const operations = sends && sends.sessionId === sessionId ? sends.operations : emptyOperations;
  const loadedTree = loaded && loaded.entrySessionId === sessionId ? loaded.tree : undefined;
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
  // A session the store already holds renders at once; the tree refresh then narrows the view to the saved position.
  const isOpening = Boolean(
    sessionId && !chatTree && failedSessionId !== sessionId && !store.getDomainReadModel().getSession(sessionId)
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
