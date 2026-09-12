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
  Issue,
  WorkRequest,
  RoleFile,
  WorkItem,
  WorkbenchEvent,
  Workspace
} from "./contracts.js";
import { effectiveNeeds, actionIsOpen, projectWorkItem, type WorkflowAction, type Execution, type Integration, type VerifySubmission, type WorkItemRecord } from "./contracts.js";
import type { SessionNavigationPort } from "./session-navigation.js";
import { DocsService, WorktreeMergeConflict, WorktreeNotReady } from "./docs.js";
import { RoleService } from "./roles.js";
import type { AppLauncher, AppStartInput, AppStartResult, AppWindowInput, AppWindowResult } from "./app-launcher.js";
import { WorkspaceStore } from "./workspace-store.js";
import { diagnose } from "./diagnosis.js";
import { runtimeInfo } from "./runtime-info.js";
import { searchWorkbench, type SearchQuery, type SearchResult, type SessionSearchSource } from "./search.js";

const RETRY_MINUTES = [1, 5, 30, 300];

const createId = (prefix: string): string =>
  prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

/** Source of truth for workspace identity; the session engine's registry in production. */
export type WorkspaceSource = {
  list: () => Promise<Array<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>>;
  register: (input: { rootPath: string; label?: string }) => Promise<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>;
  remove: (workspaceId: string) => Promise<void>;
};

export type SessionSteerResult = {
  sessionId: string;
  turnId: string;
  delivery: "steered" | "started";
};

export type SessionSteerer = (input: {
  sessionId: string;
  content: string;
}) => Promise<SessionSteerResult>;

export type SourceAskResult = {
  answer: string;
  askSessionId: string;
  askTurnId: string;
  archived: boolean;
  archiveError?: string;
};

export type SourceAsker = (input: {
  workspaceId: string;
  workItemId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  question: string;
}) => Promise<SourceAskResult>;

export type IssueDiscussionStarter = (input: {
  workspaceId: string;
  issueId: string;
  title: string;
  content: string;
}) => Promise<{ sessionId: string; turnId?: string }>;

type IssueUpdateInput = Partial<Pick<Issue, "title" | "summary" | "domainId" | "type" | "status" | "requirement" | "suggestion" | "decisionQuestion" | "resolutionReason" | "duplicateOf">> & {
  appendEvidence?: Issue["evidence"];
  unread?: boolean;
};

export type WorkbenchServiceOptions = {
  workspaces: WorkspaceSource;
  roles: RoleService;
  sourceAsker?: SourceAsker;
  sessionSteerer?: SessionSteerer;
  issueDiscussionStarter?: IssueDiscussionStarter;
  sessionNavigation?: SessionNavigationPort;
  /** Starts isolated app instances for acceptance; absent when running without a desktop build around. */
  launcher?: AppLauncher;
  /** Controls the current Electron window when the RPC is handled inside that app process. */
  appWindowController?: (input: AppWindowInput) => Promise<AppWindowResult>;
  sessionSearch?: SessionSearchSource;
  rolloutsDir?: string;
  now?: () => string;
};

type WorkspaceContext = { rootPath: string; store: WorkspaceStore; docs: DocsService; watcher?: Pick<FSWatcher, "close"> };

export class WorkbenchService {
  private readonly workspaces: WorkspaceSource;
  private readonly roles: RoleService;
  private readonly sourceAsker?: SourceAsker;
  private readonly sessionSteerer?: SessionSteerer;
  private readonly issueDiscussionStarter?: IssueDiscussionStarter;
  private readonly sessionNavigation?: SessionNavigationPort;
  private readonly launcher?: AppLauncher;
  private readonly appWindowController?: (input: AppWindowInput) => Promise<AppWindowResult>;
  private readonly sessionSearch?: SessionSearchSource;
  private readonly rolloutsDir?: string;
  private readonly now: () => string;
  private readonly releasedWorkers = new Set<string>();
  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly contextLoads = new Map<string, Promise<WorkspaceContext>>();
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();
  private readonly integrations = new Map<string, Promise<unknown>>();
  private readonly decisionDeliveries = new Map<string, Promise<void>>();
  private schedulerOwner?: object;
  private sourceTurnResolver?: (sessionId: string) => Promise<string | undefined>;
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

  setSourceTurnResolver(resolver: (sessionId: string) => Promise<string | undefined>): () => void {
    this.sourceTurnResolver = resolver;
    return () => { if (this.sourceTurnResolver === resolver) this.sourceTurnResolver = undefined; };
  }

  constructor(options: WorkbenchServiceOptions) {
    this.workspaces = options.workspaces;
    this.roles = options.roles;
    this.sourceAsker = options.sourceAsker;
    this.sessionSteerer = options.sessionSteerer;
    this.issueDiscussionStarter = options.issueDiscussionStarter;
    this.sessionNavigation = options.sessionNavigation;
    this.launcher = options.launcher;
    this.appWindowController = options.appWindowController;
    this.sessionSearch = options.sessionSearch;
    this.rolloutsDir = options.rolloutsDir;
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
          this.emit({ type: "docs.changed", workspaceId });
          void this.refreshDocRefs(workspaceId).catch((error) => console.error("[workbench] document revision", workspaceId, error));
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

  async previewDocDiscard(workspaceId: string, paths: string[]): Promise<DocChange[]> {
    return (await this.context(workspaceId)).docs.discardPreview(paths);
  }

  async discardDocs(workspaceId: string, paths: string[]): Promise<DocChange[]> {
    return this.integrate(workspaceId, async () => {
      const changes = await (await this.context(workspaceId)).docs.discard(paths);
      if (changes.length) this.emit({ type: "docs.changed", workspaceId });
      return changes;
    });
  }

  async commitDocs(workspaceId: string, input: { message: string; paths?: string[] }): Promise<DocCommit> {
    return this.integrate(workspaceId, () => this.commitDocsRecord(workspaceId, input));
  }

  private async commitDocsRecord(workspaceId: string, input: { message: string; paths?: string[] }): Promise<DocCommit> {
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
      await this.updateWorkItemRecord(workspaceId, item.workItemId, {
        refs: item.refs.map((ref) => paths.includes(ref.path) ? { ...ref, commit } : ref),
        note: "引用文档已提交 " + commit + "\n" + changed.map((notice) => notice.diff).join("\n")
      });
    }
    this.emit({ type: "docs.changed", workspaceId });
    return { commit, message };
  }

  async refreshDocRefs(workspaceId: string): Promise<void> {
    return this.integrate(workspaceId, () => this.refreshDocRefsRecord(workspaceId));
  }

  private async refreshDocRefsRecord(workspaceId: string): Promise<void> {
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
      await this.updateWorkItemRecord(workspaceId, item.workItemId, {
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

  async controlAppWindow(input: AppWindowInput): Promise<AppWindowResult> {
    if (this.appWindowController) return this.appWindowController(input);
    throw new Error("app.window is only available through a running desktop instance");
  }

  // ---- roles ----

  async listRoles(workspaceId: string): Promise<RoleFile[]> {
    return this.roles.list((await this.context(workspaceId)).rootPath);
  }

  async readRole(workspaceId: string, roleId: string): Promise<{ content: string; source: RoleFile["source"] }> {
    return this.roles.read((await this.context(workspaceId)).rootPath, roleId);
  }

  async readRoleEditor(workspaceId: string, roleId: string) {
    const rootPath = (await this.context(workspaceId)).rootPath;
    const role = await this.roles.read(rootPath, roleId);
    const globalContent = await this.roles.readGlobal(roleId);
    return { ...role, ...(globalContent === undefined ? {} : { globalContent }) };
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

  // ---- issues ----

  async listIssues(workspaceId: string): Promise<Issue[]> {
    return (await this.context(workspaceId)).store.issues.list().then((list) => list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async getIssue(workspaceId: string, issueId: string): Promise<Issue> {
    const issue = await (await this.context(workspaceId)).store.issues.get(issueId);
    if (!issue) throw new Error("Unknown issue: " + issueId);
    return issue;
  }

  async createIssue(workspaceId: string, input: Pick<Issue, "title" | "summary" | "domainId"> & Partial<Pick<Issue, "source" | "type" | "status" | "requirement" | "evidence" | "suggestion" | "decisionQuestion" | "sourceSessionId" | "sourceTurnId">>): Promise<Issue> {
    const now = this.now();
    const source = input.source ?? "user";
    const issue: Issue = {
      issueId: createId("issue"), title: input.title.trim(), summary: input.summary, domainId: input.domainId.trim(),
      source, type: input.type ?? "problem", status: input.status ?? "open", requirement: input.requirement,
      evidence: input.evidence ?? [], suggestion: input.suggestion, decisionQuestion: input.decisionQuestion,
      sourceSessionId: input.sourceSessionId, sourceTurnId: input.sourceTurnId, workItemIds: [], unread: source !== "user",
      activities: [{ at: now, kind: "created", message: source === "user" ? "用户创建议题" : source + " 创建议题", sessionId: input.sourceSessionId }],
      createdAt: now, updatedAt: now
    };
    this.validateIssue(issue);
    const saved = await (await this.context(workspaceId)).store.transactIssue(issue.issueId, (current) => {
      if (current) throw new Error("Issue already exists: " + issue.issueId);
      return { record: issue, result: issue };
    });
    this.emit({ type: "issues.changed", workspaceId });
    return saved;
  }

  async updateIssue(workspaceId: string, issueId: string, changes: IssueUpdateInput): Promise<Issue> {
    if (changes.duplicateOf === issueId) throw new Error("Issue 不能标记为自身的重复项。");
    if (changes.duplicateOf) await this.getIssue(workspaceId, changes.duplicateOf);
    const now = this.now();
    const saved = await (await this.context(workspaceId)).store.transactIssue(issueId, (current) => {
      if (!current) throw new Error("Unknown issue: " + issueId);
      const { appendEvidence = [], ...fields } = changes;
      const status = fields.status ?? current.status;
      const message = appendEvidence.length ? `补充 ${appendEvidence.length} 条证据` : status !== current.status ? `状态变为 ${status}` : "更新议题";
      const issue: Issue = { ...current, ...fields,
        evidence: [...current.evidence, ...appendEvidence],
        activities: [...current.activities, { at: now, kind: appendEvidence.length ? "evidence" : status === "closed" || status === "duplicate" ? "resolved" : "updated", message,
          issueId: fields.duplicateOf }], updatedAt: now };
      this.validateIssue(issue);
      return { record: issue, result: issue };
    });
    this.emit({ type: "issues.changed", workspaceId });
    return saved;
  }

  async readIssue(workspaceId: string, issueId: string): Promise<Issue> {
    const saved = await (await this.context(workspaceId)).store.transactIssue(issueId, (current) => {
      if (!current) throw new Error("Unknown issue: " + issueId);
      const issue = current.unread ? { ...current, unread: false } : current;
      return { record: issue, result: issue };
    });
    if (!saved.unread) this.emit({ type: "issues.changed", workspaceId });
    return saved;
  }

  async discussIssue(workspaceId: string, issueId: string): Promise<Issue> {
    return this.integrate(workspaceId, async () => {
      const current = await this.getIssue(workspaceId, issueId);
      if (current.discussionSessionId) return current;
      if (!this.issueDiscussionStarter) throw new Error("issue.discuss requires a running desktop instance.");
      const result = await this.issueDiscussionStarter({ workspaceId, issueId, title: current.title,
        content: [
          `请围绕 Issue ${current.issueId} 与用户讨论，明确预期和处理范围。`,
          `标题：${current.title}`, `问题与影响：${current.summary}`,
          current.requirement && `要求依据：${current.requirement.text}`,
          current.evidence.length && `证据：\n${current.evidence.map((entry) => `- ${entry.kind}：${entry.text}`).join("\n")}`,
          current.suggestion && `建议方向：${current.suggestion}`,
          "如果用户决定开工，沿正常 work.start 流程创建工单；工作台会按本讨论会话自动关联此 Issue。"
        ].filter(Boolean).join("\n\n") });
      const now = this.now();
      const saved = await (await this.context(workspaceId)).store.transactIssue(issueId, (record) => {
        if (!record) throw new Error("Unknown issue: " + issueId);
        const issue: Issue = { ...record, discussionSessionId: result.sessionId, discussionTurnId: result.turnId,
          unread: false, activities: [...record.activities, { at: now, kind: "discussion", message: "创建设计讨论会话", sessionId: result.sessionId }], updatedAt: now };
        return { record: issue, result: issue };
      });
      this.emit({ type: "issues.changed", workspaceId });
      return saved;
    });
  }

  private validateIssue(issue: Issue): void {
    if (issue.status === "decision" && !issue.decisionQuestion) throw new Error("待决策 Issue 必须提供具体决策问题。");
    if (issue.status === "closed" && !issue.resolutionReason) throw new Error("关闭 Issue 必须提供处理原因。");
    if (issue.status === "duplicate" && (!issue.duplicateOf || !issue.resolutionReason)) throw new Error("重复 Issue 必须提供原议题和处理原因。");
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
    const list = (await (await this.context(workspaceId)).store.listRecords()).map(projectWorkItem);
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async search(input: SearchQuery): Promise<SearchResult> {
    return searchWorkbench({
      query: input,
      workspaces: await this.listWorkspaces(),
      listWorkItems: (workspaceId) => this.listWorkItems(workspaceId),
      listDocs: (workspaceId) => this.listDocs(workspaceId),
      readDoc: (workspaceId, path) => this.readDoc(workspaceId, path),
      sessionSearch: this.sessionSearch,
      rolloutsDir: this.rolloutsDir
    });
  }

  async askSource(workspaceId: string, workItemId: string, sessionId: string, question: string): Promise<SourceAskResult> {
    if (!question.trim()) throw new Error("asksource question is required.");
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status !== "running" || item.run.sessionId !== sessionId) {
      throw new Error("asksource 只允许当前 Worker 在执行中的工单调用：" + workItemId);
    }
    if (!item.sourceSessionId || !item.sourceTurnId) {
      throw new Error("工单没有有效的开单来源位置：" + workItemId);
    }
    if (!this.sourceAsker) {
      throw new Error("asksource requires a running desktop instance.");
    }
    return this.sourceAsker({
      workspaceId,
      workItemId,
      sourceSessionId: item.sourceSessionId,
      sourceTurnId: item.sourceTurnId,
      question: question.trim()
    });
  }

  async steerSession(sessionId: string, content: string): Promise<SessionSteerResult> {
    if (!content.trim()) throw new Error("steer content is required.");
    if (!this.sessionSteerer) {
      throw new Error("steer requires a running desktop instance.");
    }
    return this.sessionSteerer({ sessionId, content: content.trim() });
  }

  async startWork(workspaceId: string, input: { sessionId: string; turnId?: string; scope?: string; message?: WorkRequest["message"] }): Promise<WorkRequest> {
    if (!input.turnId && !this.sourceTurnResolver) throw new Error("需要有效 turnId；省略时必须连接桌面解析当前会话节点。");
    const turnId = input.turnId ?? await this.sourceTurnResolver?.(input.sessionId);
    if (!turnId && !input.message?.content.trim() && !input.message?.attachments?.length) throw new Error("空会话需要提供开工内容。");
    return this.putWorkRequest(workspaceId, { requestId: createId("work"), sourceSessionId: input.sessionId,
      sourceTurnId: turnId, message: input.message, scope: input.scope, status: "pending", createdAt: this.now(), updatedAt: this.now() });
  }

  async listWorkRequests(workspaceId: string): Promise<WorkRequest[]> {
    return (await this.context(workspaceId)).store.workRequests.list();
  }

  async putWorkRequest(workspaceId: string, request: WorkRequest): Promise<WorkRequest> {
    const store = (await this.context(workspaceId)).store;
    const current = await store.workRequests.get(request.requestId);
    if (current?.status === "cancelled" && request.status !== "cancelled") return current;
    const saved = await store.workRequests.put({ ...request, updatedAt: this.now() });
    this.emit({ type: "workRequests.changed", workspaceId });
    return saved;
  }

  async retryWork(workspaceId: string, requestId: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || request.status !== "failed") throw new Error("只有失败的开工请求可以重试。");
    if ((await this.listDecisions(workspaceId)).some((card) => card.requestId === requestId && !card.answer && !card.withdrawn)) throw new Error("开工请求正在等待用户答复，请通过 decision.answer 选择再试。");
    return this.putWorkRequest(workspaceId, { ...request, status: request.workerSessionId ? "preparing" : "pending", attempts: 0, retryAt: undefined });
  }

  async cancelWorkRequest(workspaceId: string, input: { requestId?: string; sessionId?: string }): Promise<{ cancelled: boolean; request?: WorkRequest }> {
    return this.integrate(workspaceId, async () => {
      const request = (await this.listWorkRequests(workspaceId)).find((entry) => input.requestId
        ? entry.requestId === input.requestId
        : entry.workerSessionId === input.sessionId);
      if (!request) return { cancelled: false };
      if (request.status === "cancelled") return { cancelled: true, request };
      if (request.status !== "pending" && request.status !== "preparing") return { cancelled: false, request };
      for (const item of await this.listWorkItems(workspaceId)) {
        if (item.requestId === request.requestId && !["closed", "cancelled"].includes(item.status))
          await this.cancelResult(workspaceId, item.workItemId, false);
      }
      const saved = await this.putWorkRequest(workspaceId, {
        ...request, status: "cancelled", failure: undefined, retryAt: undefined
      });
      this.emit({ type: "workRequest.cancelled", workspaceId, requestId: request.requestId, sessionId: request.workerSessionId });
      return { cancelled: true, request: saved };
    });
  }

  async failWorkRequest(workspaceId: string, requestId: string, failure: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("Unknown work request: " + requestId);
    if (request.status === "cancelled") return request;
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
    return this.integrate(workspaceId, () => this.finishPreparationRecord(workspaceId, sessionId, turnId));
  }

  private async finishPreparationRecord(workspaceId: string, sessionId: string, turnId?: string): Promise<void> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.workerSessionId === sessionId && entry.status === "preparing");
    if (!request) return;
    const forkTurnId = turnId ?? await this.sourceTurnResolver?.(sessionId);
    for (const item of await this.listWorkItems(workspaceId)) {
      if (item.status === "preparing" && item.requestId === request.requestId) {
        if (!item.run.sessionId && !forkTurnId) throw new Error("无法解析准备分支末端，不能 fork 其余工单。");
        await this.mutateRecord(workspaceId, item.workItemId, (record) => ({ ...record,
          item: { ...record.item, status: "queued", updatedAt: this.now() },
          execution: { ...record.execution, ...(!record.execution.sessionId ? { forkSessionId: sessionId, forkTurnId } : {}), updatedAt: this.now() } }));
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
    const record = await (await this.context(workspaceId)).store.getRecord(workItemId);
    if (!record) throw new Error("Unknown work item: " + workItemId);
    return projectWorkItem(record);
  }

  async listActions(workspaceId: string): Promise<WorkflowAction[]> {
    return (await (await this.context(workspaceId)).store.listRecords()).flatMap((record) => [record.execution, ...record.integrations]);
  }

  async createAction(workspaceId: string, input: Omit<Integration, "actionId" | "history" | "createdAt" | "updatedAt" | "attempts">, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<Integration> {
    const now = this.now();
    return this.transactRecord(workspaceId, input.workItemId, (current) => {
      if (!current) throw new Error("Unknown work item: " + input.workItemId);
      const active = current.integrations.find(actionIsOpen);
      if (active) {
        if (active.integration.operation !== input.integration.operation) throw new Error("Another integration is still active for " + input.workItemId);
        return { record: current, result: active };
      }
      const action: Integration = { ...input, actionId: createId("action"), attempts: 0, history: [{ at: now, event: "created", message: input.message }], createdAt: now, updatedAt: now };
      return { record: { ...current, item: mutateItem ? mutateItem(current.item) : current.item, integrations: [...current.integrations, action] }, result: action };
    });
  }

  async updateAction<T extends WorkflowAction>(workspaceId: string, action: T, mutate: (current: T) => T, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<T> {
    return this.transactRecord(workspaceId, action.workItemId, (current) => {
      if (!current) throw new Error("Unknown work item: " + action.workItemId);
      const saved = action.kind === "execute" ? current.execution : current.integrations.find((entry) => entry.actionId === action.actionId);
      if (!saved) throw new Error("Unknown process: " + action.actionId);
      const updated: WorkflowAction = { ...mutate(saved as T), updatedAt: this.now() };
      const record: WorkItemRecord = { ...current,
        item: mutateItem ? mutateItem(current.item) : current.item,
        ...(updated.kind === "execute" ? { execution: updated } : { integrations: current.integrations.map((entry) => entry.actionId === updated.actionId ? updated : entry) }) };
      return { record, result: updated as T };
    });
  }

  private async transactRecord<T>(workspaceId: string, workItemId: string, update: (current: WorkItemRecord | undefined) => { record: WorkItemRecord; result: T }, events: WorkbenchEvent[] = []): Promise<T> {
    const saved = await (await this.context(workspaceId)).store.transactRecord(workItemId, update);
    for (const event of events) this.emit(event);
    this.emit({ type: "workItems.changed", workspaceId });
    this.emit({ type: "actions.changed", workspaceId });
    return saved;
  }

  private async getAction(workspaceId: string, actionId: string): Promise<WorkflowAction> {
    const action = (await this.listActions(workspaceId)).find((entry) => entry.actionId === actionId);
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
      || (await this.listActions(workspaceId)).some((action) => actionIsOpen(action) && action.workItemId === workItemId && action.kind === "integration" && !action.agent)
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
    const failed = await this.updateAction(workspaceId, action, (action) => this.failedAction(action, failure),
      action.kind === "execute" ? (item) => ({ ...item, status: RETRY_MINUTES[action.attempts] === undefined ? "decision" : "queued" }) : undefined);
    await this.ensureFailureDecision(workspaceId, failed);
    return this.getAction(workspaceId, actionId);
  }

  private failedAction<T extends WorkflowAction>(action: T, failure: string): T {
    const attempts = action.attempts + 1;
    const delay = RETRY_MINUTES[attempts - 1];
    return { ...action, attempts, failure, status: delay === undefined ? "decision" : "retry",
      retryAt: delay === undefined ? undefined : new Date(Date.parse(this.now()) + delay * 60_000).toISOString(),
      history: [...action.history, { at: this.now(), event: "failed:" + action.stage, message: failure }] };
  }

  private async ensureFailureDecision(workspaceId: string, failed: WorkflowAction): Promise<void> {
    if (failed.kind === "integration" && failed.stage === "merge") return;
    const action = failed;
    const actionId = action.actionId;
    if (failed.status === "decision" && !(await this.listDecisions(workspaceId)).some((card) => card.actionId === actionId && !card.answer && !card.withdrawn)) {
      await this.createDecision(workspaceId, { actionId, kind: "attempts", workItemId: action.workItemId, sessionId: action.kind === "execute" ? action.sessionId : undefined,
        question: "自动恢复已用尽，要再试还是取消当前工作？", context: "工作台已尝试自动恢复四次，仍未完成当前处理。原会话与成果保留，选择再试后会从未完成的动作继续。",
        details: "阶段：" + action.stage + "\n受影响工单：" + action.workItemId + "\n" + failed.history.filter((h) => h.event.startsWith("failed:")).map((h) => h.at + " " + h.message).join("\n"),
        options: [{ key: "retry", label: "再试", detail: "清零此处理过程的失败计数，从未完成动作继续。" }, { key: "cancel", label: "取消当前工作", detail: "取消该过程关联的工单；已合入成果保持保留。" }], recommended: "retry", recommendation: "故障已排除时可沿原处理过程继续。" });
    }
  }

  /** Completion's ownership test and all execution changes share one record transaction. */
  async settleWorkerTurn(workspaceId: string, workItemId: string, input: {
    ownsExecution: () => boolean; turnId?: string; scheduled: boolean; finishReason: string; failure?: string; maxIdleTurns: number; completion: string;
  }): Promise<{ status: "done" | "failed"; note: string } | undefined> {
    const result = await this.transactRecord(workspaceId, workItemId, (record) => {
      if (!record) throw new Error("Unknown work item: " + workItemId);
      if (!input.ownsExecution()) return { record, result: undefined };
      const action = record.execution;
      let execution = action;
      let item = record.item;
      let note: string;
      let failure: string | undefined;
      if (!actionIsOpen(action) || action.status === "decision") note = action.status;
      else if (item.status === "queued" || action.stage === "deliver") {
        execution = { ...action, stage: "deliver", status: "pending",
          message: action.message };
        note = "待送达后续消息";
      } else if (item.status !== "running") {
        execution = { ...action, status: "done", retryAt: undefined,
          history: [...action.history, { at: this.now(), event: "resolved", message: "工单已进入 " + item.status }] };
        note = "已交接";
      } else if (!input.scheduled) return { record, result: undefined };
      else if (input.finishReason !== "completed" || action.idleTurns >= input.maxIdleTurns) {
        failure = input.finishReason !== "completed" ? "turn " + input.finishReason + (input.failure ? ": " + input.failure : "")
          : "连续未落实处置：" + input.completion;
        execution = this.failedAction(action, failure);
        item = { ...item, status: execution.status === "decision" ? "decision" : "queued" };
        note = failure;
      } else {
        execution = { ...action, heartbeatAt: this.now(), idleTurns: action.idleTurns + 1, stage: "deliver", status: "pending",
          message: action.message + "\n尚未落实处置。请执行：" + input.completion };
        note = "要求落实具体动作";
      }
      return { record: { ...record, item: { ...item, updatedAt: this.now() }, execution: { ...execution, updatedAt: this.now() } },
        result: { status: failure ? "failed" as const : "done" as const, note, failed: failure ? execution : undefined } };
    });
    if (result?.failed) await this.ensureFailureDecision(workspaceId, result.failed);
    return result;
  }

  /** Dependencies and agent actions share one durable queue; facts, not delivery receipts, release waiting work. */
  async createWorkItem(
    workspaceId: string,
    input: Pick<WorkItem, "title" | "objective" | "risk" | "scope" | "acceptance"> & { sessionId?: string; sourceSessionId?: string; sourceTurnId?: string; treeId?: string; requestId?: string; issueId?: string; worktreePath?: string; branch?: string; refs?: WorkItem["refs"]; needs?: string[]; dependsOn?: string[] }
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const explicitIssue = input.issueId ? await this.getIssue(workspaceId, input.issueId) : undefined;
      const request = input.requestId ? await (await this.context(workspaceId)).store.workRequests.get(input.requestId) : undefined;
      const sourceSessionId = request?.sourceSessionId ?? input.sourceSessionId;
      const linkedIssue = explicitIssue ?? (await this.listIssues(workspaceId)).find((issue) => issue.discussionSessionId === sourceSessionId);
      if (linkedIssue && ["closed", "duplicate"].includes(linkedIssue.status)) throw new Error("已关闭或重复的 Issue 不能创建关联工单。");
      const item = await this.createWorkItemRecord(workspaceId, { ...input, issueId: linkedIssue?.issueId });
      if (!linkedIssue) return item;
      const now = this.now();
      await (await this.context(workspaceId)).store.transactIssue(linkedIssue.issueId, (current) => {
        if (!current) throw new Error("Unknown issue: " + linkedIssue.issueId);
        const issue: Issue = { ...current, status: "started", unread: true,
          workItemIds: [...new Set([...current.workItemIds, item.workItemId])],
          activities: [...current.activities, { at: now, kind: "workItem", message: "关联工单", workItemId: item.workItemId }], updatedAt: now };
        return { record: issue, result: issue };
      });
      this.emit({ type: "issues.changed", workspaceId });
      return item;
    });
  }

  private async createWorkItemRecord(workspaceId: string, input: Parameters<WorkbenchService["createWorkItem"]>[1]): Promise<WorkItem> {
    const now = this.now();
    const { store } = await this.context(workspaceId);
    if (!!input.worktreePath !== !!input.branch) throw new Error("worktreePath 与 branch 必须同时提供。");
    if (input.needs?.some((need) => ["browser", "desktop"].includes(need.trim()))) throw new Error("needs 必须指明具体共享实例，例如 browser:qa-profile。");
    const request = input.requestId ? await store.workRequests.get(input.requestId) : undefined;
    if (input.requestId && (!request || request.status !== "preparing" || (input.sessionId && request.workerSessionId !== input.sessionId))) throw new Error("requestId 必须属于当前准备分支。");
    if (input.sessionId && (await this.listWorkItems(workspaceId)).some((item) => item.run.sessionId === input.sessionId && !["closed", "cancelled"].includes(item.status))) throw new Error("同一执行分支只能绑定一张未结束工单。其他工单请 fork 兄弟分支。");
    await this.checkDependencies(workspaceId, "(new)", input.dependsOn ?? []);
    const item: WorkItemRecord["item"] = {
      workItemId: createId("wi"),
      issueId: input.issueId,
      sourceSessionId: request?.sourceSessionId ?? input.sourceSessionId, sourceTurnId: request?.sourceTurnId ?? input.sourceTurnId, treeId: request?.treeId ?? input.treeId, requestId: input.requestId,
      contractRevision: 0,
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
    };
    return this.transactRecord(workspaceId, item.workItemId, (current) => {
      if (current) throw new Error("Work item already exists: " + item.workItemId);
      const record: WorkItemRecord = { workItemId: item.workItemId, item, integrations: [], cleanup: [], execution: {
        sessionId: input.sessionId, worktreePath: input.worktreePath, branch: input.branch,
        kind: "execute", actionId: "execution-" + item.workItemId, workItemId: item.workItemId,
        status: "pending", stage: "open", message: "", attempts: 0, idleTurns: 0, history: [], createdAt: now, updatedAt: now
      } };
      return { record, result: projectWorkItem(record) };
    });
  }

  private async mutateRecord(workspaceId: string, workItemId: string, mutate: (record: WorkItemRecord) => WorkItemRecord, events: WorkbenchEvent[] = []): Promise<WorkItem> {
    return this.transactRecord(workspaceId, workItemId, (current) => {
      if (!current) throw new Error("Unknown work item: " + workItemId);
      const record = mutate(current);
      return { record, result: projectWorkItem(record) };
    }, events);
  }

  /** Worker claimed the item; records the session and worktree it runs in. */
  /** A (re)start begins a new turn: the pending message is claimed and any stale-turn mark from the previous run is over. */
  async startWorkItem(workspaceId: string, workItemId: string, run: Pick<Execution, "sessionId" | "heartbeatAt">): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.startWorkItemRecord(workspaceId, workItemId, run));
  }

  private async startWorkItemRecord(workspaceId: string, workItemId: string, run: Pick<Execution, "sessionId" | "heartbeatAt">): Promise<WorkItem> {
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (current.status !== "queued" && !(current.status === "running" && current.run.sessionId === run.sessionId)) throw new Error("只有可执行的排队工单可以启动，已结束或等待合入的工单不能重新认领。");
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("工单仍有未解决的等待条件，请读取 action.list。");
    const occupied = (await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running");
    const scheduler = await this.getScheduler(workspaceId);
    if (occupied.length >= scheduler.maxWorkers || occupied.some((item) => effectiveNeeds(item).some((need) => effectiveNeeds(current).includes(need)))) throw new Error("并发或共享资源尚未释放，保持排队。");
    const baseCommit = current.run.baseCommit ?? await (await this.context(workspaceId)).docs.head().catch(() => undefined);
    return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
      item: { ...record.item, status: "running", updatedAt: this.now() },
      execution: { ...record.execution, sessionId: run.sessionId ?? record.execution.sessionId, heartbeatAt: run.heartbeatAt ?? record.execution.heartbeatAt,
        baseCommit, retryAt: undefined, updatedAt: this.now() }
    }));
  }

  async heartbeatWorkItem(workspaceId: string, workItemId: string, lastTurnId?: string): Promise<WorkItem> {
    return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
      item: { ...record.item, updatedAt: this.now() },
      execution: { ...record.execution, lastTurnId: lastTurnId ?? record.execution.lastTurnId, heartbeatAt: this.now(), updatedAt: this.now() } }));
  }

  /** Verified work merges immediately; unsuccessful submissions return to the same worker. */
  async submitWorkItem(
    workspaceId: string,
    workItemId: string,
    input: { contractRevision: number; evidence: Omit<NonNullable<WorkItem["evidence"]>, "submittedAt">; review: WorkItem["review"]; verify: VerifySubmission }
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.submitResult(workspaceId, workItemId, input));
  }

  private async submitResult(workspaceId: string, workItemId: string, input: Parameters<WorkbenchService["submitWorkItem"]>[2]): Promise<WorkItem> {
    if ((await this.listActions(workspaceId)).some((action) => action.kind === "execute" && action.workItemId === workItemId && action.integrationActionId))
      throw new Error("接管合入请调用 workItem.integration.complete，不重复提交开发成果。");
    const now = this.now();
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("仍有未解决的等待条件，不能提交。");
    type PreparedSubmission = { stale: true; item: WorkItem } | { stale: false; item: WorkItem };
    const prepared = await this.transactRecord<PreparedSubmission>(workspaceId, workItemId, (record) => {
      if (!record) throw new Error("Unknown work item: " + workItemId);
      if (record.item.status !== "running") throw new Error("Work item is not running: " + workItemId);
      if (input.contractRevision !== record.item.contractRevision) {
        const reason = "提交依据已过期：当前合同修订为 " + record.item.contractRevision + "，收到的是 " + input.contractRevision + "。请重新读取工单并仅更新受影响的结果。";
        const updatedAt = this.now();
        const updated = { ...record,
          item: { ...record.item, status: "queued" as const, rejections: [...record.item.rejections, { reason, at: updatedAt }], updatedAt },
          execution: { ...record.execution, idleTurns: 0, message: [record.execution.message, reason].filter(Boolean).join("\n"), updatedAt }
        };
        return { record: updated, result: { stale: true as const, item: projectWorkItem(updated) } };
      }
      const previousVerify = record.item.verify;
      const verifyByIndex = new Map((previousVerify?.items ?? []).map((entry) => [entry.index, entry]));
      for (const entry of input.verify.items) verifyByIndex.set(entry.index, entry);
      const mergedItems = [...verifyByIndex.values()].sort((left, right) => left.index - right.index);
      const complete = record.item.acceptance.every((_, index) => verifyByIndex.has(index));
      const mergedPass = input.verify.verdict === "pass" && complete &&
        mergedItems.length === record.item.acceptance.length && mergedItems.every((entry) => entry.status === "pass");
      const mergeUnique = <T>(before: T[], after: T[]): T[] => [...before, ...after].filter((entry, index, all) =>
        all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index);
      const previousEvidence = record.item.evidence;
      const evidence = {
        summary: input.evidence.summary || previousEvidence?.summary || "",
        ...(input.evidence.commit || previousEvidence?.commit ? { commit: input.evidence.commit ?? previousEvidence?.commit } : {}),
        commands: mergeUnique(previousEvidence?.commands ?? [], input.evidence.commands),
        assumptions: mergeUnique(previousEvidence?.assumptions ?? [], input.evidence.assumptions),
        untested: mergeUnique(previousEvidence?.untested ?? [], input.evidence.untested),
        outOfScopeFindings: mergeUnique(previousEvidence?.outOfScopeFindings ?? [], input.evidence.outOfScopeFindings),
        attachments: mergeUnique(previousEvidence?.attachments ?? [], input.evidence.attachments),
        submittedAt: now
      };
      const verify = { items: mergedItems, verdict: mergedPass ? "pass" as const : "rework" as const, verifiedAt: now };
      const updated = { ...record, item: {
        ...record.item,
        updatedAt: now,
        evidence,
        review: mergeUnique(record.item.review, input.review),
        verify
      } };
      return { record: updated, result: { stale: false as const, item: projectWorkItem(updated) } };
    });
    if (prepared.stale) return prepared.item;
    const submitted = prepared.item;
    const failed = submitted.verify?.items.filter((entry) => entry.status !== "pass") ?? [];
    const missing = submitted.acceptance.some((_, index) => !submitted.verify?.items.some((entry) => entry.index === index));
    if (submitted.verify?.verdict !== "pass" || failed.length || missing) {
      const statusText = failed.map((entry) => ({ defect: "发现缺陷", blocked: "条件不足", incomplete: "尚未完成", pass: "通过" }[entry.status] + "：" + entry.evidence)).join("\n");
      const reason = "验收未通过：" + (statusText || (missing ? "验收报告未覆盖全部条目" : "验收报告要求返工"));
      return this.returnWorkItem(workspaceId, workItemId, reason);
    }
    await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "merge", message: "验收通过，等待合入。", integration: { operation: "merge", contractRevision: submitted.contractRevision, diffStat: "" } },
      (item) => ({ ...item, status: "merging", updatedAt: this.now() }));
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  /** Accepts the work: merges the worker's branch into the workspace (when it ran in a worktree) and closes the item. */
  async continueIntegrations(workspaceId: string): Promise<void> {
    await this.integrate(workspaceId, () => this.drainIntegrations(workspaceId));
  }

  async retryIntegration(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const action = (await this.listActions(workspaceId)).find((entry): entry is Integration =>
        entry.kind === "integration" && entry.workItemId === workItemId && entry.stage === "merge" && actionIsOpen(entry));
      if (!action || action.agent || !["retry", "decision"].includes(action.status)) throw new Error("当前合入没有可立即重试的失败动作：" + workItemId);
      const retried = await this.updateAction(workspaceId, action, (current) => ({ ...current,
        status: "pending", attempts: 0, retryAt: undefined, failure: undefined,
        history: [...current.history, { at: this.now(), event: "retry:merge", message: "用户立即重试合入" }] }));
      await this.drainIntegrations(workspaceId);
      return this.getWorkItem(workspaceId, retried.workItemId);
    });
  }

  async takeoverIntegration(workspaceId: string, workItemId: string, note?: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const item = await this.getWorkItem(workspaceId, workItemId);
      const action = (await this.listActions(workspaceId)).find((entry): entry is Integration =>
        entry.kind === "integration" && entry.workItemId === workItemId && entry.stage === "merge" && actionIsOpen(entry));
      if (!action) throw new Error("当前工单没有可接管的合入动作：" + workItemId);
      if (action.agent) return item;
      if (!item.run.sessionId) throw new Error("当前工单没有可接管的 Worker 会话：" + workItemId);
      if (!["retry", "decision"].includes(action.status)) throw new Error("合入尚未失败，暂不能交给 Agent：" + workItemId);
      const now = this.now();
      const message = ["接管合入本单。", "workspaceId: " + workspaceId, "workItemId: " + workItemId,
        "integrationActionId: " + action.actionId, "sessionId: " + item.run.sessionId,
        "工作目录: " + (item.run.worktreePath ?? await this.workspaceRoot(workspaceId)),
        "当前成果: " + (item.evidence?.commit ?? "未登记 commit"), "已失败次数: " + action.attempts,
        action.failure ? "最近合入失败：" + action.failure : "", note?.trim() ? "用户说明：" + note.trim() : "",
        "保留已通过且未受影响的开发与验收。读取 workItem.get 和 action.list，在原 worktree 处理冲突和 rebase，最终合入交给工作台串行入口，不自行写主分支。"
      ].filter(Boolean).join("\n");
      return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
        item: { ...record.item, status: "queued", updatedAt: now },
        execution: { ...record.execution, integrationActionId: action.actionId, status: "pending", stage: "deliver",
          runId: undefined, scheduledTurnId: undefined, deliveredAt: undefined, pauseReason: undefined,
          attempts: 0, idleTurns: 0, retryAt: undefined, failure: undefined, message, updatedAt: now },
        integrations: record.integrations.map((entry) => entry.actionId === action.actionId ? { ...entry,
          status: "pending", retryAt: undefined,
          agent: { sessionId: item.run.sessionId!, ...(note?.trim() ? { note: note.trim() } : {}), requestedAt: now },
          history: [...entry.history, { at: now, event: "takeover:merge", message: "用户交给原 Worker 处理合入" }], updatedAt: now
        } : entry)
      }));
    });
  }

  async completeIntegration(workspaceId: string, workItemId: string, actionId: string, sessionId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const item = await this.getWorkItem(workspaceId, workItemId);
      let action = await this.getAction(workspaceId, actionId);
      if (action.kind !== "integration" || action.workItemId !== workItemId || action.stage !== "merge" || !action.agent || action.agent.sessionId !== sessionId || !actionIsOpen(action))
        throw new Error("当前合入动作不属于该 Agent：" + actionId);
      if (item.run.pauseReason === "user") throw new Error("用户已暂停合入，请先恢复工单：" + workItemId);
      if (item.status !== "running" || await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("当前 Worker 尚未取得执行资格：" + workItemId);
      const { docs } = await this.context(workspaceId);
      const recoveredMerge = action.integration.before && action.integration.target
        ? await docs.getMergeCommit(action.integration.target, action.integration.before) : undefined;
      if (!recoveredMerge && item.run.branch) {
        const snapshot = await docs.integrationSnapshot(item.run.branch);
        action = await this.updateAction(workspaceId, action, (current) => ({ ...current,
          integration: { ...current.integration, before: snapshot.head, target: snapshot.target, diffStat: snapshot.diffStat } }));
      }
      await this.updateAction(workspaceId, action, (current) => ({ ...current,
        status: "pending", retryAt: undefined, failure: undefined,
        history: [...current.history, { at: this.now(), event: "agent:merge", message: "Agent 请求执行最终合入" }] }));
      await this.drainIntegrations(workspaceId, actionId);
      const latest = await this.getAction(workspaceId, actionId);
      if (latest.status !== "done") throw new Error(latest.failure ?? "Agent 合入未完成，请读取 action.list 后继续处理。");
      return this.getWorkItem(workspaceId, workItemId);
    });
  }

  private async drainIntegrations(workspaceId: string, requestedActionId?: string): Promise<void> {
    const actions = await this.listActions(workspaceId);
    const { docs } = await this.context(workspaceId);
    const pending = actions.filter((a): a is Integration => a.kind === "integration" && actionIsOpen(a) && a.status !== "decision" &&
      (requestedActionId ? a.actionId === requestedActionId && !!a.agent : !a.agent && (!a.retryAt || a.retryAt <= this.now())));
    for (let action of pending) {
      const workItemId = action.workItemId;
      let item = await this.getWorkItem(workspaceId, workItemId);
      try {
        action = await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "running", retryAt: undefined, failure: undefined,
          history: [...current.history, { at: this.now(), event: "started:" + current.stage, message: (current.agent ? "Agent" : "工作台") + " 开始合入" }] }));
        let integration = action.integration!;
        if (action.stage === "merge" && integration.contractRevision !== item.contractRevision) {
          const reason = "合入作废：合同已更新为修订 " + item.contractRevision + "，成果依据为 " + integration.contractRevision + "。请按当前合同复核后重新提交。";
          await this.finishAction(workspaceId, action.actionId, reason);
          await this.returnWorkItem(workspaceId, workItemId, reason);
          continue;
        }
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
        }
        if (action.stage === "rollback") {
          if (!integration.before) {
            integration = { ...integration, before: await docs.head() };
            action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration }));
          }
          let commit: string | undefined;
          for (const target of [...(integration.targets ?? [integration.target!])].reverse()) commit = await docs.rollbackMerge(target, integration.before);
          integration = { ...integration, commit };
        }
        const now = this.now();
        await this.mutateRecord(workspaceId, workItemId, (record) => {
          const rollback = integration.operation === "rollback";
          const detached = rollback ? record : this.detachWorktree(record, false);
          return { ...detached,
            cleanup: rollback ? detached.cleanup.map((candidate) => ({ ...candidate, detachedAt: undefined })) : detached.cleanup,
            item: { ...record.item, status: rollback ? "queued" : "closed", updatedAt: now,
              merge: rollback ? { ...record.item.merge!, rollbackCommit: integration.commit, acknowledgedAt: now }
                : { commit: integration.commit, commits: integration.commits, diffStat: integration.diffStat, mergedAt: now } },
            execution: { ...detached.execution, integrationActionId: undefined, status: rollback ? "pending" : "done", stage: rollback ? "deliver" : detached.execution.stage,
              updatedAt: now, baseCommit: rollback ? integration.commit : detached.execution.baseCommit,
              message: rollback ? "用户回滚：" + integration.reason + "。重新判断隔离目录，需要时创建新 worktree 并通过 workItem.update 登记。" : detached.execution.message },
            integrations: record.integrations.map((entry) => entry.actionId === action.actionId
              ? { ...entry, integration, status: "done", updatedAt: now } : entry)
          };
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (action.agent) {
          await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "running", retryAt: undefined, failure: reason,
            history: [...current.history, { at: this.now(), event: "failed:merge:agent", message: reason }] }));
        } else if (error instanceof WorktreeMergeConflict || error instanceof WorktreeNotReady) {
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
    return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
      item: { ...record.item, status: "queued", rejections: [...record.item.rejections, { reason, at: this.now() }], updatedAt: this.now() },
      execution: { ...record.execution, integrationActionId: undefined, idleTurns: 0, message: [record.execution.message, reason].filter(Boolean).join("\n"), updatedAt: this.now() }
    }));
  }

  async acknowledgeWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.mutateRecord(workspaceId, workItemId, (record) => {
      const { item } = record;
      if (item.status !== "closed" || !item.merge) throw new Error("Work item has no merged notification");
      return { ...record, item: { ...item, merge: { ...item.merge, acknowledgedAt: this.now() }, updatedAt: this.now() } };
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
      await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "rollback", message: "用户回滚：" + reason.trim(), integration: { operation: "rollback", contractRevision: item.contractRevision, target: item.merge.commit, targets: item.merge.commits, diffStat: "", reason: reason.trim() } });
    }
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  async cancelWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.cancelResult(workspaceId, workItemId));
  }

  private async cancelResult(workspaceId: string, workItemId: string, notify = true): Promise<WorkItem> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status === "cancelled") return item;
    if (item.status === "closed") throw new Error("已合入工单请使用回滚入口，不能取消已完成成果。");
    const dependants = (await this.listWorkItems(workspaceId)).filter((w) => !["closed", "cancelled"].includes(w.status) && w.dependsOn.includes(workItemId)).map((w) => w.workItemId);
    const cancelled = await this.mutateRecord(workspaceId, workItemId, (record) => {
      const detached = this.detachWorktree(record, true);
      return { ...detached, item: { ...record.item, status: "cancelled", updatedAt: this.now() },
        execution: { ...detached.execution, status: "cancelled", updatedAt: this.now() },
        integrations: record.integrations.map((action) => actionIsOpen(action) ? { ...action, status: "cancelled", updatedAt: this.now() } : action) };
    }, notify ? [{ type: "workItem.cancelled", workspaceId, workItemId, sessionId: item.run.sessionId, dependants }] : []);
    return cancelled;
  }

  async pauseWorkItem(workspaceId: string, sessionId: string): Promise<{ paused: boolean; workItem?: WorkItem }> {
    return this.integrate(workspaceId, async () => {
      const item = (await this.listWorkItems(workspaceId)).find((entry) => entry.run.sessionId === sessionId && entry.status === "running");
      if (!item) return { paused: false };
      const paused = await this.mutateRecord(workspaceId, item.workItemId, (record) => {
        const now = this.now();
        return { ...record,
          item: { ...record.item, status: "decision", updatedAt: now },
          execution: { ...record.execution, status: "decision", pauseReason: "user", retryAt: undefined, failure: undefined,
            history: [...record.execution.history, { at: now, event: "paused:user", message: "用户已暂停 Worker" }], updatedAt: now } };

      });
      return { paused: true, workItem: paused };
    });
  }

  async resumeWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const current = await this.getWorkItem(workspaceId, workItemId);
      if (current.status !== "decision" || current.run.pauseReason !== "user") throw new Error("工单不是用户暂停状态：" + workItemId);
      return this.mutateRecord(workspaceId, workItemId, (record) => {
        const now = this.now();
        const sessionId = record.execution.sessionId;
        return { ...record,
          item: { ...record.item, status: "queued", updatedAt: now },
          execution: { ...record.execution, status: "pending", stage: sessionId ? "deliver" : "open", pauseReason: undefined,
            retryAt: undefined, failure: undefined, idleTurns: 0,
            message: [record.execution.message, "用户已恢复执行。"].filter(Boolean).join("\n"),
            history: [...record.execution.history, { at: now, event: "resumed:user", message: "用户已恢复 Worker" }], updatedAt: now } };
      });
    });
  }

  private detachWorktree(record: WorkItemRecord, discard: boolean): WorkItemRecord {
    const { sessionId, worktreePath, branch } = record.execution;
    return { ...record,
      cleanup: worktreePath && branch ? [...record.cleanup, { sessionId, worktreePath, branch, discard }] : record.cleanup,
      execution: { ...record.execution, worktreePath: undefined, branch: undefined }
    };
  }

  async listWorktreeCleanup(workspaceId: string) {
    return (await (await this.context(workspaceId)).store.listRecords())
      .flatMap((record) => record.cleanup.map((candidate) => ({ workItemId: record.workItemId, ...candidate })));
  }

  /** A user can resume a completed worker directly, without reopening its work item. */
  async workerTurnCompleted(workspaceId: string, sessionId: string): Promise<void> {
    await this.integrate(workspaceId, async () => {
      this.releasedWorkers.delete(sessionId);
      const { store } = await this.context(workspaceId);
      for (const record of await store.listRecords()) {
        if (!record.cleanup.some((candidate) => candidate.sessionId === sessionId && candidate.detachedAt)) continue;
        await this.mutateRecord(workspaceId, record.workItemId, (current) => ({ ...current,
          cleanup: current.cleanup.map((candidate) => candidate.sessionId === sessionId ? { ...candidate, detachedAt: undefined } : candidate) }));
      }
    });
  }

  /** Requests unsubscribe only for idle terminal workers; never waits for native thread shutdown. */
  async releaseIdleWorkers(workspaceId: string): Promise<void> {
    await this.integrate(workspaceId, async () => {
      const items = await this.listWorkItems(workspaceId);
      const candidates = await this.listWorktreeCleanup(workspaceId);
      const owners = new Set(items.filter((item) => !["closed", "cancelled"].includes(item.status)).map((item) => item.run.sessionId));
      for (const sessionId of owners) if (sessionId) this.releasedWorkers.delete(sessionId);
      for (const item of items) {
        const sessionId = item.run.sessionId;
        if (!sessionId || owners.has(sessionId) || this.workerActive?.(sessionId) || this.releasedWorkers.has(sessionId) || !this.releaseWorkerEnvironment) continue;
        const owned = candidates.filter((candidate) => candidate.sessionId === sessionId);
        if (owned.length && owned.every((candidate) => candidate.detachedAt)) continue;
        this.releasedWorkers.add(sessionId);
        try {
          void this.releaseWorkerEnvironment(sessionId).then(async () => {
            for (const candidate of owned) await this.mutateRecord(workspaceId, candidate.workItemId, (record) => ({ ...record,
              cleanup: record.cleanup.map((entry) => ["closed", "cancelled"].includes(record.item.status) && entry.sessionId === sessionId && entry.worktreePath === candidate.worktreePath && entry.branch === candidate.branch
                ? { ...entry, detachedAt: this.now() } : entry) }));
          }).catch(() => this.releasedWorkers.delete(sessionId));
        } catch { this.releasedWorkers.delete(sessionId); }
      }
    });
  }

  /** Only persisted, detached ownership can authorize deletion. Busy paths remain for the next sweep. */
  async cleanupWorktrees(workspaceId: string) {
    return this.integrate(workspaceId, async () => {
      const { docs } = await this.context(workspaceId);
      const removed: string[] = [];
      const retained: Array<{ workItemId: string; worktreePath: string; reason: string }> = [];
      for (const candidate of await this.listWorktreeCleanup(workspaceId)) {
        const items = await this.listWorkItems(workspaceId);
        const reused = items.some((item) => !["closed", "cancelled"].includes(item.status) &&
          ((candidate.sessionId && item.run.sessionId === candidate.sessionId) || item.run.branch === candidate.branch ||
            (item.run.worktreePath && this.sameWorktreePath(item.run.worktreePath, candidate.worktreePath))));
        let reason = reused ? "owned" :
          candidate.sessionId && this.workerActive?.(candidate.sessionId) ? "active" :
          candidate.sessionId && !candidate.detachedAt ? "subscribed" : undefined;
        if (!reason) {
          try {
            await docs.dropWorktree(candidate.worktreePath, candidate.branch, candidate.discard);
            await this.mutateRecord(workspaceId, candidate.workItemId, (record) => ({ ...record,
              cleanup: record.cleanup.filter((entry) => entry.worktreePath !== candidate.worktreePath || entry.branch !== candidate.branch) }));
            removed.push(candidate.worktreePath);
          } catch (error) { reason = error instanceof Error ? error.message : String(error); }
        }
        if (reason) retained.push({ workItemId: candidate.workItemId, worktreePath: candidate.worktreePath, reason });
      }
      return { removed, retained };
    });
  }

  private sameWorktreePath(left: string, right: string): boolean {
    const normalize = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    return normalize(left) === normalize(right);
  }

  async updateWorkItem(
    workspaceId: string,
    workItemId: string,
    input: Partial<Pick<WorkItem, "title" | "objective" | "refs" | "scope" | "acceptance" | "risk" | "needs" | "dependsOn">> & { note: string; worktreePath?: string; branch?: string }
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.updateWorkItemRecord(workspaceId, workItemId, input));
  }

  private async updateWorkItemRecord(workspaceId: string, workItemId: string, input: Parameters<WorkbenchService["updateWorkItem"]>[2]): Promise<WorkItem> {
    const { note, worktreePath, branch, ...changes } = input;
    if (!!worktreePath !== !!branch) throw new Error("worktreePath 与 branch 必须同时提供。");
    if (changes.needs?.some((need) => ["browser", "desktop"].includes(need.trim()))) throw new Error("needs 必须指明具体共享实例。");
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (changes.dependsOn) await this.checkDependencies(workspaceId, workItemId, changes.dependsOn);
    const occupied = changes.needs?.length
      ? new Set((await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running").flatMap((item) => item.needs))
      : new Set<string>();
    const updated = await this.mutateRecord(workspaceId, workItemId, (record) => {
      const { execution, item } = record;
      if (item.status === "closed" || item.status === "cancelled") throw new Error("Work item is " + item.status + ": " + workItemId);
      const conflict = item.status === "running" ? changes.needs?.find((need) => occupied.has(need)) : undefined;
      if (conflict !== undefined) throw new Error("Resource is in use: " + conflict + ". Release it before updating this running work item.");
      const status = item.status;
      const contractChanged = Object.keys(changes).length > 0;
      const acceptanceChanged = changes.acceptance && JSON.stringify(changes.acceptance) !== JSON.stringify(item.acceptance);
      let verify = item.verify;
      let history = execution.history;
      if (acceptanceChanged && verify) {
        // An index locates a result only within its original acceptance list.
        const key = (entry: WorkItem["acceptance"][number]) => JSON.stringify([entry.text, entry.source ?? null]);
        const previousKeys = item.acceptance.map(key);
        const nextKeys = changes.acceptance!.map(key);
        const previousResults = new Map(verify.items.map((entry) => [entry.index, entry]));
        const items = nextKeys.map((value, index) => {
          const previousIndex = previousKeys.indexOf(value);
          const unambiguous = previousIndex >= 0 && previousKeys.lastIndexOf(value) === previousIndex &&
            nextKeys.indexOf(value) === nextKeys.lastIndexOf(value);
          const previous = unambiguous ? previousResults.get(previousIndex) : undefined;
          return previous ? { ...previous, index } : { index, status: "incomplete" as const, evidence: "当前验收条目尚未验证。" };
        });
        history = [...history, { at: this.now(), event: "acceptance.updated",
          message: "合同修订 " + item.contractRevision + " 的验收记录：\n" + JSON.stringify({ acceptance: item.acceptance, verify }) }];
        verify = { ...verify, items, verdict: verify.verdict === "pass" && items.every((entry) => entry.status === "pass") ? "pass" : "rework" };
      }
      // While parked the note lives on the decision card and reaches the worker inside the answer line.
      const decisions = status === "decision" ? item.decisions : [...item.decisions, "工单调整：" + note];
      return {
        ...record,
        item: { ...item, ...changes, verify, ...(contractChanged ? { contractRevision: item.contractRevision + 1 } : {}), status, decisions, updatedAt: this.now() },
        execution: { ...execution, history, ...(worktreePath ? { worktreePath, branch } : {}),
          message: status === "decision" ? execution.message : [execution.message, "工单已调整：" + note].filter(Boolean).join("\n"), updatedAt: this.now() }

      };
    });
    if (changes.dependsOn?.some((id) => !current.dependsOn.includes(id)) && updated.status === "running") {
      await this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
        item: { ...record.item, status: "queued", updatedAt: this.now() },
        execution: { ...record.execution, message: "依赖调整已落实。前置关闭后读取最新合同，rebase 后继续。", updatedAt: this.now() } }));
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
    if (card.kind === "attempts" && (!answer.key || answer.note?.trim())) throw new Error("运行故障请选择重试或取消，不接受备注答复。");
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
    if (card.requestId && card.kind !== "worker" && !card.workItemId && !card.actionId) {
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
      decisions: item.decisions.includes(message) ? item.decisions : [...item.decisions, message] });
    if (!action || !actionIsOpen(action)) {
      if (card.workItemId) await this.mutateRecord(workspaceId, card.workItemId, (record) => ({ ...record, item: { ...recordAnswer(record.item), updatedAt: this.now() } }));
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

  async listInbox(includeProcessed = false): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const workspace of await this.listWorkspaces()) {
      const { store } = await this.context(workspace.workspaceId);
      for (const card of await store.decisions.list()) {
        if (card.answer ? includeProcessed : !card.withdrawn) items.push({ kind: "decision", workspaceId: workspace.workspaceId, card });
      }
      const actions = await this.listActions(workspace.workspaceId);
      for (const workItem of await this.listWorkItems(workspace.workspaceId)) {
        const integration = actions.find((action): action is Integration => action.kind === "integration" && action.workItemId === workItem.workItemId &&
          action.stage === "merge" && actionIsOpen(action) &&
          ((!action.agent && ["retry", "decision"].includes(action.status)) || (!!action.agent && !!workItem.run.retryAt)));
        if (integration) items.push({ kind: "integration", workspaceId: workspace.workspaceId, workItem, action: integration });
        if (!workItem.merge || (workItem.merge.acknowledgedAt ? !includeProcessed : workItem.status !== "closed")) continue;
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

const watchedAreas: Record<string, Exclude<Extract<WorkbenchEvent, { workspaceId: string }>, { sessionId: string } | { workItemId: string } | { requestId: string }>["type"] | undefined> = {
  docs: "docs.changed",
  roles: "roles.changed",
  "work-requests": "workRequests.changed",
  workitems: "workItems.changed",
  decisions: "decisions.changed",
  runs: "runs.changed",
  actions: "actions.changed",
  "scheduler.json": "scheduler.changed"
};
