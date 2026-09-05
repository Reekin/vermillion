import { create } from "zustand";
import type { AgentRun, DecisionCard, DocChange, DocCommit, DocFile, InboxItem, Mission, RoleFile, Scheduler, WorkItem, Workspace, WorkbenchClient } from "@vermillion/workbench/client";

export type Panel = "think" | "inbox" | "workspaces";

/** Everything that belongs to one workspace, tagged so stale responses can be dropped. */
export type WorkspaceView = {
  workspaceId: string;
  missions: Mission[];
  workItems: WorkItem[];
  decisions: DecisionCard[];
  docs: DocFile[];
  pendingDocChanges: DocChange[];
  roles: RoleFile[];
  scheduler: Scheduler;
  runs: AgentRun[];
};

/** What the text editor modal is showing: a doc under .vermillion/docs or a role prompt override. */
export type EditorTarget = { kind: "doc"; path: string } | { kind: "role"; roleId: string };


export type WorkbenchState = {
  client: WorkbenchClient;
  panel: Panel;
  overlay: Panel | undefined;
  workspaces: Workspace[];
  /** Workspace a new chat will be created in. Chosen in the composer; remembered across restarts. */
  draftWorkspaceId: string | undefined;
  /** Workspace whose docs and missions are shown. Follows the open session, or the draft when none. */
  browsingWorkspaceId: string | undefined;
  view: WorkspaceView | undefined;
  inbox: InboxItem[];
  editor: EditorTarget | undefined;
  /** Last "仅提交" result, shown under the Docs tree until dismissed or the workspace changes. */
  docCommit: DocCommit | undefined;
  setDocCommit: (result: DocCommit | undefined) => void;

  setPanel: (panel: Panel) => void;
  openOverlay: (panel: Panel) => void;
  closeOverlay: () => void;
  setDraftWorkspace: (workspaceId: string | undefined) => void;
  browseWorkspace: (workspaceId: string | undefined) => void;
  openEditor: (target: EditorTarget | undefined) => void;
  /** Subscribes to workbench events and loads initial state. Returns an unsubscribe. */
  connect: () => () => void;
};

const LAST_WORKSPACE_KEY = "vermillion.draftWorkspaceId";

export const createWorkbenchStore = (client: WorkbenchClient) =>
  create<WorkbenchState>((set, get) => {
    let viewGeneration = 0;

    const loadWorkspaces = async () => {
      const workspaces = await client.request("workspace.list", {});
      const remembered = get().draftWorkspaceId ?? localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
      const draftWorkspaceId = workspaces.some((w) => w.workspaceId === remembered) ? remembered : workspaces[0]?.workspaceId;
      const browsing = get().browsingWorkspaceId;
      const browsingWorkspaceId = workspaces.some((w) => w.workspaceId === browsing) ? browsing : draftWorkspaceId;
      set({ workspaces, draftWorkspaceId, browsingWorkspaceId });
      if (draftWorkspaceId) localStorage.setItem(LAST_WORKSPACE_KEY, draftWorkspaceId);
      await loadView();
    };

    const loadView = async () => {
      const workspaceId = get().browsingWorkspaceId;
      const generation = ++viewGeneration;
      if (!workspaceId) {
        set({ view: undefined });
        return;
      }
      const [missions, workItems, decisions, docs, pendingDocChanges, roles, scheduler, runs] = await Promise.all([
        client.request("mission.list", { workspaceId }),
        client.request("workItem.list", { workspaceId }),
        client.request("decision.list", { workspaceId }),
        client.request("docs.list", { workspaceId }),
        client.request("docs.pending", { workspaceId }),
        client.request("role.list", { workspaceId }),
        client.request("scheduler.get", { workspaceId }),
        client.request("run.list", { workspaceId })
      ]);
      if (generation !== viewGeneration) return;
      set({ view: { workspaceId, missions, workItems, decisions, docs, pendingDocChanges, roles, scheduler, runs } });
    };

    const loadInbox = async () => {
      set({ inbox: await client.request("inbox.list", {}) });
    };

    return {
      client,
      panel: "think",
      overlay: undefined,
      workspaces: [],
      draftWorkspaceId: undefined,
      browsingWorkspaceId: undefined,
      view: undefined,
      inbox: [],
      editor: undefined,
      docCommit: undefined,
      setDocCommit: (result) => set({ docCommit: result }),

      setPanel: (panel) => set({ panel, overlay: undefined }),
      openOverlay: (panel) => set({ overlay: panel }),
      closeOverlay: () => set({ overlay: undefined }),
      setDraftWorkspace: (workspaceId) => {
        if (workspaceId) localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
        set({ draftWorkspaceId: workspaceId });
        get().browseWorkspace(workspaceId);
      },
      browseWorkspace: (workspaceId) => {
        if (workspaceId === get().browsingWorkspaceId) return;
        set({ browsingWorkspaceId: workspaceId, editor: undefined, view: undefined, docCommit: undefined });
        void loadView();
      },
      openEditor: (target) => set({ editor: target }),

      connect: () => {
        void loadWorkspaces();
        void loadInbox();
        return client.subscribe((event) => {
          switch (event.type) {
            case "workspaces.changed":
              void loadWorkspaces();
              return;
            case "docs.changed":
            case "roles.changed":
            case "scheduler.changed":
            case "runs.changed":
            case "missions.changed":
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              return;
            case "workItems.changed":
            case "decisions.changed":
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              void loadInbox();
              return;
          }
        });
      }
    };
  });

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;
