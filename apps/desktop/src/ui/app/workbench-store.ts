import { create } from "zustand";
import type { AgentRun, DecisionCard, DocChange, DocFile, DomainDefinition, InboxItem, Issue, PatrolRun, RoleFile, Scheduler, WorkItem, WorkRequest, Workspace, WorkbenchClient, WorkflowAction } from "@vermillion/workbench/client";

/** Full-area panels: the workbench, and Inbox when it is expanded out of its popup. */
export type Panel = "workbench" | "inbox";
/** Entries that open over the current panel instead of replacing it. */
export type Overlay = "inbox" | "settings";
export type WorkspaceSection = "workItems" | "sessions" | "domains" | "docs" | "roles" | "issues" | "automation" | "manage";

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
  workRequests: WorkRequest[];
  decisions: DecisionCard[];
  issues: Issue[];
  domains: DomainDefinition[];
  patrolRuns: PatrolRun[];
  docs: DocFile[];
  pendingDocChanges: DocChange[];
  roles: RoleFile[];
  scheduler: Scheduler;
  runs: AgentRun[];
  actions: WorkflowAction[];
};

type WorkspaceViewField = Exclude<keyof WorkspaceView, "workspaceId">;

const allWorkspaceViewFields: readonly WorkspaceViewField[] = [
  "workItems",
  "workRequests",
  "decisions",
  "issues",
  "domains",
  "patrolRuns",
  "docs",
  "pendingDocChanges",
  "roles",
  "scheduler",
  "runs",
  "actions"
];

/** What the text editor modal is showing: a doc under .vermillion/docs or a role prompt override. */
export type EditorTarget = { kind: "doc"; path: string; line?: number; column?: number; nonce?: number; sessionId?: string }
  | { kind: "maintainer"; domainId: string; path: string; nonce?: number }
  | { kind: "role"; roleId: string };


export type WorkbenchState = {
  client: WorkbenchClient;
  panel: Panel;
  overlay: Overlay | undefined;
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
  /** Session whose conversation tree's documents the explorer shows; undefined browses the main branch. */
  docsSessionId: string | undefined;
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
  openOverlay: (panel: Overlay) => void;
  closeOverlay: () => void;
  setWorkspaceSection: (section: WorkspaceSection) => void;
  toggleInboxDetails: (workspaceId: string, decisionId: string) => void;
  setDraftWorkspace: (workspaceId: string | undefined) => void;
  browseWorkspace: (workspaceId: string | undefined) => void;
  setDocsSessionId: (sessionId: string | undefined) => void;
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
    type ViewRefresh = {
      workspaceId: string;
      docsSessionId: string | undefined;
      epoch: number;
      pending: Set<WorkspaceViewField>;
      scheduled: boolean;
      running: Set<WorkspaceViewField>;
      values: Partial<WorkspaceView>;
      errors: Map<WorkspaceViewField, string>;
    };
    const viewRefreshes = new Map<string, ViewRefresh>();
    let inboxLoadScheduledEpoch: number | undefined;
    let inboxLoadRunningEpoch: number | undefined;
    let inboxDirty = false;
    let taskLoadScheduledEpoch: number | undefined;
    let taskLoadRunningEpoch: number | undefined;
    const pendingTaskWorkspaceIds = new Set<string>();
    const workspaceOwners = new Map<string, object>();
    let connected = false;
    let connectionEpoch = 0;

    const readViewField = async (
      field: WorkspaceViewField,
      workspaceId: string,
      docsSessionId: string | undefined
    ): Promise<Partial<WorkspaceView>> => {
      switch (field) {
        case "workItems": return { workItems: await client.request("workItem.list", { workspaceId }) };
        case "workRequests": return { workRequests: await client.request("work.list", { workspaceId }) };
        case "decisions": return { decisions: await client.request("decision.list", { workspaceId }) };
        case "issues": return { issues: await client.request("issue.list", { workspaceId }) };
        case "domains": return { domains: await client.request("domain.list", { workspaceId }) };
        case "patrolRuns": return { patrolRuns: await client.request("domain.patrol.list", { workspaceId }) };
        case "docs": return { docs: await client.request("docs.list", { workspaceId, sessionId: docsSessionId }) };
        case "pendingDocChanges": return { pendingDocChanges: await client.request("docs.pending", { workspaceId, sessionId: docsSessionId }) };
        case "roles": return { roles: await client.request("role.list", { workspaceId }) };
        case "scheduler": return { scheduler: await client.request("scheduler.get", { workspaceId }) };
        case "runs": return { runs: await client.request("run.list", { workspaceId }) };
        case "actions": return { actions: await client.request("action.list", { workspaceId }) };
      }
    };

    const drainTasks = async () => {
      if (
        !connected ||
        taskLoadRunningEpoch === connectionEpoch ||
        pendingTaskWorkspaceIds.size === 0
      ) return;
      const epoch = connectionEpoch;
      taskLoadRunningEpoch = epoch;
      const workspaceIds = [...pendingTaskWorkspaceIds];
      const owners = new Map(workspaceIds.map((id) => [id, workspaceOwners.get(id)]));
      pendingTaskWorkspaceIds.clear();
      try {
        const groups = await Promise.all(workspaceIds.map(async (workspaceId) => {
          const workItems = await client.request("workItem.list", { workspaceId });
          const tasks: TaskSummary[] = workItems
            .filter((item) => item.status !== "closed" && item.status !== "cancelled")
            .map((item) => ({ workspaceId, kind: "workItem", id: item.workItemId, title: item.title, status: item.status, sessionId: item.run?.sessionId }));
          return { workspaceId, tasks };
        }));
        if (!connected || epoch !== connectionEpoch) return;
        const freshGroups = groups.filter(({ workspaceId }) =>
          !pendingTaskWorkspaceIds.has(workspaceId) &&
          owners.get(workspaceId) !== undefined &&
          workspaceOwners.get(workspaceId) === owners.get(workspaceId)
        );
        const refreshed = new Set(freshGroups.map(({ workspaceId }) => workspaceId));
        set((state) => ({
          tasks: [
            ...state.tasks.filter((task) => !refreshed.has(task.workspaceId)),
            ...freshGroups.flatMap(({ tasks }) => tasks)
          ],
          tasksError: undefined
        }));
      } catch (error) {
        if (connected && epoch === connectionEpoch) {
          set({ tasksError: (error as Error).message });
        }
      } finally {
        if (taskLoadRunningEpoch === epoch) taskLoadRunningEpoch = undefined;
        if (connected && epoch === connectionEpoch && pendingTaskWorkspaceIds.size > 0) {
          scheduleTasks([]);
        }
      }
    };

    const scheduleTasks = (workspaceIds: readonly string[]) => {
      if (!connected) return;
      for (const workspaceId of workspaceIds) {
        if (workspaceOwners.has(workspaceId)) pendingTaskWorkspaceIds.add(workspaceId);
      }
      if (
        taskLoadScheduledEpoch === connectionEpoch ||
        taskLoadRunningEpoch === connectionEpoch ||
        pendingTaskWorkspaceIds.size === 0
      ) return;
      const epoch = connectionEpoch;
      taskLoadScheduledEpoch = epoch;
      queueMicrotask(() => {
        if (taskLoadScheduledEpoch !== epoch) return;
        taskLoadScheduledEpoch = undefined;
        void drainTasks();
      });
    };

    const loadWorkspaces = async (epoch = connectionEpoch) => {
      const workspaces = await client.request("workspace.list", {});
      if (!connected || epoch !== connectionEpoch) return;
      const remembered = get().draftWorkspaceId ?? localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
      const draftWorkspaceId = workspaces.some((w) => w.workspaceId === remembered) ? remembered : workspaces[0]?.workspaceId;
      const browsing = get().browsingWorkspaceId;
      const browsingWorkspaceId = workspaces.some((w) => w.workspaceId === browsing) ? browsing : draftWorkspaceId;
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId));
      for (const id of workspaceOwners.keys()) {
        if (!workspaceIds.has(id)) {
          workspaceOwners.delete(id);
          pendingTaskWorkspaceIds.delete(id);
        }
      }
      for (const id of workspaceIds) {
        if (!workspaceOwners.has(id)) workspaceOwners.set(id, {});
      }
      for (const [key, refresh] of viewRefreshes) {
        if (!workspaceIds.has(refresh.workspaceId)) viewRefreshes.delete(key);
      }
      set((state) => ({
        workspaces,
        draftWorkspaceId,
        browsingWorkspaceId,
        tasks: state.tasks.filter((task) => workspaceIds.has(task.workspaceId))
      }));
      if (draftWorkspaceId) localStorage.setItem(LAST_WORKSPACE_KEY, draftWorkspaceId);
      loadView();
      scheduleTasks(workspaces.map((workspace) => workspace.workspaceId));
    };

    const viewRefreshKey = (
      workspaceId: string,
      docsSessionId: string | undefined
    ) => JSON.stringify([workspaceId, docsSessionId ?? null]);

    const isCurrentRefresh = (refresh: ViewRefresh) =>
      connected && refresh.epoch === connectionEpoch &&
      viewRefreshes.get(viewRefreshKey(refresh.workspaceId, refresh.docsSessionId)) === refresh;

    const drainView = (refresh: ViewRefresh) => {
      if (
        !isCurrentRefresh(refresh) ||
        refresh.pending.size === 0
      ) return;
      for (const field of refresh.pending) {
        if (refresh.running.has(field)) continue;
        refresh.pending.delete(field);
        refresh.running.add(field);
        void (async () => {
          try {
            const patch = await readViewField(field, refresh.workspaceId, refresh.docsSessionId);
            if (!isCurrentRefresh(refresh) || refresh.pending.has(field)) return;
            Object.assign(refresh.values, patch);
            refresh.errors.delete(field);
          } catch (error) {
            if (!isCurrentRefresh(refresh) || refresh.pending.has(field)) return;
            refresh.errors.set(field, error instanceof Error ? error.message : String(error));
          } finally {
            refresh.running.delete(field);
            if (isCurrentRefresh(refresh)) {
              if (refresh.workspaceId === get().browsingWorkspaceId &&
                  refresh.docsSessionId === get().docsSessionId) {
                const ready = allWorkspaceViewFields.every((key) => key in refresh.values);
                set({
                  ...(ready ? { view: { ...refresh.values, workspaceId: refresh.workspaceId } as WorkspaceView } : {}),
                  viewError: refresh.errors.values().next().value
                });
              }
              if (refresh.pending.size > 0) scheduleView([], refresh);
            }
          }
        })();
      }
    };

    const scheduleView = (
      fields: readonly WorkspaceViewField[],
      existingRefresh?: ViewRefresh
    ) => {
      if (!connected) return;
      const workspaceId = existingRefresh?.workspaceId ?? get().browsingWorkspaceId;
      const docsSessionId = existingRefresh ? existingRefresh.docsSessionId : get().docsSessionId;
      if (!workspaceId) {
        set({ view: undefined });
        return;
      }
      const key = viewRefreshKey(workspaceId, docsSessionId);
      // Only the visible target owns view requests and their accumulated results.
      for (const otherKey of viewRefreshes.keys()) {
        if (otherKey !== key) viewRefreshes.delete(otherKey);
      }
      const refresh = existingRefresh ?? viewRefreshes.get(key) ?? {
        workspaceId,
        docsSessionId,
        epoch: connectionEpoch,
        pending: new Set<WorkspaceViewField>(),
        scheduled: false,
        running: new Set<WorkspaceViewField>(),
        values: {},
        errors: new Map<WorkspaceViewField, string>()
      };
      viewRefreshes.set(key, refresh);
      for (const field of fields) refresh.pending.add(field);
      if (refresh.scheduled || refresh.pending.size === 0) return;
      refresh.scheduled = true;
      queueMicrotask(() => {
        refresh.scheduled = false;
        void drainView(refresh);
      });
    };

    const loadView = () => scheduleView(allWorkspaceViewFields);

    const drainInbox = async () => {
      if (!connected || inboxLoadRunningEpoch === connectionEpoch || !inboxDirty) return;
      const epoch = connectionEpoch;
      inboxLoadRunningEpoch = epoch;
      inboxDirty = false;
      try {
        const inboxHistory = await client.request("inbox.list", { includeProcessed: true });
        if (!connected || epoch !== connectionEpoch || inboxDirty) return;
        const inbox = inboxHistory.filter((item) => item.kind === "decision" ? (!item.card.answer || item.card.deliveryPending) && !item.card.withdrawn : !item.workItem.merge?.acknowledgedAt);
        set({ inbox, inboxHistory, inboxError: undefined });
      } catch (error) {
        if (connected && epoch === connectionEpoch) {
          set({ inboxError: (error as Error).message });
        }
      } finally {
        if (inboxLoadRunningEpoch === epoch) inboxLoadRunningEpoch = undefined;
        if (connected && epoch === connectionEpoch && inboxDirty) scheduleInbox();
      }
    };

    const scheduleInbox = () => {
      if (!connected) return;
      inboxDirty = true;
      if (
        inboxLoadScheduledEpoch === connectionEpoch ||
        inboxLoadRunningEpoch === connectionEpoch
      ) return;
      const epoch = connectionEpoch;
      inboxLoadScheduledEpoch = epoch;
      queueMicrotask(() => {
        if (inboxLoadScheduledEpoch !== epoch) return;
        inboxLoadScheduledEpoch = undefined;
        void drainInbox();
      });
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
      docsSessionId: undefined,
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
      setDocsSessionId: (docsSessionId) => {
        if (docsSessionId === get().docsSessionId) return;
        set({ docsSessionId, view: undefined, viewError: undefined });
        void loadView();
      },
      openEditor: (target) => set({ editor: target }),
      showAgentSession: (workspaceId, sessionId, turnId) => {
        if (get().navigateSession) { get().navigateSession!(workspaceId, sessionId, turnId); return; }
        get().browseWorkspace(workspaceId);
        set({ workspaceSection: "sessions", panel: "workbench", overlay: undefined });
      },

      connect: () => {
        connected = true;
        const epoch = ++connectionEpoch;
        void loadWorkspaces(epoch);
        scheduleInbox();
        const unsubscribe = client.subscribe((event) => {
          if (!connected || epoch !== connectionEpoch) return;
          switch (event.type) {
            case "workspaces.changed":
              void loadWorkspaces(epoch);
              return;
            case "docs.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["docs", "pendingDocChanges"]);
              return;
            case "roles.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["roles"]);
              return;
            case "domains.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["domains", "patrolRuns"]);
              return;
            case "scheduler.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["scheduler"]);
              return;
            case "runs.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["runs"]);
              return;
            case "actions.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["actions"]);
              return;
            case "workItems.changed":
              scheduleTasks([event.workspaceId]);
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["workItems"]);
              scheduleInbox();
              return;
            case "issues.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["issues"]);
              return;
            case "workRequests.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["workRequests"]);
              return;
            case "decisions.changed":
              if (event.workspaceId === get().browsingWorkspaceId) scheduleView(["decisions"]);
              scheduleInbox();
              return;
          }
        });
        return () => {
          unsubscribe();
          if (epoch !== connectionEpoch) return;
          connected = false;
          connectionEpoch += 1;
          viewRefreshes.clear();
          workspaceOwners.clear();
          pendingTaskWorkspaceIds.clear();
          inboxDirty = false;
        };
      }
    };
  });

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;
