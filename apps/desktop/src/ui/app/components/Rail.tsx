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
  <nav className="flex h-full w-14 flex-col items-center gap-1 border-r border-border bg-app-shell py-3" aria-label="主导航">
    <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-brand text-brand-foreground font-semibold" title="Vermillion">朱</div>
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
            "relative flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-surface-hover hover:text-foreground",
            active && "bg-surface-selected text-foreground"
          )}
        >
          <Icon size={18} strokeWidth={1.75} />
          {id === "inbox" && inboxCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-brand px-1 text-center text-micro font-semibold text-brand-foreground">{inboxCount}</span>
          )}
        </button>
      );
    })}
  </nav>
);
