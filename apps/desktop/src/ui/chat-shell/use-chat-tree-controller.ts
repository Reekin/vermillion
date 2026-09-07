import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

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
  const sessionIdRef = useRef(sessionId);
  const requestIdRef = useRef(0);
  const activationRef = useRef<{ sessionId: string; promise: Promise<void> } | undefined>(undefined);
  sessionIdRef.current = sessionId;

  const refreshChatTree = useCallback(async (): Promise<void> => {
    if (!sessionId || sessionIdRef.current !== sessionId) return;
    const requestId = ++requestIdRef.current;
    const isCurrent = () => sessionIdRef.current === sessionId && requestId === requestIdRef.current;
    try {
      const tree = await transport.chatTree.get(sessionId);
      if (!isCurrent()) return;
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
      setFailedSessionId(undefined);
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    }
  }, [sessionId, store, transport]);

  useEffect(() => {
    activationRef.current = undefined;
    setLoaded(undefined);
    setFailedSessionId(undefined);
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

  const chatTree = loaded && loaded.entrySessionId === sessionId ? loaded.tree : undefined;
  // A session the store already holds renders at once; the tree refresh then narrows the view to the saved position.
  const isOpening = Boolean(
    sessionId && !chatTree && failedSessionId !== sessionId && !store.getDomainReadModel().getSession(sessionId)
  );

  return {
    chatTree,
    isOpening,
    viewSessionId: chatTree?.currentSessionId ?? sessionId,
    refreshChatTree,
    onJumpChatTree: async (nodeId: string): Promise<void> => {
      if (!sessionId || isOpening) return;
      requestIdRef.current += 1;
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
    prepareSend: async (): Promise<string> => {
      if (!sessionId) throw new Error("Select a session before sending.");
      const result = await transport.chatTree.prepareSend({
        sessionId,
        nodeId: chatTree?.currentNodeId
      });
      await refreshChatTree();
      return result.sessionId;
    }
  };
};
