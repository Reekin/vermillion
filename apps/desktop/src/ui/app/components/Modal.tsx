import { Maximize2, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

type ModalProps = {
  title: string;
  onClose: () => void;
  onExpand?: () => void;
  width?: number;
  height?: string;
  children: ReactNode;
};

/** Single modal frame for every overlay so they share position, backdrop and chrome. */
export const Modal = ({ title, onClose, onExpand, width = 720, height, children }: ModalProps) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 pt-[10vh]" onMouseDown={onClose} role="presentation">
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-[78vh] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-raised floating-shadow"
        style={{ width, height }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-10 items-center gap-2 border-b border-border px-4">
          <h2 className="text-title-sm font-medium text-strong">{title}</h2>
          <div className="ml-auto flex items-center gap-0.5">
            {onExpand && (
              <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-hover hover:text-strong" title="展开为页面" aria-label="展开为页面" onClick={onExpand}><Maximize2 size={14} /></button>
            )}
            <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-hover hover:text-strong" title="关闭" aria-label="关闭" onClick={onClose}><X size={15} /></button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
};
