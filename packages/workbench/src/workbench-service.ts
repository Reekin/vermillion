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
  WorkRequest,
  RoleFile,
  WorkItem,
  WorkbenchEvent,
  Workspace
} from "./contracts.js";
import { effectiveNeeds, actionIsOpen, type WorkflowAction, type Execution, type Integration, type WorkItemRecord } from "./contracts.js";
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

export type WorkbenchServiceOptions = {
  workspaces: WorkspaceSource;
  roles: RoleService;
  sessionNavigation?: SessionNavigationPort;
  /** Starts isolated app instances for acceptance; absent when running without a desktop build around. */
  launcher?: AppLauncher;
  now?: () => string;
};

type WorkspaceContext = { rootPath: string; store: WorkspaceStore; docs: DocsService; watcher?: Pick<FSWatcher, "close"> };

export class WorkbenchService {
  private readonly workspaces: WorkspaceSource;
  private readonly roles: RoleService;
  private readonly sessionNavigation?: SessionNavigationPort;
  private readonly launcher?: AppLauncher;
  private readonly now: () => string;
  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly contextLoads = new Map<string, Promise<WorkspaceContext>>();
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();
  private readonly integrations = new Map<string, Promise<unknown>>();
  private readonly decisionDeliveries = new Map<string, Promise<void>>();
  private schedulerOwner?: object;
  private sourceTurnResolver?: (sessionId: string) => Promise<string>;
  private workerActive?: (sessionId: string) => boolean;
  private releaseWorkerEnvironment?: (sessionId: string) => Promise<void>;

  setWorkerEnvironmentReleaser(release: (sessionId: string) => Promise<void>): () => void {
    this.releaseWorkerEnvironment = release;
    return () => { if (this.releaseWorkerEnvironment === release) this.releaseWorkerEnvironment = undefined; };
  }

  setWorkerActiveChecker(checker: (sessionId: string) => boolean): () => void {
    this.workerActive = checker;
    return () => { if (this.workerActive === checker) this.workerActive = undefined; };
  }

  setSourceTurnResolver(resolver: (sessionId: string) => Promise<string>): () => void {
    this.sourceTurnResolver = resolver;
    return () => { if (this.sourceTurnResolver === resolver) this.sourceTurnResolver = undefined; };
  }

  constructor(options: WorkbenchServiceOptions) {
    this.workspaces = options.workspaces;
    this.roles = options.roles;
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

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.contextLoads.values()]);
    for (const context of this.contexts.values()) context.watcher?.close();
    await Promise.allSettled([...this.integrations.values()]);
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
    const existing = this.contexts.get(workspaceId);
    if (existing) return existing;
    const pending = this.contextLoads.get(workspaceId);
    if (pending) return pending;
    const load = this.loadContext(workspaceId);
    this.contextLoads.set(workspaceId, load);
    try { return await load; }
    finally { if (this.contextLoads.get(workspaceId) === load) this.contextLoads.delete(workspaceId); }
  }

  private async loadContext(workspaceId: string): Promise<WorkspaceContext> {
    const cached = this.contexts.get(workspaceId);
    if (cached) return cached;
    const workspace = (await this.listWorkspaces()).find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw new Error("Unknown workspace: " + workspaceId);
    const store = new WorkspaceStore(workspace.rootPath);
    await store.validateExecutionStorage();
    const docs = new DocsService(workspace.rootPath);
    await docs.ensureRepo();
    const context: WorkspaceContext = { rootPath: workspace.rootPath, store, docs };
    try {
      context.watcher = docs.watch((area) => {
        if (area === "git") {
          void this.integrate(workspaceId, () => this.refreshDocRefs(workspaceId)).catch((error) => console.error("[workbench] document revision", workspaceId, error));
          return;
        }
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
    const pending = await docs.pendingChanges();
    const paths = input.paths ?? pending.map((entry) => entry.path);
    const notices = await Promise.all(paths.map(async (path) => ({ path, diff: await docs.diff(path) })));
    const { commit } = await this.commitDocChanges(docs, message, input.paths);
    for (const item of await this.listWorkItems(workspaceId)) {
      if (["closed", "cancelled"].includes(item.status)) continue;
      const changed = notices.filter((notice) => item.refs.some((ref) => ref.path === notice.path));
      if (!changed.length) continue;
      await this.updateWorkItem(workspaceId, item.workItemId, {
        refs: item.refs.map((ref) => paths.includes(ref.path) ? { ...ref, commit } : ref),
        note: "引用文档已提交 " + commit + "\n" + changed.map((notice) => notice.diff).join("\n")
      });
    }
    this.emit({ type: "docs.changed", workspaceId });
    return { commit, message };
  }

  async refreshDocRefs(workspaceId: string): Promise<void> {
    const { docs } = await this.context(workspaceId);
    const head = await docs.head();
    if (!head) return;
    for (const item of await this.listWorkItems(workspaceId)) {
      if (["closed", "cancelled"].includes(item.status)) continue;
      const changes = await Promise.all(item.refs.filter((ref) => ref.commit !== head).map(async (ref) => ({
        path: ref.path, diff: await docs.committedDiff(ref.path, ref.commit, head)
      })));
      const changed = changes.filter((change) => change.diff.trim());
      if (!changed.length) continue;
      await this.updateWorkItem(workspaceId, item.workItemId, {
        refs: item.refs.map((ref) => changed.some((change) => change.path === ref.path) ? { ...ref, commit: head } : ref),
        note: "引用文档已提交 " + head + "\n" + changed.map((change) => change.diff).join("\n")
      });
    }
  }

  // ---- sessions ----

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

  private async commitDocChanges(docs: DocsService, message: string, paths: string[] | undefined) {
    if (paths?.length === 0) throw new Error("Select at least one doc path to commit.");
    const pending = await docs.pendingChanges();
    const selected = paths ? pending.filter((c) => paths.includes(c.path)) : pending;
    if (selected.length === 0) throw new Error("No pending doc changes to commit.");
    const selectedPaths = selected.map((c) => c.path);
    const commit = await docs.commit(message, selectedPaths);
    return { commit, message, paths: selectedPaths };
  }

  async listWorkItems(workspaceId: string): Promise<WorkItem[]> {
    const list = await (await this.context(workspaceId)).store.workItems.list();
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async startWork(workspaceId: string, input: { sessionId: string; turnId?: string; scope?: string }): Promise<WorkRequest> {
    const turnId = input.turnId ?? await this.sourceTurnResolver?.(input.sessionId);
    if (!turnId) throw new Error("需要有效 turnId；省略时必须连接桌面解析当前会话节点。");
    return this.putWorkRequest(workspaceId, { requestId: createId("work"), sourceSessionId: input.sessionId,
      sourceTurnId: turnId, scope: input.scope, status: "pending", createdAt: this.now(), updatedAt: this.now() });
  }

  async listWorkRequests(workspaceId: string): Promise<WorkRequest[]> {
    return (await this.context(workspaceId)).store.workRequests.list();
  }

  async putWorkRequest(workspaceId: string, request: WorkRequest): Promise<WorkRequest> {
    const saved = await (await this.context(workspaceId)).store.workRequests.put({ ...request, updatedAt: this.now() });
    this.emit({ type: "workRequests.changed", workspaceId });
    return saved;
  }

  async retryWork(workspaceId: string, requestId: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || request.status !== "failed") throw new Error("只有失败的开工请求可以重试。");
    if ((await this.listDecisions(workspaceId)).some((card) => card.requestId === requestId && !card.answer && !card.withdrawn)) throw new Error("开工请求正在等待用户答复，请通过 decision.answer 选择再试。");
    return this.putWorkRequest(workspaceId, { ...request, status: request.workerSessionId ? "preparing" : "pending", attempts: 0, retryAt: undefined });
  }

  async failWorkRequest(workspaceId: string, requestId: string, failure: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("Unknown work request: " + requestId);
    const attempts = (request.attempts ?? 0) + 1;
    const minutes = RETRY_MINUTES[attempts - 1];
    const saved = await this.putWorkRequest(workspaceId, { ...request, attempts, failure,
      status: minutes === undefined ? "failed" : request.workerSessionId ? "preparing" : "pending",
      retryAt: minutes === undefined ? undefined : new Date(Date.parse(this.now()) + minutes * 60_000).toISOString() });
    if (minutes === undefined && !(await this.listDecisions(workspaceId)).some((card) => card.requestId === requestId && !card.answer && !card.withdrawn))
      await this.createDecision(workspaceId, { requestId, kind: "attempts", sessionId: request.workerSessionId,
        question: "开工准备未能完成，要再试还是取消？", context: "准备过程已自动恢复四次，仍未完成。已有准备分支和工单保留。", details: failure,
        options: [{ key: "retry", label: "再试" }, { key: "cancel", label: "取消" }] });
    return saved;
  }

  async finishPreparation(workspaceId: string, sessionId: string, turnId?: string): Promise<void> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.workerSessionId === sessionId && entry.status === "preparing");
    if (!request) return;
    const forkTurnId = turnId ?? await this.sourceTurnResolver?.(sessionId);
    for (const item of await this.listWorkItems(workspaceId)) {
      if (item.status === "preparing" && item.requestId === request.requestId) {
        if (!item.run.sessionId && !forkTurnId) throw new Error("无法解析准备分支末端，不能 fork 其余工单。");
        await this.updateExecution(workspaceId, item.workItemId, (execution, current) => ({ item: { ...current, status: "queued" },
          execution: { ...execution, ...(!execution.sessionId ? { forkSessionId: sessionId, forkTurnId } : {}) } }));
      }
    }
    for (const request of await this.listWorkRequests(workspaceId)) {
      if (request.workerSessionId === sessionId && request.status === "preparing")
        await this.putWorkRequest(workspaceId, { ...request, status: "ready", failure: undefined, retryAt: undefined });
    }
  }

  async refreshActions(workspaceId: string): Promise<void> {
    for (const card of await this.listDecisions(workspaceId)) if (card.deliveryPending) await this.flushDecision(workspaceId, card);
    const items = await this.listWorkItems(workspaceId);
    for (const item of items) {
      const actions = (await this.listActions(workspaceId)).filter((a) => a.workItemId === item.workItemId && actionIsOpen(a));
      if (["closed", "cancelled", "merging", "decision"].includes(item.status)) {
        for (const action of actions.filter((a) => a.kind === "execute" && a.status !== "decision"))
          await this.finishAction(workspaceId, action.actionId, "工单已进入 " + item.status);
      }
      if (item.status !== "queued" && item.status !== "running") continue;
      const cancelled = item.dependsOn.filter((id) => items.find((other) => other.workItemId === id)?.status === "cancelled");
      if (cancelled.length) {
        await this.createDecision(workspaceId, { workItemId: item.workItemId, sessionId: item.run.sessionId,
          question: "前置工作已取消，如何继续？", context: "当前工作需要的前置已取消。请调整依赖或取消本单。", details: cancelled.join(", "),
          options: [{ key: "adjust", label: "调整依赖" }, { key: "cancel", label: "取消" }] });
        continue;
      }
      if (!actions.some((a) => a.kind === "execute") && !(await this.isWorkItemBlocked(workspaceId, item.workItemId))) {
        const execution = (await this.listActions(workspaceId)).find((a): a is Execution => a.kind === "execute" && a.workItemId === item.workItemId)!;
        await this.updateAction(workspaceId, execution, (execution) => ({ ...execution, status: "pending", stage: execution.sessionId ? "deliver" : "open" }));
      }
    }
  }

  async getWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const item = await (await this.context(workspaceId)).store.workItems.get(workItemId);
    if (!item) throw new Error("Unknown work item: " + workItemId);
    return item;
  }

  async listActions(workspaceId: string): Promise<WorkflowAction[]> {
    return (await this.context(workspaceId)).store.actions.list();
  }

  async createAction(workspaceId: string, input: Omit<Integration, "actionId" | "history" | "createdAt" | "updatedAt" | "attempts">, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<Integration> {
    const now = this.now();
    const saved = await (await this.context(workspaceId)).store.actions.createIntegration({ ...input, actionId: createId("action"), attempts: 0, history: [{ at: now, event: "created", message: input.message }], createdAt: now, updatedAt: now }, mutateItem);
    this.emit({ type: "actions.changed", workspaceId });
    this.emit({ type: "workItems.changed", workspaceId });
    return saved;
  }

  async updateAction<T extends WorkflowAction>(workspaceId: string, action: T, mutate: (current: T) => T, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<T> {
    const saved = await (await this.context(workspaceId)).store.actions.update(action,
      (current) => ({ ...mutate(current), updatedAt: this.now() }), mutateItem);
    this.emit({ type: "actions.changed", workspaceId });
    this.emit({ type: "workItems.changed", workspaceId });
    return saved;
  }

  private async updateExecution(workspaceId: string, workItemId: string, mutate: (execution: Execution, item: WorkItemRecord["item"]) => { execution: Execution; item?: WorkItemRecord["item"] }): Promise<WorkItem> {
    const saved = await (await this.context(workspaceId)).store.updateExecution(workItemId, (execution, item) => {
      const next = mutate(execution, item);
      return { execution: { ...next.execution, updatedAt: this.now() }, item: { ...(next.item ?? item), updatedAt: this.now() } };
    });
    this.emit({ type: "workItems.changed", workspaceId });
    this.emit({ type: "actions.changed", workspaceId });
    return saved;
  }

  private async getAction(workspaceId: string, actionId: string): Promise<WorkflowAction> {
    const action = await (await this.context(workspaceId)).store.actions.get(actionId);
    if (!action) throw new Error("Unknown action: " + actionId);
    return action;
  }

  async finishAction(workspaceId: string, actionId: string, note: string): Promise<WorkflowAction> {
    const action = await this.getAction(workspaceId, actionId);
    return this.updateAction(workspaceId, action, (action) => ({ ...action, status: "done", retryAt: undefined, history: [...action.history, { at: this.now(), event: "resolved", message: note }] }));
  }

  async isWorkItemBlocked(workspaceId: string, workItemId: string): Promise<boolean> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    const items = await this.listWorkItems(workspaceId);
    return item.dependsOn.some((id) => items.find((other) => other.workItemId === id)?.status !== "closed")
      || (await this.listActions(workspaceId)).some((action) => actionIsOpen(action) && action.workItemId === workItemId && action.kind === "integration")
      || (await this.listDecisions(workspaceId)).some((card) => card.workItemId === workItemId && !card.answer && !card.withdrawn);
  }

  registerScheduler(): () => void {
    const owner = {};
    this.schedulerOwner = owner;
    return () => { if (this.schedulerOwner === owner) this.schedulerOwner = undefined; };
  }

  async getRuntimeInfo() {
    return { ...runtimeInfo, schedulerOnline: !!this.schedulerOwner };
  }

  async diagnoseWorkItem(workspaceId: string, workItemId: string) {
    return diagnose(this, workspaceId, workItemId, !!this.schedulerOwner);
  }

  async failAction(workspaceId: string, actionId: string, failure: string): Promise<WorkflowAction> {
    const action = await this.getAction(workspaceId, actionId);
    if (!actionIsOpen(action) || action.status === "decision") return action;
    const attempts = action.attempts + 1;
    const delay = RETRY_MINUTES[attempts - 1];
    const failed = await this.updateAction(workspaceId, action, (action) => ({ ...action, attempts, failure, status: delay === undefined ? "decision" : "retry",
      retryAt: delay === undefined ? undefined : new Date(Date.parse(this.now()) + delay * 60_000).toISOString(),
      history: [...action.history, { at: this.now(), event: "failed:" + action.stage, message: failure }] }),
      action.kind === "execute" ? (item) => ({ ...item, status: delay === undefined ? "decision" : "queued" }) : undefined);
    if (delay === undefined && !(await this.listDecisions(workspaceId)).some((card) => card.actionId === actionId && !card.answer && !card.withdrawn)) {
      await this.createDecision(workspaceId, { actionId, kind: "attempts", workItemId: action.workItemId, sessionId: action.kind === "execute" ? action.sessionId : undefined,
        question: "自动恢复已用尽，要再试还是取消当前工作？", context: "工作台已尝试自动恢复四次，仍未完成当前处理。原会话与成果保留，选择再试后会从未完成的动作继续。",
        details: "阶段：" + action.stage + "\n受影响工单：" + action.workItemId + "\n" + failed.history.filter((h) => h.event.startsWith("failed:")).map((h) => h.at + " " + h.message).join("\n"),
        options: [{ key: "retry", label: "再试", detail: "清零此处理过程的失败计数，从未完成动作继续。" }, { key: "cancel", label: "取消当前工作", detail: "取消该过程关联的工单；已合入成果保持保留。" }], recommended: "retry", recommendation: "故障已排除时可沿原处理过程继续。" });
    }
    return this.getAction(workspaceId, actionId);
  }

  /** Dependencies and agent actions share one durable queue; facts, not delivery receipts, release waiting work. */
  async createWorkItem(
    workspaceId: string,
    input: Pick<WorkItem, "title" | "objective" | "risk" | "scope" | "acceptance"> & { sessionId?: string; sourceSessionId?: string; sourceTurnId?: string; treeId?: string; requestId?: string; worktreePath?: string; branch?: string; refs?: WorkItem["refs"]; needs?: string[]; dependsOn?: string[] }
  ): Promise<WorkItem> {
    const now = this.now();
    const { store } = await this.context(workspaceId);
    if (!!input.worktreePath !== !!input.branch) throw new Error("worktreePath 与 branch 必须同时提供。");
    if (input.needs?.some((need) => ["browser", "desktop"].includes(need.trim()))) throw new Error("needs 必须指明具体共享实例，例如 browser:qa-profile。");
    const request = input.requestId ? await store.workRequests.get(input.requestId) : undefined;
    if (input.requestId && (!request || request.status !== "preparing" || (input.sessionId && request.workerSessionId !== input.sessionId))) throw new Error("requestId 必须属于当前准备分支。");
    if (input.sessionId && (await store.workItems.list()).some((item) => item.run.sessionId === input.sessionId && !["closed", "cancelled"].includes(item.status))) throw new Error("同一执行分支只能绑定一张未结束工单。其他工单请 fork 兄弟分支。");
    await this.checkDependencies(workspaceId, "(new)", input.dependsOn ?? []);
    const item = await store.workItems.create({
      workItemId: createId("wi"),
      sourceSessionId: request?.sourceSessionId ?? input.sourceSessionId, sourceTurnId: request?.sourceTurnId ?? input.sourceTurnId, treeId: request?.treeId ?? input.treeId, requestId: input.requestId,
      title: input.title.trim(),
      objective: input.objective,
      status: request ? "preparing" : "queued",
      risk: input.risk,
      needs: input.needs ?? [],
      dependsOn: input.dependsOn ?? [],
      refs: input.refs ?? [],
      scope: input.scope,
      acceptance: input.acceptance,
      review: [],
      rejections: [],
      decisions: [],
      createdAt: now,
      updatedAt: now
    }, { sessionId: input.sessionId, worktreePath: input.worktreePath, branch: input.branch });
    this.emit({ type: "workItems.changed", workspaceId });
    return item;
  }

  private async mutateWorkItem(workspaceId: string, workItemId: string, mutate: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<WorkItem> {
    const { store } = await this.context(workspaceId);
    const updated = await store.workItems.update(workItemId, (item) => ({ ...mutate(item), updatedAt: this.now() }));
    this.emit({ type: "workItems.changed", workspaceId });
    return updated;
  }

  /** Worker claimed the item; records the session and worktree it runs in. */
  /** A (re)start begins a new turn: the pending message is claimed and any stale-turn mark from the previous run is over. */
  async startWorkItem(workspaceId: string, workItemId: string, run: Pick<Execution, "sessionId" | "heartbeatAt">): Promise<WorkItem> {
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (current.status !== "queued" && !(current.status === "running" && current.run.sessionId === run.sessionId)) throw new Error("只有可执行的排队工单可以启动，已结束或等待合入的工单不能重新认领。");
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("工单仍有未解决的等待条件，请读取 action.list。");
    const occupied = (await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running");
    const scheduler = await this.getScheduler(workspaceId);
    if (occupied.length >= scheduler.maxWorkers || occupied.some((item) => effectiveNeeds(item).some((need) => effectiveNeeds(current).includes(need)))) throw new Error("并发或共享资源尚未释放，保持排队。");
    const baseCommit = current.run.baseCommit ?? await (await this.context(workspaceId)).docs.head().catch(() => undefined);
    return this.updateExecution(workspaceId, workItemId, (execution, item) => ({
      item: { ...item, status: "running" },
      execution: { ...execution, sessionId: run.sessionId ?? execution.sessionId, heartbeatAt: run.heartbeatAt ?? execution.heartbeatAt,
        baseCommit, retryAt: undefined, staleTurnId: undefined }
    }));
  }

  async heartbeatWorkItem(workspaceId: string, workItemId: string, lastTurnId?: string): Promise<WorkItem> {
    return this.updateExecution(workspaceId, workItemId, (execution) => ({ execution: { ...execution, lastTurnId: lastTurnId ?? execution.lastTurnId, heartbeatAt: this.now() } }));
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
      const failures = (submitted.verificationFailures ?? 0) + 1;
      await this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, verificationFailures: failures }));
      if (failures >= 2) {
        await this.createDecision(workspaceId, { workItemId, sessionId: submitted.run.sessionId, question: "验收连续未通过，需要调整目标或继续返工吗？",
          context: "已连续两次提交未通过验收，原会话和成果保留。", details: reason,
          options: [{ key: "retry", label: "继续返工" }, { key: "cancel", label: "取消" }] });
        return this.getWorkItem(workspaceId, workItemId);
      }
      return this.returnWorkItem(workspaceId, workItemId, reason);
    }
    await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "merge", message: "验收通过，等待合入。", integration: { operation: "merge", diffStat: "" } },
      (item) => ({ ...item, status: "merging", updatedAt: this.now() }));
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  /** Accepts the work: merges the worker's branch into the workspace (when it ran in a worktree) and closes the item. */
  async continueIntegrations(workspaceId: string): Promise<void> {
    await this.integrate(workspaceId, () => this.drainIntegrations(workspaceId));
  }

  private async drainIntegrations(workspaceId: string): Promise<void> {
    const actions = await this.listActions(workspaceId);
    const { docs } = await this.context(workspaceId);
    const pending = actions.filter((a): a is Integration => a.kind === "integration" && actionIsOpen(a) && a.status !== "decision" && (!a.retryAt || a.retryAt <= this.now()));
    for (let action of pending) {
      const workItemId = action.workItemId;
      let item = await this.getWorkItem(workspaceId, workItemId);
      try {
        let integration = action.integration!;
        if (action.stage === "merge") {
          if (item.run.worktreePath && item.run.branch) {
            if (!integration.target) {
              const snapshot = await docs.integrationSnapshot(item.run.branch);
              integration = { ...integration, before: snapshot.head, target: snapshot.target, diffStat: snapshot.diffStat };
              action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration }));
            }
            const result = await docs.mergeWorktree(item.run.worktreePath, item.run.branch, item.title, integration.target);
            // Recovering an already merged target still uses the original frozen diff and commit.
            integration = { ...integration, commit: result.commit ?? await docs.getMergeCommit(integration.target!, integration.before!) };
          } else {
            integration = { ...integration, ...await docs.rootResult(item.evidence?.commit, item.run.baseCommit, item.scope.allowedPaths) };
          }
          action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration, stage: "cleanup" }));
          item = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, merge: { commit: integration.commit, commits: integration.commits, diffStat: integration.diffStat, mergedAt: this.now() } }));
        }
        if (action.stage === "rollback") {
          if (!integration.before) {
            integration = { ...integration, before: await docs.head() };
            action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration }));
          }
          let commit: string | undefined;
          for (const target of [...(integration.targets ?? [integration.target!])].reverse()) commit = await docs.rollbackMerge(target, integration.before);
          integration = { ...integration, commit };
          action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration, stage: "cleanup" }));
          item = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, merge: { ...current.merge!, rollbackCommit: commit, acknowledgedAt: this.now() } }));
        }
        if (action.stage === "cleanup") {
          if (item.run.sessionId && this.workerActive?.(item.run.sessionId)) continue;
          if (item.run.sessionId) await this.releaseWorkerEnvironment?.(item.run.sessionId);
          if (item.run.worktreePath && item.run.branch) {
            await docs.dropWorktree(item.run.worktreePath, item.run.branch, integration.operation === "cancel");
          }
          await this.updateExecution(workspaceId, workItemId, (execution, current) => ({ item: { ...current, status: integration.operation === "cancel" ? "cancelled" : integration.operation === "rollback" ? "queued" : "closed",
            merge: integration.operation === "merge" ? { commit: integration.commit, commits: integration.commits, diffStat: integration.diffStat, mergedAt: current.merge?.mergedAt ?? this.now() }
              : integration.operation === "rollback" ? { ...current.merge!, rollbackCommit: integration.commit, acknowledgedAt: this.now() } : current.merge },
            execution: { ...execution, worktreePath: undefined, branch: undefined, baseCommit: integration.operation === "rollback" ? integration.commit : execution.baseCommit,
              message: integration.operation === "rollback" ? "用户回滚：" + integration.reason + "。重新判断隔离目录，需要时自行创建并通过 workItem.update 登记。" : execution.message } }));
          await this.finishAction(workspaceId, action.actionId, "已完成 " + integration.operation + " 及清理。");
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof WorktreeMergeConflict || error instanceof WorktreeNotReady) {
          await this.finishAction(workspaceId, action.actionId, "转回原 Worker：" + reason);
          await this.returnWorkItem(workspaceId, workItemId, reason + "\n在原 worktree rebase 并更新受影响验证后重新提交。");
        } else {
          await this.failAction(workspaceId, action.actionId, reason);
          return;
        }
      }
    }
  }

  private async returnWorkItem(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    return this.updateExecution(workspaceId, workItemId, (execution, item) => ({
      item: { ...item, status: "queued", evidence: undefined, verify: undefined, rejections: [...item.rejections, { reason, at: this.now() }] },
      execution: { ...execution, idleTurns: 0, staleTurnId: undefined, message: [execution.message, reason].filter(Boolean).join("\n") }
    }));
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
    if (!(await this.listActions(workspaceId)).some((a) => a.kind === "integration" && a.workItemId === workItemId && actionIsOpen(a))) {
      await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "rollback", message: "用户回滚：" + reason.trim(), integration: { operation: "rollback", target: item.merge.commit, targets: item.merge.commits, diffStat: "", reason: reason.trim() } });
    }
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  async cancelWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status === "closed") throw new Error("已合入工单请使用回滚入口，不能取消已完成成果。");
    const cancelled = await this.updateExecution(workspaceId, workItemId, (execution, current) => ({
      item: { ...current, status: "cancelled" }, execution: { ...execution, status: "cancelled" }
    }));
    for (const action of await this.listActions(workspaceId)) {
      if (action.workItemId === workItemId && actionIsOpen(action)) await this.updateAction(workspaceId, action, (action) => ({ ...action, status: "cancelled" }));
    }
    const dependants = (await this.listWorkItems(workspaceId)).filter((w) => !["closed", "cancelled"].includes(w.status) && w.dependsOn.includes(workItemId)).map((w) => w.workItemId);
    this.emit({ type: "workItem.cancelled", workspaceId, workItemId, sessionId: item.run.sessionId, dependants });
    if (item.run.sessionId || (item.run.worktreePath && item.run.branch)) {
      await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "cleanup", message: "取消后的工作目录清理。", integration: { operation: "cancel", diffStat: "" } });
      await this.continueIntegrations(workspaceId);
    }
    return cancelled;
  }

  async updateWorkItem(
    workspaceId: string,
    workItemId: string,
    input: Partial<Pick<WorkItem, "title" | "objective" | "refs" | "scope" | "acceptance" | "risk" | "needs" | "dependsOn">> & { note: string; worktreePath?: string; branch?: string }
  ): Promise<WorkItem> {
    const { note, worktreePath, branch, ...changes } = input;
    if (!!worktreePath !== !!branch) throw new Error("worktreePath 与 branch 必须同时提供。");
    if (changes.needs?.some((need) => ["browser", "desktop"].includes(need.trim()))) throw new Error("needs 必须指明具体共享实例。");
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (changes.dependsOn) await this.checkDependencies(workspaceId, workItemId, changes.dependsOn);
    const occupied = changes.needs?.length
      ? new Set((await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running").flatMap((item) => item.needs))
      : new Set<string>();
    const updated = await this.updateExecution(workspaceId, workItemId, (execution, item) => {
      if (item.status === "closed" || item.status === "cancelled") throw new Error("Work item is " + item.status + ": " + workItemId);
      const conflict = item.status === "running" ? changes.needs?.find((need) => occupied.has(need)) : undefined;
      if (conflict !== undefined) throw new Error("Resource is in use: " + conflict + ". Release it before updating this running work item.");
      const status = item.status;
      // While parked the note lives on the decision card and reaches the worker inside the answer line.
      const decisions = status === "decision" ? item.decisions : [...item.decisions, "工单调整：" + note];
      return {
        item: { ...item, ...changes, status, decisions },
        execution: { ...execution, ...(worktreePath ? { worktreePath, branch } : {}), message: [execution.message, "工单已调整：" + note].filter(Boolean).join("\n") }

      };
    });
    if (changes.dependsOn?.some((id) => !current.dependsOn.includes(id)) && updated.status === "running") {
      await this.updateExecution(workspaceId, workItemId, (execution, item) => ({ item: { ...item, status: "queued" }, execution: { ...execution, message: "依赖调整已落实。前置关闭后读取最新合同，rebase 后继续。" } }));
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
      if (!children) throw new Error("前置工单不存在：" + id + "。请调整 dependsOn。");
      for (const child of children) visit(child, [...chain, id]);
    };
    visit(workItemId, []);
  }

  /** Orchestrator: marks/clears the turn during which a contract change landed mid-flight. */
  async setWorkItemStaleTurn(workspaceId: string, workItemId: string, staleTurnId: string | undefined): Promise<WorkItem> {
    return this.updateExecution(workspaceId, workItemId, (execution) => ({ execution: { ...execution, staleTurnId } }));
  }

  /**
   * Scheduler: the worker session ended without submit or decision. Back to the queue with the failure noted; after
   * four delayed retries the item is parked on a decision card instead so the user sees it.
   */
  async requeueWorkItem(workspaceId: string, workItemId: string, failure: string): Promise<WorkItem> {
    await this.refreshActions(workspaceId);
    const action = (await this.listActions(workspaceId)).find((entry) => entry.kind === "execute" && entry.workItemId === workItemId && actionIsOpen(entry));
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
    const action = input.actionId ? await this.getAction(workspaceId, input.actionId) : (await this.listActions(workspaceId)).find((a) => actionIsOpen(a) && a.kind === "execute" && (input.workItemId ? a.workItemId === input.workItemId : a.sessionId === input.sessionId));
    if (action && !actionIsOpen(action)) throw new Error("处理过程已结束，不能再挂起决策。");
    const card = await store.decisions.put({ ...input, actionId: action?.actionId, decisionId: createId("d"), createdAt: this.now() });
    if (action) await this.updateAction(workspaceId, action,
      (action) => ({ ...action, status: "decision", history: [...action.history, { at: this.now(), event: "decision.created", message: card.decisionId + " " + card.question }] }),
      action.kind === "execute" && input.workItemId ? (item) => ["running", "queued"].includes(item.status) ? { ...item, status: "decision" } : item : undefined);
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

  private async flushDecision(workspaceId: string, card: DecisionCard): Promise<void> {
    const key = workspaceId + ":" + card.decisionId;
    const existing = this.decisionDeliveries.get(key);
    if (existing) return existing;
    const delivery = Promise.resolve().then(async () => {
      if (!card.answer) return;
      const message = "用户决策答复：" + describeAnswer(card, card.answer);
      await this.deliverDecision(workspaceId, card, message, card.answer?.key === "cancel" || card.answer?.key === "retry" ? card.answer.key : undefined);
      const { store } = await this.context(workspaceId);
      await store.decisions.put({ ...(await store.decisions.get(card.decisionId))!, deliveryPending: false });
    });
    this.decisionDeliveries.set(key, delivery);
    try { await delivery; } finally { this.decisionDeliveries.delete(key); }
  }

  private async deliverDecision(workspaceId: string, card: DecisionCard, message: string, recoveryChoice?: string): Promise<void> {
    if (card.requestId) {
      if (recoveryChoice === "retry") await this.retryWork(workspaceId, card.requestId);
      if (recoveryChoice === "cancel") for (const item of await this.listWorkItems(workspaceId)) {
        if (item.requestId === card.requestId && !["closed", "cancelled"].includes(item.status)) await this.cancelWorkItem(workspaceId, item.workItemId);
      }
      return;
    }
    const action = card.actionId ? await this.getAction(workspaceId, card.actionId) : undefined;
    const cards = await this.listDecisions(workspaceId);
    const recordAnswer = (item: WorkItemRecord["item"]): WorkItemRecord["item"] => ({ ...item,
      status: item.status === "decision" && !cards.some((other) => other.workItemId === item.workItemId && !other.answer && !other.withdrawn) ? "queued" : item.status,
      decisions: item.decisions.includes(message) ? item.decisions : [...item.decisions, message],
      verificationFailures: recoveryChoice === "retry" ? 0 : item.verificationFailures });
    if (!action || !actionIsOpen(action)) {
      if (card.workItemId) await this.mutateWorkItem(workspaceId, card.workItemId, recordAnswer);
      return;
    }
    if (recoveryChoice === "cancel") {
      {
        const id = action.workItemId;
        const item = await this.getWorkItem(workspaceId, id);
        if (item.status !== "closed" && item.status !== "cancelled") await this.cancelWorkItem(workspaceId, id);
        else for (const pending of await this.listActions(workspaceId)) if (pending.kind === "integration" && pending.workItemId === id && actionIsOpen(pending)) await this.updateAction(workspaceId, pending, (pending) => ({ ...pending, status: "cancelled" }));
      }
      await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "cancelled", history: [...current.history, { at: this.now(), event: "decision.cancelled", message, decisionId: card.decisionId }] }), card.workItemId ? recordAnswer : undefined);
      return;
    }
    if (action.history.some((entry) => entry.decisionId === card.decisionId)) return;
    const waiting = cards.some((other) => other.actionId === action.actionId && !other.answer && !other.withdrawn);
    await this.updateAction(workspaceId, action, (current) => {
      const answered = { ...current, status: waiting ? "decision" as const : "pending" as const,
        message: current.message + "\n" + message, ...(recoveryChoice === "retry" ? { attempts: 0, failure: undefined, retryAt: undefined } : {}),
        history: [...current.history, { at: this.now(), event: "decision.answered", message, decisionId: card.decisionId }] };
      return answered.kind === "execute" ? { ...answered, stage: answered.sessionId ? "deliver" : "open", idleTurns: recoveryChoice === "retry" ? 0 : answered.idleTurns } : answered;
    }, card.workItemId ? recordAnswer : undefined);
  }

  // ---- inbox ----

  async listInbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const workspace of await this.listWorkspaces()) {
      const { store } = await this.context(workspace.workspaceId);
      for (const card of await store.decisions.list()) {
        if (!card.answer && !card.withdrawn) items.push({ kind: "decision", workspaceId: workspace.workspaceId, card });
      }
      for (const workItem of await store.workItems.list()) {
        if (workItem.status !== "closed" || !workItem.merge || workItem.merge.acknowledgedAt) continue;
        items.push({ kind: "merged", workspaceId: workspace.workspaceId, workItem });
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
  "work-requests": "workRequests.changed",
  workitems: "workItems.changed",
  decisions: "decisions.changed",
  runs: "runs.changed",
  actions: "actions.changed",
  "scheduler.json": "scheduler.changed"
};
