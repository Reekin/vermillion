import { Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

type OverlayProps = {
  title: string;
  onClose: () => void;
  onExpand: () => void;
  children: ReactNode;
};

/** Quick-look modal: opens over the current work without unmounting it. */
export const Overlay = ({ title, onClose, onExpand, children }: OverlayProps) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 pt-[12vh]" onMouseDown={onClose} role="presentation">
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-[76vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-surface-border bg-surface-raised surface-shadow"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-title-sm font-semibold">{title}</h2>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground" title="展开为页面" aria-label="展开为页面" onClick={onExpand}><Maximize2 size={15} /></button>
            <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground" title="关闭" aria-label="关闭" onClick={onClose}><X size={16} /></button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
};
