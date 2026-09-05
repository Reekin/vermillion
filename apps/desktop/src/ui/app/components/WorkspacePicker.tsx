import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Folder, FolderPlus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { cn } from "../lib/cn.js";

type WorkspacePickerProps = {
  store: WorkbenchStore;
  /** Opens the native directory dialog; resolves to the chosen root or undefined. */
  pickDirectory: () => Promise<string | undefined>;
  disabled?: boolean;
};

const rowClass = "flex h-8 w-full items-center gap-2 px-2.5 text-left text-label text-foreground outline-none hover:bg-surface-hover data-[highlighted]:bg-surface-hover";

/** Sits in the composer's configuration row; decides where New Chat lands. */
export const WorkspacePicker = ({ store, pickDirectory, disabled }: WorkspacePickerProps) => {
  const client = store((s) => s.client);
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.activeWorkspaceId);
  const selectWorkspace = store((s) => s.selectWorkspace);
  const refreshWorkspaces = store((s) => s.refreshWorkspaces);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const current = workspaces.find((w) => w.workspaceId === activeWorkspaceId);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? workspaces.filter((w) => w.label.toLowerCase().includes(q) || w.rootPath.toLowerCase().includes(q)) : workspaces;
  }, [workspaces, query]);

  const choose = async (workspaceId: string | undefined) => {
    setOpen(false);
    await selectWorkspace(workspaceId);
  };

  const addNew = async () => {
    setOpen(false);
    const rootPath = await pickDirectory();
    if (!rootPath) return;
    const workspace = await client.request("workspace.add", { rootPath });
    await refreshWorkspaces();
    await selectWorkspace(workspace.workspaceId);
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <Popover.Trigger
        disabled={disabled}
        aria-label="Workspace"
        className={cn(
          "flex h-[27px] max-w-52 items-center gap-1.5 rounded-sm border border-border-strong bg-input px-2 text-caption text-foreground",
          "hover:border-control-border-hover disabled:opacity-50"
        )}
      >
        <Folder size={13} className="shrink-0 text-accent-strong" />
        <span className="truncate">{current ? current.label : "无 workspace"}</span>
        <ChevronDown size={12} className="shrink-0 text-faint-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="w-60 overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow">
            <label className="flex h-8 items-center gap-2 border-b border-border px-2.5">
              <Search size={13} className="shrink-0 text-faint-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 workspace…"
                className="min-w-0 flex-1 bg-transparent text-label text-foreground outline-none placeholder:text-faint-foreground"
              />
            </label>
            <ul role="listbox" className="max-h-64 overflow-auto py-1">
              <li>
                <button type="button" role="option" aria-selected={!activeWorkspaceId} className={rowClass} onClick={() => void choose(undefined)}>
                  <Folder size={14} className="text-faint-foreground" />
                  <span className="text-muted-foreground">无 workspace</span>
                  {!activeWorkspaceId && <Check size={13} className="ml-auto text-strong" />}
                </button>
              </li>
              {filtered.map((workspace) => (
                <li key={workspace.workspaceId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={workspace.workspaceId === activeWorkspaceId}
                    title={workspace.rootPath}
                    className={rowClass}
                    onClick={() => void choose(workspace.workspaceId)}
                  >
                    <Folder size={14} className="text-accent-strong" />
                    <span className="truncate">{workspace.label}</span>
                    {workspace.workspaceId === activeWorkspaceId && <Check size={13} className="ml-auto text-strong" />}
                  </button>
                </li>
              ))}
              {workspaces.length > 0 && filtered.length === 0 && (
                <li className="px-2.5 py-1.5 text-caption text-muted-foreground">没有匹配的 workspace</li>
              )}
            </ul>
            <div className="border-t border-border py-1">
              <button type="button" className={rowClass} onClick={() => void addNew()}>
                <FolderPlus size={14} className="text-muted-foreground" />
                <span>新建 workspace…</span>
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
