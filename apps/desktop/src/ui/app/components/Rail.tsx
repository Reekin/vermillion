import { Inbox, PanelsTopLeft, Settings } from "lucide-react";
import { cn } from "../lib/cn.js";
import type { Panel } from "../workbench-store.js";

type RailProps = {
  panel: Panel;
  overlay: "inbox" | undefined;
  inboxCount: number;
  onSelect: (panel: Panel) => void;
  onOpenPage: (panel: Panel) => void;
};

const items: Array<{ id: Panel; label: string; icon: typeof Inbox }> = [
  { id: "workbench", label: "工作台", icon: PanelsTopLeft },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "settings", label: "设置", icon: Settings }
];

export const Rail = ({ panel, overlay, inboxCount, onSelect, onOpenPage }: RailProps) => (
  <nav className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border-strong bg-app-shell py-3" aria-label="主导航">
    {items.map(({ id, label, icon: Icon }) => {
      const active = overlay ? overlay === id : panel === id;
      return (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(id)}
          onDoubleClick={id === "inbox" ? () => onOpenPage(id) : undefined}
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-lg text-faint-foreground transition-colors",
            "hover:bg-surface-hover hover:text-foreground",
            id === "settings" && "mt-auto",
            active && "bg-surface-selected text-strong"
          )}
        >
          <Icon size={17} strokeWidth={1.6} />
          {id === "inbox" && inboxCount > 0 && (
            <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-sm bg-accent-strong px-1 text-center font-mono text-micro leading-none text-page-canvas py-0.5">{inboxCount}</span>
          )}
        </button>
      );
    })}
  </nav>
);
