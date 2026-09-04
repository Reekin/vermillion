import { create } from "zustand";
import type { DocChange, DocFile, InboxItem, Mission, Workspace, WorkbenchClient } from "@vermillion/workbench/client";

export type Panel = "think" | "inbox" | "workspaces";

export type WorkbenchState = {
  client: WorkbenchClient;
  panel: Panel;
  overlay: Panel | undefined;
  workspaces: Workspace[];
  workspaceRevision: number;
  activeWorkspaceId: string | undefined;
  inbox: InboxItem[];
  missions: Mission[];
  docs: DocFile[];
  pendingDocChanges: DocChange[];
  openDocPath: string | undefined;
  setPanel: (panel: Panel) => void;
  openOverlay: (panel: Panel) => void;
  closeOverlay: () => void;
  refreshWorkspaces: () => Promise<void>;
  selectWorkspace: (workspaceId: string | undefined) => Promise<void>;
  refreshInbox: () => Promise<void>;
  refreshWorkspaceData: () => Promise<void>;
  setOpenDocPath: (path: string | undefined) => void;
};

export const createWorkbenchStore = (client: WorkbenchClient) =>
  create<WorkbenchState>((set, get) => ({
    client,
    panel: "think",
    overlay: undefined,
    workspaces: [],
    workspaceRevision: 0,
    activeWorkspaceId: undefined,
    inbox: [],
    missions: [],
    docs: [],
    pendingDocChanges: [],
    openDocPath: undefined,
    setPanel: (panel) => set({ panel, overlay: undefined }),
    openOverlay: (panel) => set({ overlay: panel }),
    closeOverlay: () => set({ overlay: undefined }),
    refreshWorkspaces: async () => {
      const workspaces = await client.request("workspace.list", {});
      const activeWorkspaceId = get().activeWorkspaceId;
      const stillExists = workspaces.some((w) => w.workspaceId === activeWorkspaceId);
      set({ workspaces, workspaceRevision: get().workspaceRevision + 1, activeWorkspaceId: stillExists ? activeWorkspaceId : workspaces[0]?.workspaceId });
      await get().refreshWorkspaceData();
    },
    selectWorkspace: async (workspaceId) => {
      set({ activeWorkspaceId: workspaceId, openDocPath: undefined });
      await get().refreshWorkspaceData();
    },
    refreshInbox: async () => {
      set({ inbox: await client.request("inbox.list", {}) });
    },
    refreshWorkspaceData: async () => {
      const workspaceId = get().activeWorkspaceId;
      if (!workspaceId) {
        set({ missions: [], docs: [], pendingDocChanges: [] });
        return;
      }
      const [missions, docs, pendingDocChanges] = await Promise.all([
        client.request("mission.list", { workspaceId }),
        client.request("docs.list", { workspaceId }),
        client.request("docs.pending", { workspaceId })
      ]);
      set({ missions, docs, pendingDocChanges });
    },
    setOpenDocPath: (path) => set({ openDocPath: path })
  }));

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;
