import type { SessionActionDescriptorRpc } from "@vermillion/shared";
import type { SessionMenu } from "../use-session-actions.js";
import { cn } from "../lib/cn.js";
import { ContextMenu } from "./ContextMenu.js";

type Props = {
  menu: SessionMenu | undefined;
  onCloseMenu: () => void;
  onRunAction: (sessionId: string, action: SessionActionDescriptorRpc["action"]) => void;
  /** Session rows add a rename entry driven by the app shell; other menus leave it out. */
  onOpenRename?: (sessionId: string, title: string) => void;
  notice: { text: string; error?: boolean } | undefined;
  onClearNotice: () => void;
};

export const SessionActionFeedback = ({ menu, onCloseMenu, onRunAction, onOpenRename, notice, onClearNotice }: Props) => {
  const renameTitle = menu?.title;
  return (
    <>
      {notice && (
        <div role="status" className={cn("flex items-start gap-2 border-t border-border px-4 py-2 text-caption", notice.error ? "text-strong" : "text-muted-foreground")}>
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          {notice.error && <button type="button" className="shrink-0 text-faint-foreground hover:text-foreground" onClick={onClearNotice}>关闭</button>}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={onCloseMenu}
          items={[
            ...(onOpenRename && renameTitle ? [{ key: "rename", label: "Rename", onSelect: () => onOpenRename(menu.sessionId, renameTitle) }] : []),
            ...menu.actions.map((action) => ({
              key: action.action,
              label: action.label,
              disabled: action.disabled,
              title: action.reason,
              onSelect: () => onRunAction(menu.sessionId, action.action)
            }))
          ]}
        />
      )}
    </>
  );
};
