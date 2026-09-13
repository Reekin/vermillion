import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn.js";

export type ContextMenuItem = {
  key: string;
  label: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
};

type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  zIndex?: number;
};

/** Floating right-click menu anchored at a viewport point; closes on any outside click, key press or another context menu. */
export const ContextMenu = ({ x, y, items, onClose, zIndex }: ContextMenuProps) => {
  useEffect(() => {
    const close = (event: Event) => {
      if (event.type !== "keydown" && (event.target as Element | null)?.closest?.("[data-context-menu]")) return;
      onClose();
    };
    window.addEventListener("click", close, true);
    window.addEventListener("keydown", close);
    window.addEventListener("contextmenu", close, true);
    return () => {
      window.removeEventListener("click", close, true);
      window.removeEventListener("keydown", close);
      window.removeEventListener("contextmenu", close, true);
    };
  }, [onClose]);

  const style = {
    zIndex,
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 30 - 12)
  };

  return createPortal(
    <ul
      role="menu"
      data-context-menu
      className="fixed z-50 min-w-44 rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow"
      style={style}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            className={cn(
              "block w-full px-3 py-1.5 text-left text-label text-foreground hover:bg-surface-hover hover:text-strong",
              item.disabled && "cursor-default text-faint-foreground hover:bg-transparent hover:text-faint-foreground"
            )}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>,
    document.body
  );
};
