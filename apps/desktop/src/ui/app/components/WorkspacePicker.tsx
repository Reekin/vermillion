import { ChevronDown } from "lucide-react";
import type { WorkbenchStore } from "../workbench-store.js";

export const WorkspacePicker = ({ store }: { store: WorkbenchStore }) => {
  const workspaces = store((s) => s.workspaces);
  const activeWorkspaceId = store((s) => s.activeWorkspaceId);
  const selectWorkspace = store((s) => s.selectWorkspace);
  return (
    <label className="relative block">
      <span className="sr-only">Workspace</span>
      <select
        aria-label="Workspace"
        value={activeWorkspaceId ?? ""}
        onChange={(event) => void selectWorkspace(event.target.value || undefined)}
        className="h-8 w-full appearance-none rounded-md border border-input bg-surface pl-3 pr-8 text-label text-foreground outline-none focus:border-ring"
      >
        {workspaces.length === 0 && <option value="">没有 workspace</option>}
        {workspaces.map((workspace) => (
          <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.label}</option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
    </label>
  );
};
