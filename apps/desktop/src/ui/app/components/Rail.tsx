import { Inbox, MessageSquare, FolderKanban } from "lucide-react";
import { cn } from "../lib/cn.js";
import type { Panel } from "../workbench-store.js";

type RailProps = {
  panel: Panel;
  overlay: Panel | undefined;
  inboxCount: number;
  onSelect: (panel: Panel) => void;
};

const items: Array<{ id: Panel; label: string; icon: typeof Inbox }> = [
  { id: "think", label: "思考", icon: MessageSquare },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "workspaces", label: "Workspaces", icon: FolderKanban }
];

export const Rail = ({ panel, overlay, inboxCount, onSelect }: RailProps) => (
  <nav className="flex h-full w-12 flex-col items-center gap-1 border-r border-border-strong bg-app-shell pt-3" aria-label="主导航">
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
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-lg text-faint-foreground transition-colors",
            "hover:bg-surface-hover hover:text-foreground",
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
