import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { writeClipboardText } from "../chat-shell/clipboard.js";

export type SessionMenu = { sessionId: string; x: number; y: number; actions: SessionActionDescriptorRpc[] };

type SessionActionsInput = {
  transport: DesktopTransport;
  /** Re-queries the sidebar for actions that change list state without emitting a runtime event (pin, archive of an index-only session). */
  reloadSidebar: () => Promise<void>;
  onForked: (sessionId: string) => void;
  onArchived: (sessionId: string) => void;
  onResumed: (sessionId: string) => void;
};

/** Right-click actions on sidebar sessions: menu state, execution and a short-lived result notice. */
export const useSessionActions = ({ transport, reloadSidebar, onForked, onArchived, onResumed }: SessionActionsInput) => {
  const [menu, setMenu] = useState<SessionMenu | undefined>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | undefined>();

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(undefined), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const openMenu = useCallback(
    async (event: MouseEvent, sessionId: string) => {
      event.preventDefault();
      const { actions } = await transport.sessionBrowser.getActions(sessionId);
      setMenu({ sessionId, x: event.clientX, y: event.clientY, actions });
    },
    [transport]
  );

  const run = useCallback(
    async (sessionId: string, action: SessionActionDescriptorRpc["action"]) => {
      try {
        const result = await transport.sessionBrowser.runAction({ sessionId, action });
        switch (result.action) {
          case "copy_session_id":
          case "copy_awb_session_id":
            await writeClipboardText(result.copiedText);
            setNotice({ text: "已复制 " + result.copiedText });
            return;
          case "pin":
          case "unpin":
            await reloadSidebar();
            return;
          case "archive":
            onArchived(sessionId);
            await reloadSidebar();
            return;
          case "open_rollout":
            await transport.file.runAction({ path: result.rolloutPath, action: "open" });
            return;
          case "resume":
            onResumed(sessionId);
            setNotice({ text: "已重新连接会话" });
            return;
          case "refresh":
            setNotice({ text: result.details ?? "已刷新运行环境" });
            return;
          case "fork":
            if (result.status === "unsupported") {
              setNotice({ text: result.message, error: true });
              return;
            }
            onForked(result.forkedSessionId);
            await reloadSidebar();
            return;
        }
      } catch (error) {
        setNotice({ text: action + " 失败：" + (error as Error).message, error: true });
      }
    },
    [transport, reloadSidebar, onForked, onArchived, onResumed]
  );

  return { menu, closeMenu: () => setMenu(undefined), openMenu, run, notice, clearNotice: () => setNotice(undefined) };
};
