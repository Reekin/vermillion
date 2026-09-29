import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Folder, FolderOpen, FolderPlus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { Button, ConfigurationButton, IconButton } from "./ui.js";
import type { Workspace } from "@vermillion/workbench/client";
import { useT } from "../../../i18n/react.js";

type WorkspacePickerProps = {
  store: WorkbenchStore;
  /** Opens the native directory dialog; resolves to the chosen root or undefined. */
  pickDirectory: () => Promise<string | undefined>;
  /** When an open session pins the workspace, the picker is locked and shows that workspace. */
  lockedWorkspaceId?: string;
  onOpenDirectory: (path: string) => void;
};

const rowClass = "flex h-8 w-full items-center gap-2 px-2.5 text-left text-label text-foreground outline-none hover:bg-surface-hover focus-visible:bg-surface-hover";

/** Sits in the composer's configuration row; decides where the next new chat is created. */
export const WorkspacePicker = ({ store, pickDirectory, lockedWorkspaceId, onOpenDirectory }: WorkspacePickerProps) => {
  const t = useT();
  const disabled = lockedWorkspaceId !== undefined;
  const client = store((s) => s.client);
  const liveWorkspaces = store((s) => s.workspaces);
  const draftWorkspaceId = store((s) => s.draftWorkspaceId);
  const activeWorkspaceId = lockedWorkspaceId ?? draftWorkspaceId;
  const selectWorkspace = store((s) => s.setDraftWorkspace);
  const addNew = async () => {
    const rootPath = await pickDirectory();
    if (!rootPath) return;
    const workspace = await client.request("workspace.add", { rootPath });
    selectWorkspace(workspace.workspaceId);
  };

  return <WorkspaceMenu workspaces={liveWorkspaces} value={activeWorkspaceId} onChange={selectWorkspace}
    emptyLabel={t("docs.picker.none")} label="Workspace" composer disabled={disabled}
    onAdd={addNew} onOpenDirectory={onOpenDirectory} />;
};

/** Shared workspace list; each caller owns the meaning of its selected value. */
export const WorkspaceMenu = ({ workspaces: liveWorkspaces, value, onChange, emptyLabel, label, composer, disabled, onAdd, onOpenDirectory }: {
  workspaces: Workspace[];
  value?: string;
  onChange: (id: string | undefined) => void;
  emptyLabel: string;
  label: string;
  composer?: boolean;
  disabled?: boolean;
  onAdd?: () => Promise<void>;
  onOpenDirectory: (path: string) => void;
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openWorkspaces, setOpenWorkspaces] = useState<Workspace[]>();
  const workspaces = openWorkspaces ?? liveWorkspaces;
  const current = liveWorkspaces.find((w) => w.workspaceId === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? workspaces.filter((w) => w.label.toLowerCase().includes(q) || w.rootPath.toLowerCase().includes(q)) : workspaces;
  }, [workspaces, query]);
  const choose = (id: string | undefined) => { setOpen(false); onChange(id); };

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); setOpenWorkspaces(next ? liveWorkspaces : undefined); if (!next) setQuery(""); }}>
      <Popover.Trigger
        render={composer ? <ConfigurationButton /> : <Button size="sm" />}
        disabled={disabled}
        aria-label={label}
        className={composer ? "max-w-52" : "min-w-0 flex-1 justify-between"}
      >
        <Folder size={13} className="shrink-0 text-accent-strong" />
        <span className="min-w-0 flex-1 truncate text-left">{current ? current.label : emptyLabel}</span>
        <ChevronDown size={12} className="shrink-0 text-faint-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={composer ? "top" : "bottom"} align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="w-60 overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow">
            <label className="flex h-8 items-center gap-2 border-b border-border px-2.5">
              <Search size={13} className="shrink-0 text-faint-foreground" />
              <input
                data-ui-raw="search box inside popover"
                autoFocus
                aria-label={t("docs.picker.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  event.currentTarget.closest("label")?.nextElementSibling?.querySelector<HTMLButtonElement>("button")?.focus();
                }}
                placeholder={t("docs.picker.search")}
                className="min-w-0 flex-1 bg-transparent text-label text-foreground outline-none placeholder:text-faint-foreground"
              />
            </label>
            <ul aria-label={label} className="max-h-64 overflow-auto py-1" onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-workspace-choice]")];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              event.preventDefault(); buttons[next]?.focus();
            }}>
              <li>
                <button type="button" data-workspace-choice aria-pressed={!value} className={rowClass} onClick={() => choose(undefined)}>
                  <Folder size={14} className="text-faint-foreground" />
                  <span className="text-muted-foreground">{emptyLabel}</span>
                  {!value && <Check size={13} className="ml-auto mr-7 text-strong" />}
                </button>
              </li>
              {filtered.map((workspace) => (
                <li key={workspace.workspaceId} className="group flex items-center pr-1 hover:bg-surface-hover focus-within:bg-surface-hover">
                  <button
                    type="button"
                    data-workspace-choice
                    aria-pressed={workspace.workspaceId === value}
                    title={workspace.rootPath}
                    className={`${rowClass} min-w-0 flex-1`}
                    onClick={() => choose(workspace.workspaceId)}
                  >
                    <Folder size={14} className="shrink-0 text-accent-strong" />
                    <span className="truncate">{workspace.label}</span>
                    {workspace.workspaceId === value && <Check size={13} className="ml-auto shrink-0 text-strong" />}
                  </button>
                  <IconButton icon={FolderOpen} label={t("docs.picker.openDirectory", { label: workspace.label })}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                    onClick={() => onOpenDirectory(workspace.rootPath)} />
                </li>
              ))}
              {workspaces.length > 0 && filtered.length === 0 && (
                <li className="px-2.5 py-1.5 text-caption text-muted-foreground">{t("docs.picker.noMatch")}</li>
              )}
            </ul>
            {onAdd && <div className="border-t border-border py-1">
              <button type="button" className={rowClass} onClick={() => { setOpen(false); void onAdd(); }}>
                <FolderPlus size={14} className="text-muted-foreground" />
                <span>{t("docs.picker.add")}</span>
              </button>
            </div>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
