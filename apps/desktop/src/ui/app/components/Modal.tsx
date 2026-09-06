import { Maximize2, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { IconButton } from "./ui.js";

type ModalProps = {
  title: string;
  titleContent?: ReactNode;
  onClose: () => void;
  onExpand?: () => void;
  width?: number;
  height?: string;
  children: ReactNode;
};

/** Single modal frame for every overlay so they share position, backdrop and chrome. */
export const Modal = ({ title, titleContent, onClose, onExpand, width = 720, height, children }: ModalProps) => {
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
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <h2 className="shrink-0 text-title-sm font-medium text-strong">{title}</h2>
          {titleContent}
          <div className="ml-auto flex items-center gap-0.5">
            {onExpand && (
              <IconButton icon={Maximize2} label="展开为页面" onClick={onExpand} />
            )}
            <IconButton icon={X} label="关闭" onClick={onClose} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
};
