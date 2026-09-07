import { Maximize2, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./ui.js";
import { cn } from "../lib/cn.js";

type ModalProps = {
  title: string;
  titleContent?: ReactNode;
  onClose: () => void;
  onExpand?: () => void;
  width?: number;
  height?: string;
  children: ReactNode;
  presentation?: "modal" | "page" | "hidden";
  contained?: boolean;
};

/** Single modal frame for every overlay so they share position, backdrop and chrome. */
export const Modal = ({ title, titleContent, onClose, onExpand, width = 720, height, children, presentation = "modal", contained = false }: ModalProps) => {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (presentation !== "modal") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) === dialog.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, presentation]);

  return (
    <div className={cn(presentation === "hidden" ? "hidden" : presentation === "page" ? "h-full" : "inset-0 z-40 flex items-start justify-center bg-black/55 px-3 pt-[10vh]", presentation === "modal" && (contained ? "absolute" : "fixed"))} onMouseDown={presentation === "modal" ? onClose : undefined} role="presentation">
      <div
        ref={dialog}
        role={presentation === "modal" ? "dialog" : undefined}
        aria-label={title}
        className={cn("flex flex-col overflow-hidden", presentation === "modal" ? "max-h-[78vh] max-w-full rounded-lg border border-border-strong bg-surface-raised floating-shadow" : "h-full")}
        style={presentation === "modal" ? { width, height } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <h2 className="min-w-0 truncate text-title font-semibold text-strong" title={title}>{title}</h2>
          {presentation === "modal" && titleContent}
          {presentation === "modal" && <div className="ml-auto flex items-center gap-0.5">
            {onExpand && (
              <IconButton icon={Maximize2} label="展开为页面" onClick={onExpand} />
            )}
            <IconButton icon={X} label="关闭" onClick={onClose} />
          </div>}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
};
