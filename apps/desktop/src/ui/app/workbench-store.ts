import { create } from "zustand";
import type { AgentRun, DecisionCard, DocChange, DocFile, InboxItem, Issue, RoleFile, Scheduler, WorkItem, Workspace, WorkbenchClient, WorkflowAction } from "@vermillion/workbench/client";

export type Panel = "workbench" | "inbox" | "settings";
export type WorkspaceSection = "workItems" | "sessions" | "domains" | "docs" | "roles" | "issues" | "automation";

export type CommitOutcome =
  | { kind: "commit"; commit: string; message: string }
  | { kind: "work"; title: string };
export type TaskTarget = { workspaceId: string; kind: "workItem"; id: string };
export type IssueTarget = { workspaceId: string; issueId: string };
export type TaskSummary = TaskTarget & { title: string; status: WorkItem["status"]; sessionId?: string };

/** Everything that belongs to one workspace, tagged so stale responses can be dropped. */
export type WorkspaceView = {
  workspaceId: string;
  workItems: WorkItem[];
  decisions: DecisionCard[];
  issues: Issue[];
  docs: DocFile[];
  pendingDocChanges: DocChange[];
  roles: RoleFile[];
  scheduler: Scheduler;
  runs: AgentRun[];
  actions: WorkflowAction[];
};

/** What the text editor modal is showing: a doc under .vermillion/docs or a role prompt override. */
export type EditorTarget = { kind: "doc"; path: string; line?: number; column?: number; nonce?: number } | { kind: "role"; roleId: string };


export type WorkbenchState = {
  client: WorkbenchClient;
  panel: Panel;
  overlay: "inbox" | undefined;
  /** Workbench tab selection survives navigation to other panels. */
  workspaceSection: WorkspaceSection;
  expandedInboxDetails: Record<string, boolean>;
  expandedWorkGroups: Record<string, boolean>;
  setWorkGroupExpanded: (workspaceId: string, groupId: string, expanded: boolean) => void;
  workspaces: Workspace[];
  /** Workspace a new chat will be created in. Chosen in the composer; remembered across restarts. */
  draftWorkspaceId: string | undefined;
  /** Workspace whose docs and work items are shown. Follows the open session, or the draft when none. */
  browsingWorkspaceId: string | undefined;
  view: WorkspaceView | undefined;
  /** Why the last view load failed (a bad record, a missing workspace); cleared on the next successful load. */
  viewError: string | undefined;
  inbox: InboxItem[];
  inboxHistory: InboxItem[];
  inboxError: string | undefined;
  tasks: TaskSummary[];
  tasksError: string | undefined;
  taskTarget: TaskTarget | undefined;
  issueTarget: IssueTarget | undefined;
  showTask: (target: TaskTarget) => void;
  showIssue: (target: IssueTarget) => void;
  editor: EditorTarget | undefined;
  /** Open the workbench work-items tab. */
  showTaskBoard: () => void;
  /** Outcome of the last commit dialog action, briefly shown in the global status bar. */
  docCommit: CommitOutcome | undefined;
  setDocCommit: (result: CommitOutcome | undefined) => void;

  setPanel: (panel: Panel) => void;
  openOverlay: (panel: "inbox") => void;
  closeOverlay: () => void;
  setWorkspaceSection: (section: WorkspaceSection) => void;
  toggleInboxDetails: (workspaceId: string, decisionId: string) => void;
  setDraftWorkspace: (workspaceId: string | undefined) => void;
  browseWorkspace: (workspaceId: string | undefined) => void;
  openEditor: (target: EditorTarget | undefined) => void;
  /** Opens any session in the workbench conversation tab. */
  showAgentSession: (workspaceId: string, sessionId: string, turnId?: string) => void;
  navigateSession?: (workspaceId: string, sessionId: string, turnId?: string) => void;
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
          const workItems = await client.request("workItem.list", { workspaceId });
          const tasks: TaskSummary[] = workItems
            .filter((item) => item.status !== "closed" && item.status !== "cancelled")
            .map((item) => ({ workspaceId, kind: "workItem", id: item.workItemId, title: item.title, status: item.status, sessionId: item.run?.sessionId }));
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
        const [workItems, decisions, issues, docs, pendingDocChanges, roles, scheduler, runs, actions] = await Promise.all([
          client.request("workItem.list", { workspaceId }),
          client.request("decision.list", { workspaceId }),
          client.request("issue.list", { workspaceId }),
          client.request("docs.list", { workspaceId }),
          client.request("docs.pending", { workspaceId }),
          client.request("role.list", { workspaceId }),
          client.request("scheduler.get", { workspaceId }),
          client.request("run.list", { workspaceId }),
          client.request("action.list", { workspaceId })
        ]);
        if (generation !== viewGeneration) return;
        set({ view: { workspaceId, workItems, decisions, issues, docs, pendingDocChanges, roles, scheduler, runs, actions }, viewError: undefined });
      } catch (error) {
        if (generation !== viewGeneration) return;
        set({ viewError: (error as Error).message });
      }
    };

    const loadInbox = async () => {
      try {
        const inboxHistory = await client.request("inbox.list", { includeProcessed: true });
        const inbox = inboxHistory.filter((item) => item.kind === "decision" ? !item.card.answer && !item.card.withdrawn : !item.workItem.merge?.acknowledgedAt);
        set({ inbox, inboxHistory, inboxError: undefined });
      } catch (error) {
        set({ inboxError: (error as Error).message });
      }
    };

    return {
      client,
      panel: "workbench",
      overlay: undefined,
      workspaceSection: "sessions",
      expandedInboxDetails: {},
      expandedWorkGroups: {},
      setWorkGroupExpanded: (workspaceId, groupId, expanded) => set((state) => ({
        expandedWorkGroups: { ...state.expandedWorkGroups, [workspaceId + "/" + groupId]: expanded }
      })),
      workspaces: [],
      draftWorkspaceId: undefined,
      browsingWorkspaceId: undefined,
      view: undefined,
      viewError: undefined,
      inbox: [],
      inboxHistory: [],
      inboxError: undefined,
      tasks: [],
      tasksError: undefined,
      taskTarget: undefined,
      issueTarget: undefined,
      showTask: (target) => {
        get().browseWorkspace(target.workspaceId);
        set({ taskTarget: { ...target }, workspaceSection: "workItems", panel: "workbench", overlay: undefined });
      },
      showIssue: (target) => {
        get().browseWorkspace(target.workspaceId);
        set({ issueTarget: target, workspaceSection: "issues", panel: "workbench", overlay: undefined });
      },
      editor: undefined,
      showTaskBoard: () => set({ workspaceSection: "workItems", panel: "workbench", overlay: undefined }),
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
        set({ browsingWorkspaceId: workspaceId, editor: undefined, issueTarget: undefined, view: undefined, viewError: undefined });
        void loadView();
      },
      openEditor: (target) => set({ editor: target }),
      showAgentSession: (workspaceId, sessionId, turnId) => {
        if (get().navigateSession) { get().navigateSession!(workspaceId, sessionId, turnId); return; }
        get().browseWorkspace(workspaceId);
        set({ workspaceSection: "sessions", panel: "workbench", overlay: undefined });
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
            case "actions.changed":
              void loadInbox();
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              return;
            case "workItems.changed":
              void loadTasks();
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              void loadInbox();
              return;
            case "decisions.changed":
            case "issues.changed":
              if (event.workspaceId === get().browsingWorkspaceId) void loadView();
              void loadInbox();
              return;
          }
        });
      }
    };
  });

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;
