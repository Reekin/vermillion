import type { FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  AgentRun,
  Scheduler,
  DecisionCard,
  DocChange,
  DocCommit,
  DocFile,
  InboxItem,
  Mission,
  RoleFile,
  WorkItem,
  WorkbenchEvent,
  Workspace
} from "./contracts.js";
import { actionIsOpen, latestRevision, type WorkflowAction } from "./contracts.js";
import type { SessionNavigationPort } from "./session-navigation.js";
import { DocsService, WorktreeMergeConflict, WorktreeNotReady } from "./docs.js";
import { RoleService } from "./roles.js";
import type { AppLauncher, AppStartInput, AppStartResult } from "./app-launcher.js";
import { WorkspaceStore } from "./workspace-store.js";
import { diagnose } from "./diagnosis.js";
import { runtimeInfo } from "./runtime-info.js";

const RETRY_MINUTES = [1, 5, 30, 300];

const createId = (prefix: string): string =>
  prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

/** Source of truth for workspace identity; the session engine's registry in production. */
export type WorkspaceSource = {
  list: () => Promise<Array<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>>;
  register: (input: { rootPath: string; label?: string }) => Promise<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>;
  remove: (workspaceId: string) => Promise<void>;
};

/** Asks a question in a throwaway fork of an existing session and returns the reply. The desktop implements it over the session engine. */
export type SessionAsk = (input: { sessionId: string; question: string }) => Promise<string>;

export type WorkbenchServiceOptions = {
  workspaces: WorkspaceSource;
  roles: RoleService;
  ask?: SessionAsk;
  sessionNavigation?: SessionNavigationPort;
  /** Starts isolated app instances for acceptance; absent when running without a desktop build around. */
  launcher?: AppLauncher;
  now?: () => string;
};

type WorkspaceContext = { rootPath: string; store: WorkspaceStore; docs: DocsService; watcher?: FSWatcher };

export class WorkbenchService {
  private readonly workspaces: WorkspaceSource;
  private readonly roles: RoleService;
  private readonly ask?: SessionAsk;
  private readonly sessionNavigation?: SessionNavigationPort;
  private readonly launcher?: AppLauncher;
  private readonly now: () => string;
  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();
  private readonly integrations = new Map<string, Promise<unknown>>();
  private readonly actionWrites = new Map<string, Promise<WorkflowAction>>();
  private readonly decisionDeliveries = new Map<string, Promise<void>>();
  private recoveryHandler?: (workspaceId: string) => Promise<void>;

  constructor(options: WorkbenchServiceOptions) {
    this.workspaces = options.workspaces;
    this.roles = options.roles;
    this.ask = options.ask;
    this.sessionNavigation = options.sessionNavigation;
    this.launcher = options.launcher;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WorkbenchEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Workers share the workspace Git index; integrate their results one at a time. */
  private async integrate<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.integrations.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.integrations.set(workspaceId, next);
    try { return await next; }
    finally { if (this.integrations.get(workspaceId) === next) this.integrations.delete(workspaceId); }
  }

  dispose(): void {
    for (const context of this.contexts.values()) context.watcher?.close();
    this.contexts.clear();
  }

  // ---- workspaces ----

  async createSessionNavigation(input: { sessionId: string; targetSessionId: string; reason?: string }) {
    if (!this.sessionNavigation) throw new Error("sessionNavigation.create requires a running desktop instance");
    const { navigation, workspaceId } = await this.sessionNavigation.create(input);
    this.emit({ type: "sessionNavigation.changed", sessionId: input.sessionId, workspaceId });
    return navigation;
  }

  async listSessionNavigations(input: { sessionId: string; turnId: string }) {
    if (!this.sessionNavigation) throw new Error("sessionNavigation.list requires a running desktop instance");
    return this.sessionNavigation.list(input);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const list = await this.workspaces.list();
    return list
      .map((w) => ({ workspaceId: w.workspaceId, rootPath: w.rootPath, label: w.label, createdAt: w.createdAt, lastActiveAt: w.updatedAt }))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async addWorkspace(input: { rootPath: string; label?: string }): Promise<Workspace> {
    const rootPath = resolve(input.rootPath);
    if (!(await new WorkspaceStore(rootPath).exists())) {
      throw new Error("Workspace directory does not exist: " + rootPath);
    }
    await new DocsService(rootPath).ensureRepo();
    const record = await this.workspaces.register({ rootPath, label: input.label?.trim() || basename(rootPath) });
    this.emit({ type: "workspaces.changed" });
    return { workspaceId: record.workspaceId, rootPath: record.rootPath, label: record.label, createdAt: record.createdAt, lastActiveAt: record.updatedAt };
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.workspaces.remove(workspaceId);
    this.contexts.get(workspaceId)?.watcher?.close();
    this.contexts.delete(workspaceId);
    this.emit({ type: "workspaces.changed" });
  }

  private async context(workspaceId: string): Promise<WorkspaceContext> {
    const cached = this.contexts.get(workspaceId);
    if (cached) return cached;
    const workspace = (await this.listWorkspaces()).find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw new Error("Unknown workspace: " + workspaceId);
    const docs = new DocsService(workspace.rootPath);
    await docs.ensureRepo();
    const context: WorkspaceContext = { rootPath: workspace.rootPath, store: new WorkspaceStore(workspace.rootPath), docs };
    try {
      context.watcher = docs.watch((area) => {
        const type = watchedAreas[area];
        if (type) this.emit({ type, workspaceId });
      });
    } catch {}
    this.contexts.set(workspaceId, context);
    return context;
  }

  // ---- docs ----

  async listDocs(workspaceId: string): Promise<DocFile[]> {
    return (await this.context(workspaceId)).docs.list();
  }

  async readDoc(workspaceId: string, path: string, commit?: string): Promise<string> {
    return (await this.context(workspaceId)).docs.read(path, commit);
  }

  async writeDoc(workspaceId: string, path: string, content: string): Promise<void> {
    await (await this.context(workspaceId)).docs.write(path, content);
    this.emit({ type: "docs.changed", workspaceId });
  }

  async pendingDocChanges(workspaceId: string): Promise<DocChange[]> {
    return (await this.context(workspaceId)).docs.pendingChanges();
  }

  async docDiff(workspaceId: string, path: string): Promise<string> {
    return (await this.context(workspaceId)).docs.diff(path);
  }

  async commitDocs(workspaceId: string, input: { message: string; paths?: string[] }): Promise<DocCommit> {
    const message = input.message.trim();
    if (!message) throw new Error("Commit message is required.");
    const { docs } = await this.context(workspaceId);
    const { commit } = await this.commitDocChanges(docs, message, input.paths);
    this.emit({ type: "docs.changed", workspaceId });
    return { commit, message };
  }

  // ---- sessions ----

  /** Steward asks the design partner what a doc sentence means; the mission remembers which session wrote it. */
  async askMissionAuthor(workspaceId: string, missionId: string, question: string): Promise<string> {
    if (!this.ask) throw new Error("session.ask is only available while the desktop is running");
    const mission = await (await this.context(workspaceId)).store.missions.get(missionId);
    if (!mission) throw new Error("Unknown mission: " + missionId);
    const sessionId = [...mission.revisions].reverse().find((r) => r.sessionId)?.sessionId ?? mission.sessionId;
    if (!sessionId) throw new Error("Mission has no originating session: " + missionId);
    return this.ask({ sessionId, question });
  }

  // ---- app instances ----

  async startApp(input: AppStartInput): Promise<AppStartResult> {
    if (!this.launcher) throw new Error("app.start is only available while the desktop is running");
    return this.launcher.start(input);
  }

  async stopApp(pid: number): Promise<void> {
    if (!this.launcher) throw new Error("app.stop is only available while the desktop is running");
    await this.launcher.stop(pid);
  }

  // ---- roles ----

  async listRoles(workspaceId: string): Promise<RoleFile[]> {
    return this.roles.list((await this.context(workspaceId)).rootPath);
  }

  async readRole(workspaceId: string, roleId: string): Promise<{ content: string; source: RoleFile["source"] }> {
    return this.roles.read((await this.context(workspaceId)).rootPath, roleId);
  }

  async resolveRole(workspaceId: string, roleId: string) {
    return this.roles.resolve((await this.context(workspaceId)).rootPath, roleId);
  }

  async writeRoleOverride(workspaceId: string, roleId: string, content: string): Promise<void> {
    await this.roles.writeOverride((await this.context(workspaceId)).rootPath, roleId, content);
    this.emit({ type: "roles.changed", workspaceId });
  }

  async resetRoleOverride(workspaceId: string, roleId: string): Promise<void> {
    await this.roles.removeOverride((await this.context(workspaceId)).rootPath, roleId);
    this.emit({ type: "roles.changed", workspaceId });
  }

  // ---- missions ----

  async listMissions(workspaceId: string): Promise<Mission[]> {
    const list = await (await this.context(workspaceId)).store.missions.list();
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Records the mission's first revision: the selected docs at HEAD, committing any that still have local changes. */
  async createMission(
    workspaceId: string,
    input: { title: string; summary: string; sessionId?: string; paths?: string[] }
  ): Promise<Mission> {
    const { docs, store } = await this.context(workspaceId);
    const revision = await this.commitRevision(docs, input.title.trim(), input.paths, input.sessionId);
    const now = this.now();
    const mission = await store.missions.put({
      missionId: createId("m"),
      title: input.title.trim(),
      status: "active",
      summary: input.summary,
      sessionId: input.sessionId,
      revisions: [revision],
      createdAt: now,
      updatedAt: now
    });
    this.emit({ type: "docs.changed", workspaceId });
    this.emit({ type: "missions.changed", workspaceId });
    return mission;
  }

  /**
   * Records a further revision on an existing mission. The steward reads new revisions to adjust or re-issue work
   * items, so a completed mission goes back to active here and stays there until that work has ended again.
   */
  async addMissionRevision(
    workspaceId: string,
    input: { missionId: string; message: string; sessionId?: string; paths?: string[] }
  ): Promise<Mission> {
    const { docs, store } = await this.context(workspaceId);
    const mission = await store.missions.get(input.missionId);
    if (!mission) throw new Error("Unknown mission: " + input.missionId);
    const revision = await this.commitRevision(docs, input.message.trim() || mission.title, input.paths, input.sessionId);
    const updated = await store.missions.put({ ...mission, status: "active", revisions: [...mission.revisions, revision], updatedAt: this.now() });
    this.emit({ type: "docs.changed", workspaceId });
    this.emit({ type: "missions.changed", workspaceId });
    return updated;
  }

  /**
   * A revision is "these docs as of this commit". Docs among `paths` with local changes are committed first;
   * if nothing is pending the revision simply points at HEAD, so an already-committed doc can start a mission.
   */
  private async commitRevision(docs: DocsService, message: string, paths: string[] | undefined, sessionId: string | undefined) {
    if (paths?.length === 0) throw new Error("Select at least one doc path.");
    const pending = await docs.pendingChanges();
    const toCommit = (paths ? pending.filter((c) => paths.includes(c.path)) : pending).map((c) => c.path);
    const commit = toCommit.length > 0 ? await docs.commit(message, toCommit) : await docs.head();
    if (!commit) throw new Error("The docs directory has no commits yet.");
    return { commit, message, paths: paths ?? toCommit, sessionId, at: this.now() };
  }

  private async commitDocChanges(docs: DocsService, message: string, paths: string[] | undefined) {
    if (paths?.length === 0) throw new Error("Select at least one doc path to commit.");
    const pending = await docs.pendingChanges();
    const selected = paths ? pending.filter((c) => paths.includes(c.path)) : pending;
    if (selected.length === 0) throw new Error("No pending doc changes to commit.");
    const selectedPaths = selected.map((c) => c.path);
    const commit = await docs.commit(message, selectedPaths);
    return { commit, message, paths: selectedPaths };
  }

  async setMissionStatus(workspaceId: string, missionId: string, status: Mission["status"]): Promise<Mission> {
    const { store } = await this.context(workspaceId);
    const mission = await store.missions.get(missionId);
    if (!mission) throw new Error("Unknown mission: " + missionId);
    const open = (await store.workItems.list()).filter((item) => item.missionId === missionId && item.status !== "closed" && item.status !== "cancelled");
    if (status === "done" && open.length) throw new Error("Mission has unfinished work items: " + open.map((item) => item.workItemId).join(", "));
    if (status === "done") {
      for (const id of mission.relatedWorkItemIds ?? []) {
        if ((await this.getWorkItem(workspaceId, id)).status !== "closed") throw new Error("Related work item is not closed: " + id);
      }
    }
    if (status === "cancelled") {
      for (const item of open) await this.cancelWorkItem(workspaceId, item.workItemId);
    }
    const updated = await store.missions.put({ ...mission, status, updatedAt: this.now() });
    this.emit({ type: "missions.changed", workspaceId });
    return updated;
  }

  async setMissionResult(workspaceId: string, missionId: string, input: { resultSummary?: string; relatedWorkItemIds?: string[] }): Promise<Mission> {
    const { store } = await this.context(workspaceId);
    const mission = await store.missions.get(missionId);
    if (!mission) throw new Error("Unknown mission: " + missionId);
    const relatedWorkItemIds = input.relatedWorkItemIds === undefined ? mission.relatedWorkItemIds : [...new Set(input.relatedWorkItemIds)];
    for (const id of relatedWorkItemIds ?? []) {
      const item = await this.getWorkItem(workspaceId, id);
      if (!item.missionId || item.missionId === missionId) throw new Error("Related work item must belong to another mission: " + id);
    }
    const updated = await store.missions.put({ ...mission, relatedWorkItemIds, resultSummary: input.resultSummary ?? mission.resultSummary, updatedAt: this.now() });
    this.emit({ type: "missions.changed", workspaceId });
    return updated;
  }

  // ---- work items ----

  async listWorkItems(workspaceId: string, missionId?: string): Promise<WorkItem[]> {
    const list = await (await this.context(workspaceId)).store.workItems.list();
    return list.filter((w) => !missionId || w.missionId === missionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const item = await (await this.context(workspaceId)).store.workItems.get(workItemId);
    if (!item) throw new Error("Unknown work item: " + workItemId);
    return item;
  }

  async listActions(workspaceId: string): Promise<WorkflowAction[]> {
    return (await this.context(workspaceId)).store.actions.list();
  }

  async createAction(workspaceId: string, input: Omit<WorkflowAction, "actionId" | "history" | "createdAt" | "updatedAt" | "attempts" | "idleTurns">): Promise<WorkflowAction> {
    const now = this.now();
    return this.putAction(workspaceId, { ...input, actionId: createId("action"), attempts: 0, idleTurns: 0, history: [{ at: now, event: "created", message: input.message }], createdAt: now, updatedAt: now });
  }

  async putAction(workspaceId: string, action: WorkflowAction): Promise<WorkflowAction> {
    const key = workspaceId + ":" + action.actionId;
    const next = (this.actionWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const { store } = await this.context(workspaceId);
      const current = await store.actions.get(action.actionId);
      // Checking the version and writing it form one operation, including send/decision races.
      if (current && current.updatedAt !== action.updatedAt && (!actionIsOpen(current) || current.status === "decision")) return current;
      const updatedAt = new Date(Math.max(Date.parse(this.now()), current ? Date.parse(current.updatedAt) + 1 : 0)).toISOString();
      const saved = await store.actions.put({ ...action, updatedAt });
      this.emit({ type: "actions.changed", workspaceId });
      return saved;
    });
    this.actionWrites.set(key, next);
    try { return await next; }
    finally { if (this.actionWrites.get(key) === next) this.actionWrites.delete(key); }
  }

  private async getAction(workspaceId: string, actionId: string): Promise<WorkflowAction> {
    const action = await (await this.context(workspaceId)).store.actions.get(actionId);
    if (!action) throw new Error("Unknown action: " + actionId);
    return action;
  }

  async finishAction(workspaceId: string, actionId: string, note: string): Promise<WorkflowAction> {
    const action = await this.getAction(workspaceId, actionId);
    return this.putAction(workspaceId, { ...action, status: "done", retryAt: undefined, history: [...action.history, { at: this.now(), event: "resolved", message: note }] });
  }

  async isWorkItemBlocked(workspaceId: string, workItemId: string): Promise<boolean> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    const items = await this.listWorkItems(workspaceId);
    return !!(item.contractIssue && !item.contractIssue.resolvedAt)
      || item.dependsOn.some((id) => items.find((other) => other.workItemId === id)?.status !== "closed")
      || (await this.listActions(workspaceId)).some((action) => actionIsOpen(action) && action.workItemIds.includes(workItemId) && ["contract", "dependency", "repair", "integration"].includes(action.kind))
      || (await this.listDecisions(workspaceId)).some((card) => card.workItemId === workItemId && !card.answer && !card.withdrawn);
  }

  async patchWorkItemRun(workspaceId: string, workItemId: string, patch: WorkItem["run"]): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, run: { ...item.run, ...patch } }));
  }

  setRecoveryHandler(handler: (workspaceId: string) => Promise<void>): () => void {
    this.recoveryHandler = handler;
    return () => { if (this.recoveryHandler === handler) this.recoveryHandler = undefined; };
  }

  async getRuntimeInfo() {
    return { ...runtimeInfo, schedulerOnline: !!this.recoveryHandler };
  }

  async diagnoseWorkItem(workspaceId: string, workItemId: string) {
    return diagnose(this, workspaceId, workItemId, !!this.recoveryHandler);
  }

  async dispositionFeedback(workspaceId: string, workItemIds: string[], completed = false) {
    return {
      dispatch: completed ? "completed" as const : this.recoveryHandler ? "pending" as const : "offline" as const,
      message: completed ? "本次处置已完成；其他等待与下一步见 diagnoses。" : this.recoveryHandler ? "处置记录已保存；派发与完成状态以当前动作记录为准。" : "处置记录已保存，桌面调度器不在线，尚未派发。",
      diagnoses: await Promise.all(workItemIds.map((id) => this.diagnoseWorkItem(workspaceId, id)))
    };
  }

  async recoverWorkItem(workspaceId: string, workItemId: string) {
    const item = await this.getWorkItem(workspaceId, workItemId);
    const before = await this.listActions(workspaceId);
    if (["closed", "cancelled"].includes(item.status) && !before.some((a) => a.workItemIds.includes(workItemId) && actionIsOpen(a))) throw new Error("工单已结束，没有待恢复动作；请用 workItem.diagnose 查询结果。");
    for (const action of before) {
      if (action.workItemIds.includes(workItemId) && action.status === "retry") {
        await this.putAction(workspaceId, { ...action, retryAt: this.now() });
      }
    }
    await this.refreshActions(workspaceId);
    await this.recoveryHandler?.(workspaceId);
    const actions = (await this.listActions(workspaceId)).filter((a) => a.workItemIds.includes(workItemId));
    const changes = actions.flatMap((action) => {
      const previous = before.find((a) => a.actionId === action.actionId);
      return previous?.updatedAt === action.updatedAt ? [] : [{ actionId: action.actionId, before: previous ? `${previous.status}/${previous.stage}` : "absent", after: `${action.status}/${action.stage}`, history: action.history.slice(previous?.history.length ?? 0) }];
    });
    const diagnosis = await this.diagnoseWorkItem(workspaceId, workItemId);
    return { workItem: await this.getWorkItem(workspaceId, workItemId), actions, changes, diagnosis,
      dispatched: actions.some((a) => a.deliveredAt && a.deliveredAt !== before.find((previous) => previous.actionId === a.actionId)?.deliveredAt),
      message: !this.recoveryHandler ? "记录已保存，调度器不在线，尚未派发。" : changes.length ? "已核对并续接动作，实际变化见 changes；当前等待见 diagnosis。" : "已核对，没有新增派发；当前处理者与等待条件见 diagnosis。" };
  }

  async failAction(workspaceId: string, actionId: string, failure: string): Promise<WorkflowAction> {
    const action = await this.getAction(workspaceId, actionId);
    if (!actionIsOpen(action) || action.status === "decision") return action;
    const attempts = action.attempts + 1;
    const delay = RETRY_MINUTES[attempts - 1];
    const failed = await this.putAction(workspaceId, { ...action, attempts, failure, status: delay === undefined ? "decision" : "retry",
      retryAt: delay === undefined ? undefined : new Date(Date.parse(this.now()) + delay * 60_000).toISOString(),
      history: [...action.history, { at: this.now(), event: "failed:" + action.stage, message: failure }] });
    if (action.kind === "execute") {
      for (const id of action.workItemIds) await this.mutateWorkItem(workspaceId, id, (item) => ({ ...item, status: "queued", run: { ...item.run, lastFailure: failure, attempts, retryAt: failed.retryAt, resumeMessage: "上次运行异常：" + failure } }));
    }
    if (delay === undefined && !(await this.listDecisions(workspaceId)).some((card) => card.actionId === actionId && !card.answer && !card.withdrawn)) {
      await this.createDecision(workspaceId, { actionId, kind: "attempts", workItemId: action.workItemIds[0], missionId: action.missionId, sessionId: action.sessionId,
        question: "自动恢复已用尽，要再试还是取消当前工作？", context: "工作台已尝试自动恢复四次，仍未完成当前处理。原会话与成果保留，选择再试后会从未完成的动作继续。",
        details: "阶段：" + action.stage + "\n受影响工单：" + action.workItemIds.join(", ") + "\n" + failed.history.filter((h) => h.event.startsWith("failed:")).map((h) => h.at + " " + h.message).join("\n"),
        options: [{ key: "retry", label: "再试", detail: "清零此处理过程的失败计数，从未完成动作继续。" }, { key: "cancel", label: "取消当前工作", detail: "取消该过程关联的工单；已合入成果保持保留。" }], recommended: "retry", recommendation: "故障已排除时可沿原处理过程继续。" });
    }
    return this.getAction(workspaceId, actionId);
  }

  /** Dependencies and agent actions share one durable queue; facts, not delivery receipts, release waiting work. */
  async refreshActions(workspaceId: string): Promise<void> {
    for (const card of await this.listDecisions(workspaceId)) {
      if (card.deliveryPending) await this.flushDecision(workspaceId, card);
    }
    const items = await this.listWorkItems(workspaceId);
    let actions = await this.listActions(workspaceId);
    for (const item of items) {
      if (item.status === "merging" && !actions.some((a) => a.kind === "integration" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a))) {
        const recovered = await this.integrate(workspaceId, async () => {
          if ((await this.getWorkItem(workspaceId, item.workItemId)).status !== "merging" || (await this.listActions(workspaceId)).some((a) => a.kind === "integration" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a))) return;
          return this.createAction(workspaceId, { kind: "integration", role: "workbench", ownerKey: "integration", workItemIds: [item.workItemId], missionId: item.missionId, status: "pending", stage: "merge", message: "验收通过，续接尚未建立的合入动作。", integration: { operation: "merge", diffStat: "" } });
        });
        if (recovered) actions.push(recovered);
      }
      if (item.status === "closed" || item.status === "cancelled") {
        for (const action of actions.filter((a) => a.workItemIds.includes(item.workItemId) && actionIsOpen(a) && !["integration", "repair"].includes(a.kind))) {
          await this.finishAction(workspaceId, action.actionId, "工单已结束。");
        }
        continue;
      }
      if (item.contractIssue && !item.contractIssue.resolvedAt && !actions.some((a) => a.kind === "contract" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a))) {
        const action = await this.createAction(workspaceId, { kind: "contract", role: "steward", ownerKey: "steward:" + (item.missionId ?? item.workItemId), missionId: item.missionId, workItemIds: [item.workItemId], status: "pending", stage: "open", message: item.contractIssue.message });
        actions.push(action);
      }
      const missing = item.dependsOn.filter((id) => items.find((other) => other.workItemId === id)?.status !== "closed");
      let dependency = actions.find((a) => a.kind === "dependency" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a));
      if (missing.length) {
        const cancelled = missing.some((id) => items.find((other) => other.workItemId === id)?.status === "cancelled");
        if (!dependency) {
          dependency = await this.createAction(workspaceId, { kind: "dependency", role: cancelled ? "steward" : "workbench", ownerKey: "steward:" + (item.missionId ?? item.workItemId), missionId: item.missionId, workItemIds: [item.workItemId], status: cancelled ? "pending" : "waiting", stage: "open", message: "等待前置关闭：" + missing.join(", ") + (cancelled ? "。前置已取消，请调整依赖或取消本单。" : "") });
          actions.push(dependency);
        } else if (cancelled && dependency.role === "workbench") {
          await this.putAction(workspaceId, { ...dependency, role: "steward", status: "pending", stage: "open", message: "前置已取消，请落实依赖调整或取消本单：" + missing.join(", ") });
        } else if (!cancelled && dependency.role === "steward" && dependency.status !== "decision") {
          await this.putAction(workspaceId, { ...dependency, role: "workbench", status: "waiting", message: "依赖调整已落实，等待前置关闭：" + missing.join(", "), history: [...dependency.history, { at: this.now(), event: "dependency.updated", message: "管家已落实替代前置，交工作台等待。" }] });
        }
      } else if (dependency) await this.finishAction(workspaceId, dependency.actionId, "前置已关闭或依赖调整已落实。");
      for (const action of actions.filter((a) => a.kind === "execute" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a))) {
        if (["closed", "cancelled", "merging"].includes(item.status) || (await this.isWorkItemBlocked(workspaceId, item.workItemId) && action.status !== "decision")) {
          await this.finishAction(workspaceId, action.actionId, "执行已交接，保留原 Worker 会话与成果。");
        }
      }
      if ((item.status === "queued" || item.status === "running") && !(await this.isWorkItemBlocked(workspaceId, item.workItemId)) && !(await this.listActions(workspaceId)).some((a) => a.kind === "execute" && a.workItemIds.includes(item.workItemId) && actionIsOpen(a))) {
        await this.createAction(workspaceId, { kind: "execute", role: "worker", ownerKey: "worker:" + item.workItemId, missionId: item.missionId, workItemIds: [item.workItemId], status: "pending", stage: item.status === "running" && item.run.sessionId ? "execute" : item.run.worktreePath || !item.scope.allowedPaths.length ? "open" : "worktree", sessionId: item.run.sessionId, message: item.run.resumeMessage ?? "读取工单，在允许范围内执行并提交验收结果。" });
      }
    }
    // Bind outstanding cards from the persisted work-item model to their current responsibility.
    const { store } = await this.context(workspaceId);
    for (const card of (await this.listDecisions(workspaceId)).filter((c) => c.workItemId && !c.actionId && !c.answer && !c.withdrawn)) {
      const item = items.find((entry) => entry.workItemId === card.workItemId);
      if (!item || ["closed", "cancelled"].includes(item.status)) continue;
      let action = (await this.listActions(workspaceId)).find((a) => a.workItemIds.includes(item.workItemId) && a.role !== "workbench" && actionIsOpen(a));
      action ??= await this.createAction(workspaceId, { kind: "execute", role: "worker", ownerKey: "worker:" + item.workItemId, workItemIds: [item.workItemId], missionId: item.missionId, status: "decision", stage: "deliver", sessionId: item.run.sessionId, message: "理解决策后继续原工单。" });
      await store.decisions.put({ ...card, actionId: action.actionId });
      await this.putAction(workspaceId, { ...action, status: "decision" });
    }
    actions = await this.listActions(workspaceId);
    for (const mission of await this.listMissions(workspaceId)) {
      const revision = latestRevision(mission);
      if (mission.status !== "active" || actions.some((a) => a.kind === "revision" && a.missionId === mission.missionId && a.revision === revision.commit && a.createdAt >= revision.at)) continue;
      // Existing completed/running revisions already have their persisted receipt.
      if ((await this.listRuns(workspaceId)).some((r) => r.role === "steward" && r.missionId === mission.missionId && r.revision === revision.commit && (r.status === "running" || (r.endedAt ?? r.startedAt) >= revision.at))) continue;
      await this.createAction(workspaceId, { kind: "revision", role: "steward", ownerKey: "steward:" + mission.missionId, missionId: mission.missionId, revision: revision.commit, workItemIds: [], status: "pending", stage: "open", message: "处理任务 revision：" + JSON.stringify(mission) });
    }
  }

  async createWorkItem(
    workspaceId: string,
    input: Pick<WorkItem, "title" | "objective" | "risk" | "scope" | "acceptance"> & { missionId?: string; refs?: WorkItem["refs"]; needs?: string[]; dependsOn?: string[] }
  ): Promise<WorkItem> {
    const now = this.now();
    const { store } = await this.context(workspaceId);
    if (input.missionId && !(await store.missions.get(input.missionId))) throw new Error("Unknown mission: " + input.missionId);
    await this.checkDependencies(workspaceId, "(new)", input.dependsOn ?? []);
    const item = await store.workItems.put({
      workItemId: createId("wi"),
      missionId: input.missionId,
      title: input.title.trim(),
      objective: input.objective,
      status: "queued",
      risk: input.risk,
      needs: input.needs ?? [],
      dependsOn: input.dependsOn ?? [],
      refs: input.refs ?? [],
      scope: input.scope,
      acceptance: input.acceptance,
      review: [],
      rejections: [],
      decisions: [],
      run: {},
      createdAt: now,
      updatedAt: now
    });
    this.emit({ type: "workItems.changed", workspaceId });
    return item;
  }

  private async mutateWorkItem(workspaceId: string, workItemId: string, mutate: (item: WorkItem) => WorkItem): Promise<WorkItem> {
    const { store } = await this.context(workspaceId);
    const item = await this.getWorkItem(workspaceId, workItemId);
    const updated = await store.workItems.put({ ...mutate(item), updatedAt: this.now() });
    this.emit({ type: "workItems.changed", workspaceId });
    return updated;
  }

  /** Worker claimed the item; records the session and worktree it runs in. */
  /** A (re)start begins a new turn: the pending message is claimed and any stale-turn mark from the previous run is over. */
  async startWorkItem(workspaceId: string, workItemId: string, run: WorkItem["run"]): Promise<WorkItem> {
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (current.status !== "queued" && !(current.status === "running" && current.run.sessionId === run.sessionId)) throw new Error("只有可执行的排队工单可以启动，已结束或等待合入的工单不能重新认领。");
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("工单仍有未解决的等待条件，请读取 action.list。");
    const occupied = (await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running");
    const scheduler = await this.getScheduler(workspaceId);
    if (occupied.length >= scheduler.maxWorkers || occupied.some((item) => item.needs.some((need) => current.needs.includes(need)))) throw new Error("并发或共享资源尚未释放，保持排队。");
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({
      ...item,
      status: "running",
      run: { ...item.run, ...run, retryAt: undefined, staleTurnId: undefined }
    }));
  }

  async heartbeatWorkItem(workspaceId: string, workItemId: string, lastTurnId?: string): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, run: { ...item.run, lastTurnId: lastTurnId ?? item.run.lastTurnId, heartbeatAt: this.now() } }));
  }

  /** Verified work merges immediately; unsuccessful submissions return to the same worker. */
  async submitWorkItem(
    workspaceId: string,
    workItemId: string,
    input: { evidence: Omit<NonNullable<WorkItem["evidence"]>, "submittedAt">; review: WorkItem["review"]; verify: Omit<NonNullable<WorkItem["verify"]>, "verifiedAt"> }
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.submitResult(workspaceId, workItemId, input));
  }

  private async submitResult(workspaceId: string, workItemId: string, input: Parameters<WorkbenchService["submitWorkItem"]>[2]): Promise<WorkItem> {
    const now = this.now();
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (current.status !== "running") throw new Error("Work item is not running: " + workItemId);
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("仍有未解决的等待条件，不能提交。");
    if (current.run.staleTurnId) {
      return this.returnWorkItem(workspaceId, workItemId, "提交作废：合同在本轮进行中被调整");
    }
    const submitted = await this.mutateWorkItem(workspaceId, workItemId, (item) => {
      const verify = { ...input.verify, verifiedAt: now };
      return {
        ...item,
        evidence: { ...input.evidence, submittedAt: now },
        review: input.review,
        verify
      };
    });
    const failed = input.verify.items.filter((entry) => !entry.pass);
    const missing = submitted.acceptance.some((_, index) => !input.verify.items.some((entry) => entry.index === index));
    if (input.verify.verdict !== "pass" || failed.length || missing) {
      const reason = "验收未通过：" + (failed.map((entry) => entry.evidence).join("\n") || (missing ? "验收报告未覆盖全部条目" : "验收报告要求返工"));
      return this.returnWorkItem(workspaceId, workItemId, reason);
    }
    await this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, status: "merging" }));
    await this.createAction(workspaceId, { kind: "integration", role: "workbench", ownerKey: "integration", workItemIds: [workItemId], missionId: submitted.missionId, status: "pending", stage: "merge", message: "验收通过，等待合入。", integration: { operation: "merge", diffStat: "" } });
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  /** Accepts the work: merges the worker's branch into the workspace (when it ran in a worktree) and closes the item. */
  async continueIntegrations(workspaceId: string): Promise<void> {
    await this.integrate(workspaceId, () => this.drainIntegrations(workspaceId));
  }

  private async requestRepair(workspaceId: string, workItemId: string, message: string): Promise<WorkflowAction> {
    const existing = (await this.listActions(workspaceId)).find((a) => a.kind === "repair" && actionIsOpen(a));
    if (existing) {
      if (existing.workItemIds.includes(workItemId) && existing.history.some((h) => h.message === message)) return existing;
      return this.putAction(workspaceId, { ...existing, workItemIds: [...new Set([...existing.workItemIds, workItemId])], message: existing.message + "\n" + message, history: [...existing.history, { at: this.now(), event: "affected", message }] });
    }
    return this.createAction(workspaceId, { kind: "repair", role: "workspace-repair", ownerKey: "workspace-repair", workItemIds: [workItemId], status: "pending", stage: "open", message });
  }

  private async drainIntegrations(workspaceId: string, repairingActionId?: string): Promise<void> {
    const actions = await this.listActions(workspaceId);
    const repair = actions.find((a) => a.kind === "repair" && actionIsOpen(a));
    const pending = actions.filter((a) => a.kind === "integration" && actionIsOpen(a));
    if (repair && repair.actionId !== repairingActionId) {
      for (const action of pending) if (!repair.workItemIds.includes(action.workItemIds[0]!)) await this.requestRepair(workspaceId, action.workItemIds[0]!, "同一工作区等待恢复：" + action.stage);
      return;
    }
    const { docs } = await this.context(workspaceId);
    for (let action of pending) {
      const workItemId = action.workItemIds[0]!;
      let item = await this.getWorkItem(workspaceId, workItemId);
      try {
        let integration = action.integration!;
        if (action.stage === "merge") {
          if (item.run.worktreePath && item.run.branch) {
            if (!integration.target) {
              const snapshot = await docs.integrationSnapshot(item.run.branch);
              integration = { ...integration, before: snapshot.head, target: snapshot.target, diffStat: snapshot.diffStat };
              action = await this.putAction(workspaceId, { ...action, integration });
            }
            const result = await docs.mergeWorktree(item.run.worktreePath, item.run.branch, item.title, integration.target);
            // Recovering an already merged target still uses the original frozen diff and commit.
            integration = { ...integration, commit: result.commit ?? await docs.getMergeCommit(integration.target!, integration.before!) };
          }
          action = await this.putAction(workspaceId, { ...action, integration, stage: "cleanup" });
          item = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, merge: { commit: integration.commit, diffStat: integration.diffStat, mergedAt: this.now() } }));
        }
        if (action.stage === "rollback") {
          if (!integration.before) {
            integration = { ...integration, before: await docs.head() };
            action = await this.putAction(workspaceId, { ...action, integration });
          }
          const commit = await docs.rollbackMerge(integration.target!, integration.before);
          integration = { ...integration, commit };
          action = await this.putAction(workspaceId, { ...action, integration, stage: "cleanup" });
          item = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, merge: { ...current.merge!, rollbackCommit: commit, acknowledgedAt: this.now() } }));
        }
        if (action.stage === "cleanup") {
          if (item.run.worktreePath && item.run.branch) await docs.dropWorktree(item.run.worktreePath, item.run.branch, integration.operation === "cancel");
          await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, status: integration.operation === "cancel" ? "cancelled" : integration.operation === "rollback" ? "queued" : "closed",
            merge: integration.operation === "merge" ? { commit: integration.commit, diffStat: integration.diffStat, mergedAt: current.merge?.mergedAt ?? this.now() }
              : integration.operation === "rollback" ? { ...current.merge!, rollbackCommit: integration.commit, acknowledgedAt: this.now() } : current.merge,
            run: { ...current.run, worktreePath: undefined, branch: undefined, resumeMessage: integration.operation === "rollback" ? "用户回滚：" + integration.reason : current.run.resumeMessage } }));
          if (integration.operation === "rollback" && item.missionId) await this.setMissionStatus(workspaceId, item.missionId, "active");
          await this.finishAction(workspaceId, action.actionId, "已完成 " + integration.operation + " 及清理。");
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof WorktreeMergeConflict || error instanceof WorktreeNotReady) {
          await this.finishAction(workspaceId, action.actionId, "转回原 Worker：" + reason);
          await this.returnWorkItem(workspaceId, workItemId, reason + "\n在原 worktree rebase 并更新受影响验证后重新提交。");
        } else {
          await this.putAction(workspaceId, { ...action, status: "waiting", failure: reason, history: [...action.history, { at: this.now(), event: "failed:" + action.stage, message: reason }] });
          await this.requestRepair(workspaceId, workItemId, "失败阶段：" + action.stage + "\n工单：" + workItemId + "\n" + reason);
          return;
        }
      }
    }
  }

  async submitWorkspaceRepair(workspaceId: string, actionId: string, input: { sessionId: string; summary: string; evidence: string[] }) {
    return this.integrate(workspaceId, async () => {
      let action = await this.getAction(workspaceId, actionId);
      if (action.kind !== "repair" || !actionIsOpen(action) || action.sessionId !== input.sessionId) throw new Error("请从当前修复会话提交其未完成的修复动作。");
      if (!input.summary.trim() || !input.evidence.length) throw new Error("修复结果需要说明与实际检查证据。");
      if ((await this.listDecisions(workspaceId)).some((card) => card.actionId === actionId && !card.answer && !card.withdrawn)) throw new Error("修复仍在等待决策，不能解除其他等待条件。");
      action = await this.putAction(workspaceId, { ...action, history: [...action.history, { at: this.now(), event: "repair.submitted", message: input.summary + "\n" + input.evidence.join("\n") }] });
      try { await (await this.context(workspaceId)).docs.checkIntegrationReady(); }
      catch (error) {
        const reason = String(error);
        await this.putAction(workspaceId, { ...action, failure: reason, history: [...action.history, { at: this.now(), event: "repair.check.failed", message: reason }] });
        return { pass: false, message: reason, action: await this.getAction(workspaceId, actionId) };
      }
      await this.drainIntegrations(workspaceId, actionId);
      const remaining = (await this.listActions(workspaceId)).some((a) => a.kind === "integration" && actionIsOpen(a));
      if (!remaining) await this.finishAction(workspaceId, actionId, input.summary);
      return { pass: !remaining, message: remaining ? "后续阶段仍受阻，原问题与恢复预算保留，回原修复会话继续。" : "工作台检查通过，已续接待处理阶段。", action: await this.getAction(workspaceId, actionId) };
    });
  }

  private async returnWorkItem(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => {
      return { ...item, status: "queued", rejections: [...item.rejections, { reason, at: this.now() }], run: { ...item.run, staleTurnId: undefined, resumeMessage: reason } };
    });
  }

  async acknowledgeWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => {
      if (item.status !== "closed" || !item.merge) throw new Error("Work item has no merged notification");
      return { ...item, merge: { ...item.merge, acknowledgedAt: this.now() } };
    });
  }

  async rollbackWorkItem(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.rollbackResult(workspaceId, workItemId, reason));
  }

  private async rollbackResult(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    if (!reason.trim()) throw new Error("请填写回滚理由");
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status !== "closed" || !item.merge?.commit) throw new Error("Work item has no merge to roll back");
    if (!(await this.listActions(workspaceId)).some((a) => a.kind === "integration" && a.workItemIds.includes(workItemId) && actionIsOpen(a))) {
      await this.createAction(workspaceId, { kind: "integration", role: "workbench", ownerKey: "integration", workItemIds: [workItemId], missionId: item.missionId, status: "pending", stage: "rollback", message: "用户回滚：" + reason.trim(), integration: { operation: "rollback", target: item.merge.commit, diffStat: "", reason: reason.trim() } });
    }
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  async cancelWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status === "closed") throw new Error("已合入工单请使用回滚入口，不能取消已完成成果。");
    const cancelled = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, status: "cancelled" }));
    for (const action of await this.listActions(workspaceId)) {
      if (action.workItemIds.includes(workItemId) && actionIsOpen(action) && action.workItemIds.length === 1 && action.kind !== "repair") await this.putAction(workspaceId, { ...action, status: "cancelled" });
    }
    const dependants = (await this.listWorkItems(workspaceId)).filter((w) => !["closed", "cancelled"].includes(w.status) && w.dependsOn.includes(workItemId)).map((w) => w.workItemId);
    this.emit({ type: "workItem.cancelled", workspaceId, workItemId, sessionId: item.run.sessionId, dependants });
    if (item.run.worktreePath && item.run.branch) {
      await this.createAction(workspaceId, { kind: "integration", role: "workbench", ownerKey: "integration", workItemIds: [workItemId], status: "pending", stage: "cleanup", message: "取消后的工作目录清理。", integration: { operation: "cancel", diffStat: "" } });
      await this.continueIntegrations(workspaceId);
    }
    return cancelled;
  }

  /**
   * Steward adjusts a contract after a new revision. A running item keeps its session and worktree and its worker is
   * steered immediately; anything else just gets the new contract.
   */
  async updateWorkItem(
    workspaceId: string,
    workItemId: string,
    input: Partial<Pick<WorkItem, "title" | "objective" | "refs" | "scope" | "acceptance" | "risk" | "needs" | "dependsOn">> & { note: string; resolution?: { actionId: string; disposition: "updated" | "clarified"; reason: string } }
  ): Promise<WorkItem> {
    const { note, resolution, ...changes } = input;
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (changes.dependsOn) await this.checkDependencies(workspaceId, workItemId, changes.dependsOn);
    let resolved: WorkflowAction | undefined;
    if (resolution) {
      resolved = await this.getAction(workspaceId, resolution.actionId);
      if (!actionIsOpen(resolved) || resolved.kind !== "contract" || !resolved.workItemIds.includes(workItemId)) throw new Error("resolution 必须引用本单未解决的合同问题。");
      if (!resolution.reason.trim()) throw new Error("请说明具体处置及恢复依据。");
      const fields = resolved.requiredChanges ?? ["objective", "scope", "acceptance", "dependsOn", "needs"];
      if (resolution.disposition === "updated" && !fields.some((field) => changes[field] !== undefined && JSON.stringify(changes[field]) !== JSON.stringify(current[field]))) {
        throw new Error("未落实问题所需的合同修改；标题、引用和说明不能解除阻塞。无需修改时请用 clarified 明确记录澄清依据。");
      }
    }
    const occupied = changes.needs?.length
      ? new Set((await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running").flatMap((item) => item.needs))
      : new Set<string>();
    const updated = await this.mutateWorkItem(workspaceId, workItemId, (item) => {
      if (item.status === "closed" || item.status === "cancelled") throw new Error("Work item is " + item.status + ": " + workItemId);
      const conflict = item.status === "running" ? changes.needs?.find((need) => occupied.has(need)) : undefined;
      if (conflict !== undefined) throw new Error("Resource is in use: " + conflict + ". Release it before updating this running work item.");
      const status = item.status;
      // While parked the note lives on the decision card and reaches the worker inside the answer line.
      const decisions = status === "decision" ? item.decisions : [...item.decisions, "工单调整：" + note];
      return {
        ...item, ...changes, status, decisions,
        contractIssue: item.contractIssue && resolved ? { ...item.contractIssue, resolvedAt: this.now() } : item.contractIssue,
        run: resolved && status === "queued"
          ? { ...item.run, resumeMessage: [item.run.resumeMessage, "工单已调整：" + note + "。重新读取合同，先 rebase 到主分支当前 HEAD，再继续执行。"].filter(Boolean).join("\n") }
          : item.run
      };
    });
    if (resolved) {
      const note = resolution!.disposition + "：" + resolution!.reason;
      if ((await this.listDecisions(workspaceId)).some((card) => card.actionId === resolved.actionId && !card.answer && !card.withdrawn)) {
        const action = await this.getAction(workspaceId, resolved.actionId);
        await this.putAction(workspaceId, { ...action, history: [...action.history, { at: this.now(), event: "contract.updated", message: note }] });
      } else await this.finishAction(workspaceId, resolved.actionId, note);
    }
    if (changes.dependsOn?.some((id) => !current.dependsOn.includes(id)) && updated.status === "running") {
      await this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, status: "queued", run: { ...item.run, resumeMessage: "依赖调整已落实。前置关闭后读取最新合同，rebase 后继续。" } }));
    }
    if (updated.status === "running" && updated.run.sessionId) this.emit({ type: "workItem.updated", workspaceId, workItemId, sessionId: updated.run.sessionId, note });
    // Parked on a decision: the user reads the change on the card before answering; the answer carries it to the worker.
    {
      const { store } = await this.context(workspaceId);
      for (const card of (await store.decisions.list()).filter((c) => c.workItemId === workItemId && !c.answer && !c.withdrawn)) {
        await store.decisions.put({ ...card, adjustments: [...(card.adjustments ?? []), { note, at: this.now() }] });
        this.emit({ type: "decisions.changed", workspaceId });
      }
    }
    return this.getWorkItem(workspaceId, workItemId);
  }

  private async checkDependencies(workspaceId: string, workItemId: string, dependsOn: string[]): Promise<void> {
    const items = await this.listWorkItems(workspaceId);
    const graph = new Map(items.map((item) => [item.workItemId, item.dependsOn]));
    graph.set(workItemId, dependsOn);
    const visit = (id: string, chain: string[]): void => {
      if (chain.includes(id)) throw new Error("循环依赖：" + [...chain, id].join(" → "));
      const children = graph.get(id);
      if (!children) throw new Error("前置工单不存在：" + id + "。请由管家调整依赖。");
      for (const child of children) visit(child, [...chain, id]);
    };
    visit(workItemId, []);
  }

  /**
   * Worker found it needs another item merged first: back to the queue with that item in dependsOn. Session, worktree
   * and branch stay on the record and the wake-up note waits in resumeMessage, so once the prerequisite closes the
   * scheduler resumes the same conversation. Not a failure, so attempts are untouched. The prerequisite may belong to
   * any mission.
   */
  async deferWorkItem(workspaceId: string, workItemId: string, dependsOn: string, note: string): Promise<WorkItem> {
    const current = await this.getWorkItem(workspaceId, workItemId);
    await this.checkDependencies(workspaceId, workItemId, [...new Set([...current.dependsOn, dependsOn])]);
    const prerequisite = await this.getWorkItem(workspaceId, dependsOn);
    if (prerequisite.status === "closed" || prerequisite.status === "cancelled") throw new Error("Work item is already " + prerequisite.status + ": " + dependsOn);
    return this.mutateWorkItem(workspaceId, workItemId, (item) => {
      if (item.status !== "running") throw new Error("Work item is not running: " + workItemId);
      return {
        ...item,
        status: "queued",
        dependsOn: item.dependsOn.includes(dependsOn) ? item.dependsOn : [...item.dependsOn, dependsOn],
        decisions: [...item.decisions, "等待工单 " + dependsOn + "：" + note],
        run: { ...item.run, resumeMessage: "对工单「" + prerequisite.title + "」（" + dependsOn + "）的等待已结束。退回原因：" + note + "。先用 workItem.get 确认它的最终状态（关闭合入或被管家改掉依赖），把本分支 rebase 到主分支当前 HEAD，再接着做。" }
      };
    });
  }

  async escalateWorkItem(workspaceId: string, workItemId: string, message: string, options: { kind?: "contract" | "workspace"; evidence?: string[]; requiredChanges?: WorkflowAction["requiredChanges"] } = {}): Promise<WorkItem> {
    if (!message.trim()) throw new Error("Contract problem needs a message");
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (["closed", "cancelled"].includes(current.status)) throw new Error("工单已结束，无法上报执行阻塞。");
    if (options.kind === "workspace") {
      if (!(await this.listActions(workspaceId)).some((a) => a.kind === "integration" && a.workItemIds.includes(workItemId) && actionIsOpen(a))) throw new Error("主工作区修复仅处理合入、回滚或清理阶段故障；执行环境问题请交管家。");
      await this.requestRepair(workspaceId, workItemId, message);
      return this.getWorkItem(workspaceId, workItemId);
    }
    const existing = (await this.listActions(workspaceId)).find((a) => a.kind === "contract" && a.workItemIds.includes(workItemId) && actionIsOpen(a));
    if (existing) {
      if (!existing.history.some((entry) => entry.message === message)) await this.putAction(workspaceId, { ...existing, history: [...existing.history, { at: this.now(), event: "reported", message }], message: existing.message + "\n补充：" + message });
    } else await this.createAction(workspaceId, { kind: "contract", role: "steward", ownerKey: "steward:" + (current.missionId ?? workItemId), workItemIds: [workItemId], missionId: current.missionId, status: "pending", stage: "open", requiredChanges: options.requiredChanges, message: [message, ...(options.evidence ?? [])].join("\n") });
    return this.mutateWorkItem(workspaceId, workItemId, (item) => {
      return {
        ...item, status: "queued",
        contractIssue: item.contractIssue && !item.contractIssue.resolvedAt ? item.contractIssue : { message, at: this.now() },
        decisions: [...item.decisions, "合同问题：" + message],
        run: { ...item.run, resumeMessage: "合同问题已交管家处置：" + message }
      };
    });
  }

  /** Delivery receipt persists across scheduler restarts; it does not release the worker. */
  async acknowledgeContractIssue(workspaceId: string, workItemId: string, at: string): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({
      ...item,
      contractIssue: item.contractIssue?.at === at ? { ...item.contractIssue, notifiedAt: this.now() } : item.contractIssue
    }));
  }

  /** Orchestrator: marks/clears the turn during which a contract change landed mid-flight. */
  async setWorkItemStaleTurn(workspaceId: string, workItemId: string, staleTurnId: string | undefined): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, run: { ...item.run, staleTurnId } }));
  }

  /**
   * Scheduler: the worker session ended without submit or decision. Back to the queue with the failure noted; after
   * four delayed retries the item is parked on a decision card instead so the user sees it.
   */
  async requeueWorkItem(workspaceId: string, workItemId: string, failure: string): Promise<WorkItem> {
    await this.refreshActions(workspaceId);
    const action = (await this.listActions(workspaceId)).find((entry) => entry.kind === "execute" && entry.workItemIds.includes(workItemId) && actionIsOpen(entry));
    if (action) await this.failAction(workspaceId, action.actionId, failure);
    return this.getWorkItem(workspaceId, workItemId);
  }

  // ---- scheduler ----

  async getScheduler(workspaceId: string): Promise<Scheduler> {
    return (await this.context(workspaceId)).store.readScheduler();
  }

  async setScheduler(workspaceId: string, value: Scheduler): Promise<Scheduler> {
    const saved = await (await this.context(workspaceId)).store.writeScheduler(value);
    this.emit({ type: "scheduler.changed", workspaceId });
    return saved;
  }

  async listRuns(workspaceId: string): Promise<AgentRun[]> {
    const list = await (await this.context(workspaceId)).store.runs.list();
    return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async putRun(workspaceId: string, run: AgentRun): Promise<AgentRun> {
    const saved = await (await this.context(workspaceId)).store.runs.put(run);
    this.emit({ type: "runs.changed", workspaceId });
    return saved;
  }

  async workspaceRoot(workspaceId: string): Promise<string> {
    return (await this.context(workspaceId)).rootPath;
  }

  // ---- decisions ----

  async listDecisions(workspaceId: string): Promise<DecisionCard[]> {
    return (await this.context(workspaceId)).store.decisions.list();
  }

  /** Parks the linked work item (if any) until the user answers. */
  async createDecision(workspaceId: string, input: Omit<DecisionCard, "decisionId" | "createdAt" | "answer">): Promise<DecisionCard> {
    const { store } = await this.context(workspaceId);
    let action = input.actionId ? await this.getAction(workspaceId, input.actionId) : (await this.listActions(workspaceId)).find((a) => actionIsOpen(a) && a.role !== "workbench" && (input.workItemId ? a.workItemIds.includes(input.workItemId) && a.kind !== "execute" : a.sessionId === input.sessionId));
    action ??= (await this.listActions(workspaceId)).find((a) => actionIsOpen(a) && a.kind === "execute" && a.workItemIds.includes(input.workItemId ?? ""));
    if (action && !actionIsOpen(action)) throw new Error("处理过程已结束，不能再挂起决策。");
    if (!action && input.workItemId) {
      const item = await this.getWorkItem(workspaceId, input.workItemId);
      action = await this.createAction(workspaceId, { kind: "execute", role: "worker", ownerKey: "worker:" + item.workItemId, workItemIds: [item.workItemId], missionId: item.missionId, sessionId: input.sessionId ?? item.run.sessionId, status: "running", stage: "execute", message: "理解用户决定并继续原工单。" });
    }
    const card = await store.decisions.put({ ...input, actionId: action?.actionId, decisionId: createId("d"), createdAt: this.now() });
    if (action) await this.putAction(workspaceId, { ...action, status: "decision", history: [...action.history, { at: this.now(), event: "decision.created", message: card.decisionId + " " + card.question }] });
    if (input.workItemId) {
      await this.mutateWorkItem(workspaceId, input.workItemId, (item) => (action?.kind === "execute" && (item.status === "running" || item.status === "queued") ? { ...item, status: "decision" } : item));
    }
    this.emit({ type: "decisions.changed", workspaceId });
    return card;
  }

  /**
   * Records the answer on the card and on the work item, which goes back to the queue. Either an option key, a free
   * note, or both; the work item's decision line carries the answer plus any contract adjustments made while parked,
   * so the worker's resume message has everything in one place.
   */
  async answerDecision(workspaceId: string, decisionId: string, answer: { key?: string; note?: string }): Promise<DecisionCard> {
    const { store } = await this.context(workspaceId);
    const card = await store.decisions.get(decisionId);
    if (!card) throw new Error("Unknown decision: " + decisionId);
    if (card.answer || card.withdrawn) throw new Error("决策已答复或撤回，不能重复答复。");
    if (!answer.key && !answer.note?.trim()) throw new Error("Answer needs an option key or a note");
    if (answer.key && !card.options.some((o) => o.key === answer.key)) throw new Error("Unknown option: " + answer.key);
    const answered = await store.decisions.put({ ...card, answer: { ...answer, at: this.now() }, deliveryPending: true });
    await this.flushDecision(workspaceId, answered);
    this.emit({ type: "decisions.changed", workspaceId });
    return (await store.decisions.get(decisionId))!;
  }

  async withdrawDecision(workspaceId: string, decisionId: string, sessionId: string, reason: string): Promise<DecisionCard> {
    const { store } = await this.context(workspaceId);
    const card = await store.decisions.get(decisionId);
    if (!card) throw new Error("Unknown decision: " + decisionId);
    if (card.answer || card.withdrawn) throw new Error("只能撤回尚未答复的决策。");
    if (!reason.trim() || !card.sessionId || card.sessionId !== sessionId) throw new Error("需由发起会话附原因撤回。");
    const withdrawn = await store.decisions.put({ ...card, withdrawn: { reason: reason.trim(), sessionId, at: this.now() }, deliveryPending: true });
    await this.flushDecision(workspaceId, withdrawn);
    this.emit({ type: "decisions.changed", workspaceId });
    return (await store.decisions.get(decisionId))!;
  }

  private async flushDecision(workspaceId: string, card: DecisionCard): Promise<void> {
    const key = workspaceId + ":" + card.decisionId;
    const existing = this.decisionDeliveries.get(key);
    if (existing) return existing;
    const delivery = Promise.resolve().then(async () => {
      const message = card.withdrawn
        ? "发起者撤回决策「" + card.question + "」：" + card.withdrawn.reason + "。没有用户答复，继续处理原问题。其他等待条件仍有效。"
        : "用户决策答复：" + describeAnswer(card, card.answer!);
      await this.deliverDecision(workspaceId, card, message, card.kind === "attempts" ? card.answer?.key : undefined);
      const { store } = await this.context(workspaceId);
      await store.decisions.put({ ...(await store.decisions.get(card.decisionId))!, deliveryPending: false });
    });
    this.decisionDeliveries.set(key, delivery);
    try { await delivery; } finally { this.decisionDeliveries.delete(key); }
  }

  private async deliverDecision(workspaceId: string, card: DecisionCard, message: string, recoveryChoice?: string): Promise<void> {
    const action = card.actionId ? await this.getAction(workspaceId, card.actionId) : undefined;
    const cards = await this.listDecisions(workspaceId);
    if (card.workItemId) await this.mutateWorkItem(workspaceId, card.workItemId, (item) => ({ ...item,
      status: item.status === "decision" && !cards.some((other) => other.workItemId === item.workItemId && !other.answer && !other.withdrawn) ? "queued" : item.status,
      decisions: item.decisions.includes(message) ? item.decisions : [...item.decisions, message], run: action?.kind === "execute" ? { ...item.run, resumeMessage: message } : item.run }));
    if (!action || !actionIsOpen(action)) return;
    if (recoveryChoice === "cancel") {
      for (const id of action.workItemIds) {
        const item = await this.getWorkItem(workspaceId, id);
        if (item.status !== "closed" && item.status !== "cancelled") await this.cancelWorkItem(workspaceId, id);
        else for (const pending of await this.listActions(workspaceId)) if (pending.kind === "integration" && pending.workItemIds.includes(id) && actionIsOpen(pending)) await this.putAction(workspaceId, { ...pending, status: "cancelled" });
      }
      await this.putAction(workspaceId, { ...await this.getAction(workspaceId, action.actionId), status: "cancelled", history: [...action.history, { at: this.now(), event: "decision.cancelled", message, decisionId: card.decisionId }] });
      return;
    }
    if (action.history.some((entry) => entry.decisionId === card.decisionId)) return;
    const waiting = cards.some((other) => other.actionId === action.actionId && !other.answer && !other.withdrawn);
    await this.putAction(workspaceId, { ...action, status: waiting ? "decision" : "pending", stage: action.sessionId ? "deliver" : action.stage,
      message: action.message + "\n" + message, ...(recoveryChoice === "retry" ? { attempts: 0, idleTurns: 0, failure: undefined, retryAt: undefined } : {}),
      history: [...action.history, { at: this.now(), event: card.withdrawn ? "decision.withdrawn" : "decision.answered", message, decisionId: card.decisionId }] });
  }

  // ---- inbox ----

  async listInbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const workspace of await this.listWorkspaces()) {
      const { store } = await this.context(workspace.workspaceId);
      for (const card of await store.decisions.list()) {
        if (!card.answer && !card.withdrawn) items.push({ kind: "decision", workspaceId: workspace.workspaceId, card });
      }
      const missions = await store.missions.list();
      for (const workItem of await store.workItems.list()) {
        if (workItem.status !== "closed" || !workItem.merge || workItem.merge.acknowledgedAt) continue;
        items.push({ kind: "merged", workspaceId: workspace.workspaceId, workItem, mission: missions.find((m) => m.missionId === workItem.missionId) });
      }
    }
    return items;
  }
}

/** "question -> chosen option (note)" or "question -> 备注：note", followed by the contract changes made while the card waited. */
const describeAnswer = (card: DecisionCard, answer: { key?: string; note?: string }): string => {
  const option = card.options.find((o) => o.key === answer.key);
  const note = answer.note?.trim();
  const chosen = option ? option.label + (note ? " (" + note + ")" : "") : "备注：" + note;
  const adjustments = (card.adjustments ?? []).map((a) => "；挂起期间工单调整：" + a.note).join("");
  return card.question + " -> " + chosen + adjustments;
};

const watchedAreas: Record<string, Exclude<Extract<WorkbenchEvent, { workspaceId: string }>, { sessionId: string } | { workItemId: string }>["type"] | undefined> = {
  docs: "docs.changed",
  roles: "roles.changed",
  missions: "missions.changed",
  workitems: "workItems.changed",
  decisions: "decisions.changed",
  runs: "runs.changed",
  actions: "actions.changed",
  "scheduler.json": "scheduler.changed"
};
