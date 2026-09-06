import { create } from "zustand";
import type { AgentRun, DecisionCard, DocChange, DocFile, InboxItem, Mission, RoleFile, Scheduler, WorkItem, Workspace, WorkbenchClient } from "@vermillion/workbench/client";

export type Panel = "think" | "inbox" | "workspaces";
export type WorkspaceSection = "missions" | "sessions" | "domains" | "docs" | "roles" | "issues" | "automation";

export type CommitOutcome =
  | { kind: "commit"; commit: string; message: string }
  | { kind: "mission"; missionId: string; title: string; appended: boolean };

export type TaskTarget = { workspaceId: string; kind: "mission" | "workItem"; id: string };
export type TaskSummary = TaskTarget & { title: string; status: Mission["status"] | WorkItem["status"]; progress?: string };

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
  /** Panel view state survives switching between overlay and page. */
  workspaceSection: WorkspaceSection;
  expandedInboxDetails: Record<string, boolean>;
  workspaces: Workspace[];
  /** Workspace a new chat will be created in. Chosen in the composer; remembered across restarts. */
  draftWorkspaceId: string | undefined;
  /** Workspace whose docs and missions are shown. Follows the open session, or the draft when none. */
  browsingWorkspaceId: string | undefined;
  view: WorkspaceView | undefined;
  /** Why the last view load failed (a bad record, a missing workspace); cleared on the next successful load. */
  viewError: string | undefined;
  inbox: InboxItem[];
  inboxError: string | undefined;
  tasks: TaskSummary[];
  tasksError: string | undefined;
  taskTarget: TaskTarget | undefined;
  showTask: (target: TaskTarget) => void;
  editor: EditorTarget | undefined;
  /** Agent session shown in Workspaces → 会话; set by "会话" links in Inbox and the task board. */
  agentSessionId: string | undefined;
  /** "另有 N 项已结束" in the overlay: open the full task board as a page. */
  showTaskBoard: () => void;
  /** Outcome of the last commit dialog action, briefly shown in the global status bar. */
  docCommit: CommitOutcome | undefined;
  setDocCommit: (result: CommitOutcome | undefined) => void;

  setPanel: (panel: Panel) => void;
  openOverlay: (panel: Panel) => void;
  closeOverlay: () => void;
  setWorkspaceSection: (section: WorkspaceSection) => void;
  toggleInboxDetails: (workspaceId: string, decisionId: string) => void;
  setDraftWorkspace: (workspaceId: string | undefined) => void;
  browseWorkspace: (workspaceId: string | undefined) => void;
  openEditor: (target: EditorTarget | undefined) => void;
  selectAgentSession: (sessionId: string) => void;
  /** Switches to the Workspaces page, 会话 tab, showing this agent session in its workspace. */
  showAgentSession: (workspaceId: string, sessionId: string) => void;
  /** Subscribes to workbench events and loads initial state. Returns an unsubscribe. */
  connect: () => () => void;
};

const LAST_WORKSPACE_KEY = "vermillion.draftWorkspaceId";

export const createWorkbenchStore = (client: WorkbenchClient) =>
  create<WorkbenchState>((set, get) => {
    let viewGeneration = 0;
    let tasksGeneration = 0;

    const loadTasks = async () => {
      const generation = ++tasksGeneration;
      try {
        const groups = await Promise.all(get().workspaces.map(async ({ workspaceId }) => {
          const [missions, workItems] = await Promise.all([
            client.request("mission.list", { workspaceId }),
            client.request("workItem.list", { workspaceId })
          ]);
          const tasks: TaskSummary[] = missions.filter((m) => m.status === "active").map((mission) => {
            const items = workItems.filter((w) => w.missionId === mission.missionId);
            return { workspaceId, kind: "mission", id: mission.missionId, title: mission.title, status: mission.status,
              progress: `${items.filter((w) => w.status === "closed").length}/${items.length}` };
          });
          for (const item of workItems) {
            if (!item.missionId && ["queued", "running", "review", "decision"].includes(item.status)) {
              tasks.push({ workspaceId, kind: "workItem", id: item.workItemId, title: item.title, status: item.status });
            }
          }
          return tasks;
        }));
        if (generation === tasksGeneration) set({ tasks: groups.flat(), tasksError: undefined });
      } catch (error) {
        if (generation === tasksGeneration) set({ tasksError: (error as Error).message });
      }
    };

    const loadWorkspaces = async () => {
      const workspaces = await client.request("workspace.list", {});
      const remembered = get().draftWorkspaceId ?? localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
      const draftWorkspaceId = workspaces.some((w) => w.workspaceId === remembered) ? remembered : workspaces[0]?.workspaceId;
      const browsing = get().browsingWorkspaceId;
      const browsingWorkspaceId = workspaces.some((w) => w.workspaceId === browsing) ? browsing : draftWorkspaceId;
      set({ workspaces, draftWorkspaceId, browsingWorkspaceId });
      if (draftWorkspaceId) localStorage.setItem(LAST_WORKSPACE_KEY, draftWorkspaceId);
      await Promise.all([loadView(), loadTasks()]);
    };

    const loadView = async () => {
      const workspaceId = get().browsingWorkspaceId;
      const generation = ++viewGeneration;
      if (!workspaceId) {
        set({ view: undefined });
        return;
      }
      try {
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
        set({ view: { workspaceId, missions, workItems, decisions, docs, pendingDocChanges, roles, scheduler, runs }, viewError: undefined });
      } catch (error) {
        if (generation !== viewGeneration) return;
        set({ viewError: (error as Error).message });
      }
    };

    const loadInbox = async () => {
      try {
        set({ inbox: await client.request("inbox.list", {}), inboxError: undefined });
      } catch (error) {
        set({ inboxError: (error as Error).message });
      }
    };

    return {
      client,
      panel: "think",
      overlay: undefined,
      workspaceSection: "missions",
      expandedInboxDetails: {},
      workspaces: [],
      draftWorkspaceId: undefined,
      browsingWorkspaceId: undefined,
      view: undefined,
      viewError: undefined,
      inbox: [],
      inboxError: undefined,
      tasks: [],
      tasksError: undefined,
      taskTarget: undefined,
      showTask: (target) => {
        get().browseWorkspace(target.workspaceId);
        set({ taskTarget: { ...target }, agentSessionId: undefined, workspaceSection: "missions", overlay: "workspaces" });
      },
      editor: undefined,
      agentSessionId: undefined,
      showTaskBoard: () => set({ workspaceSection: "missions", panel: "workspaces", overlay: undefined }),
      docCommit: undefined,
      setDocCommit: (result) => set({ docCommit: result }),

      setPanel: (panel) => set({ panel, overlay: undefined }),
      openOverlay: (panel) => set({ overlay: panel }),
      closeOverlay: () => set({ overlay: undefined }),
      setWorkspaceSection: (workspaceSection) => set({ workspaceSection }),
      toggleInboxDetails: (workspaceId, decisionId) => {
        const key = workspaceId + "/" + decisionId;
        set((state) => ({ expandedInboxDetails: { ...state.expandedInboxDetails, [key]: !state.expandedInboxDetails[key] } }));
      },
      setDraftWorkspace: (workspaceId) => {
        if (workspaceId) localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
        set({ draftWorkspaceId: workspaceId });
        get().browseWorkspace(workspaceId);
      },
      browseWorkspace: (workspaceId) => {
        if (workspaceId === get().browsingWorkspaceId) return;
        set({ browsingWorkspaceId: workspaceId, editor: undefined, view: undefined, viewError: undefined });
        void loadView();
      },
      openEditor: (target) => set({ editor: target }),
      selectAgentSession: (agentSessionId) => set({ agentSessionId }),
      showAgentSession: (workspaceId, sessionId) => {
        get().browseWorkspace(workspaceId);
        set({ agentSessionId: sessionId, workspaceSection: "sessions", panel: "workspaces", overlay: undefined });
      },

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
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              return;
            case "missions.changed":
            case "workItems.changed":
              void loadTasks();
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              void loadInbox();
              return;
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
