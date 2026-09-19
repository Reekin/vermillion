import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { writeClipboardText } from "../chat-shell/clipboard.js";

/**
 * 右键菜单按动作集合参数化：会话行用会话动作，会话树节点用节点动作。
 * Session rows also carry the displayed title so the rename entry can prefill the current name.
 */
export type SessionMenu<TAction extends string = SessionActionDescriptorRpc["action"]> = {
  sessionId: string;
  title?: string;
  x: number;
  y: number;
  actions: (Omit<SessionActionDescriptorRpc, "action"> & { action: TAction })[];
};

export type SessionRename = { sessionId: string; title: string; busy: boolean; error?: string };

export type SessionRenameController = {
  state: SessionRename | undefined;
  open: (sessionId: string, title: string) => void;
  close: () => void;
  submit: (title: string) => void;
};

type SessionActionsInput = {
  transport: DesktopTransport;
  /** Re-reads the changed rows for actions that change list state without emitting a runtime event (pin, archive of an index-only session). */
  refreshSidebar: () => Promise<void>;
  onArchived: (sessionId: string) => void;
  onResumed: (sessionId: string) => void;
};

/** Right-click actions on sidebar sessions: menu state, execution and a short-lived result notice. */
export const useSessionActions = ({ transport, refreshSidebar, onArchived, onResumed }: SessionActionsInput) => {
  const [menu, setMenu] = useState<SessionMenu | undefined>();
  const [rename, setRename] = useState<SessionRename | undefined>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | undefined>();

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(undefined), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const openMenu = useCallback(
    async (event: MouseEvent, sessionId: string, title: string) => {
      event.preventDefault();
      const { actions } = await transport.sessionBrowser.getActions(sessionId);
      setMenu({ sessionId, title, x: event.clientX, y: event.clientY, actions: actions.filter((action) => action.action !== "fork") });
    },
    [transport]
  );

  const openRename = useCallback((sessionId: string, title: string) => setRename({ sessionId, title, busy: false }), []);

  const closeRename = useCallback(() => setRename(undefined), []);

  const submitRename = useCallback(
    (title: string) => {
      if (!rename || rename.busy) return;
      setRename({ ...rename, busy: true, error: undefined });
      void (async () => {
        try {
          await transport.sessionBrowser.rename({ sessionId: rename.sessionId, title });
          setRename(undefined);
          await refreshSidebar();
        } catch (error) {
          setRename((current) => (current ? { ...current, busy: false, error: (error as Error).message } : current));
        }
      })();
    },
    [rename, transport, refreshSidebar]
  );

  const renameDialog: SessionRenameController = { state: rename, open: openRename, close: closeRename, submit: submitRename };

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
            await refreshSidebar();
            return;
          case "archive":
            onArchived(sessionId);
            await refreshSidebar();
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
        }
      } catch (error) {
        setNotice({ text: action + " 失败：" + (error as Error).message, error: true });
      }
    },
    [transport, refreshSidebar, onArchived, onResumed]
  );

  return { menu, closeMenu: () => setMenu(undefined), openMenu, run, notice, clearNotice: () => setNotice(undefined), renameDialog };
};
