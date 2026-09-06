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
  Risk,
  RoleFile,
  WorkItem,
  WorkbenchEvent,
  Workspace
} from "./contracts.js";
import { DocsService, WorktreeMergeConflict } from "./docs.js";
import { RoleService } from "./roles.js";
import type { AppLauncher, AppStartInput, AppStartResult } from "./app-launcher.js";
import { WorkspaceStore } from "./workspace-store.js";

/** Failures before an item stops being re-queued and asks the user instead. */
const MAX_ATTEMPTS = 3;

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
  /** Starts isolated app instances for acceptance; absent when running without a desktop build around. */
  launcher?: AppLauncher;
  now?: () => string;
};

type WorkspaceContext = { rootPath: string; store: WorkspaceStore; docs: DocsService; watcher?: FSWatcher };

export class WorkbenchService {
  private readonly workspaces: WorkspaceSource;
  private readonly roles: RoleService;
  private readonly ask?: SessionAsk;
  private readonly launcher?: AppLauncher;
  private readonly now: () => string;
  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();

  constructor(options: WorkbenchServiceOptions) {
    this.workspaces = options.workspaces;
    this.roles = options.roles;
    this.ask = options.ask;
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

  dispose(): void {
    for (const context of this.contexts.values()) context.watcher?.close();
    this.contexts.clear();
  }

  // ---- workspaces ----

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
    if (mission.status === "cancelled") throw new Error("Mission is cancelled: " + input.missionId);
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
    const updated = await store.missions.put({ ...mission, status, updatedAt: this.now() });
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

  async createWorkItem(
    workspaceId: string,
    input: Pick<WorkItem, "title" | "objective" | "risk" | "scope" | "acceptance"> & { missionId?: string; refs?: WorkItem["refs"]; needs?: string[]; dependsOn?: string[]; autoClose?: boolean }
  ): Promise<WorkItem> {
    const now = this.now();
    const { store } = await this.context(workspaceId);
    if (input.missionId && !(await store.missions.get(input.missionId))) throw new Error("Unknown mission: " + input.missionId);
    for (const id of input.dependsOn ?? []) {
      const dep = await store.workItems.get(id);
      if (!dep || dep.missionId !== input.missionId) throw new Error("dependsOn must reference a work item in the same mission: " + id);
    }
    const item = await store.workItems.put({
      workItemId: createId("wi"),
      missionId: input.missionId,
      title: input.title.trim(),
      objective: input.objective,
      status: "queued",
      risk: input.risk,
      autoClose: input.autoClose ?? isLowRisk(input.risk),
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
  async startWorkItem(workspaceId: string, workItemId: string, run: WorkItem["run"]): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, status: "running", run: { ...item.run, ...run, resumeMessage: undefined } }));
  }

  async heartbeatWorkItem(workspaceId: string, workItemId: string, lastTurnId?: string): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, run: { ...item.run, lastTurnId: lastTurnId ?? item.run.lastTurnId, heartbeatAt: this.now() } }));
  }

  /** Worker finished: evidence + review dispositions + verify report. Auto-close only when verify passed and item allows it. */
  async submitWorkItem(
    workspaceId: string,
    workItemId: string,
    input: { evidence: Omit<NonNullable<WorkItem["evidence"]>, "submittedAt">; review: WorkItem["review"]; verify: Omit<NonNullable<WorkItem["verify"]>, "verifiedAt"> }
  ): Promise<WorkItem> {
    const now = this.now();
    const submitted = await this.mutateWorkItem(workspaceId, workItemId, (item) => {
      if (item.run.staleTurnId) {
        // The contract changed during the turn this submit came from: void it, back to the queue, same worktree.
        return { ...item, status: "queued", decisions: [...item.decisions, "提交作废：合同在本轮进行中被调整"], run: { ...item.run, sessionId: undefined, staleTurnId: undefined } };
      }
      const verify = { ...input.verify, verifiedAt: now };
      return {
        ...item,
        evidence: { ...input.evidence, submittedAt: now },
        review: input.review,
        verify,
        status: verify.verdict === "rework" ? "queued" : "review"
      };
    });
    return submitted.status === "review" && submitted.autoClose ? this.approveWorkItem(workspaceId, workItemId) : submitted;
  }

  /** Accepts the work: merges the worker's branch into the workspace (when it ran in a worktree) and closes the item. */
  async approveWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const { docs } = await this.context(workspaceId);
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status !== "review") throw new Error("Work item is not awaiting review: " + workItemId);
    if (item.run.worktreePath && item.run.branch) {
      try {
        await docs.mergeWorktree(item.run.worktreePath, item.run.branch, item.title);
      } catch (error) {
        if (!(error instanceof WorktreeMergeConflict)) throw error;
        return this.rejectWorkItem(workspaceId, workItemId, "合并冲突：\n" + error.files.map((file) => "- " + file).join("\n") + "\n在原 worktree 的工单分支上 rebase 到 workspace 当前主分支，解决冲突后重新 review、验收并提交；由用户再次验收，合并仍由工作台完成。");
      }
    }
    return this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, status: "closed", run: { ...current.run, worktreePath: undefined, branch: undefined } }));
  }

  async rejectWorkItem(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => {
      if (item.status !== "review") throw new Error("Work item is not awaiting review: " + workItemId);
      return { ...item, status: "queued", rejections: [...item.rejections, { reason, at: this.now() }], run: { ...item.run, resumeMessage: "用户打回：" + reason } };
    });
  }

  async cancelWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const { docs } = await this.context(workspaceId);
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.run.worktreePath && item.run.branch) await docs.dropWorktree(item.run.worktreePath, item.run.branch);
    const cancelled = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({ ...current, status: "cancelled", run: { ...current.run, worktreePath: undefined, branch: undefined } }));
    const dependants = (await this.listWorkItems(workspaceId)).filter((w) => w.status === "queued" && w.dependsOn.includes(workItemId)).map((w) => w.workItemId);
    this.emit({ type: "workItem.cancelled", workspaceId, workItemId, sessionId: item.status === "running" ? item.run.sessionId : undefined, dependants });
    return cancelled;
  }

  /**
   * Steward adjusts a contract after a new revision. A running item keeps its session and worktree and its worker is
   * steered immediately; a submission awaiting review goes back to the queue; anything else just gets the new contract.
   */
  async updateWorkItem(
    workspaceId: string,
    workItemId: string,
    input: Partial<Pick<WorkItem, "title" | "objective" | "refs" | "scope" | "acceptance" | "risk" | "dependsOn">> & { note: string }
  ): Promise<WorkItem> {
    const { note, ...changes } = input;
    const updated = await this.mutateWorkItem(workspaceId, workItemId, (item) => {
      if (item.status === "closed" || item.status === "cancelled") throw new Error("Work item is " + item.status + ": " + workItemId);
      const status = item.status === "review" ? "queued" : item.status;
      // While parked the note lives on the decision card and reaches the worker inside the answer line.
      const decisions = status === "decision" ? item.decisions : [...item.decisions, "工单调整：" + note];
      return { ...item, ...changes, status, decisions };
    });
    if (updated.status === "running" && updated.run.sessionId) this.emit({ type: "workItem.updated", workspaceId, workItemId, sessionId: updated.run.sessionId, note });
    // Parked on a decision: the user reads the change on the card before answering; the answer carries it to the worker.
    if (updated.status === "decision") {
      const { store } = await this.context(workspaceId);
      const card = (await store.decisions.list()).find((c) => c.workItemId === workItemId && !c.answer);
      if (card) {
        await store.decisions.put({ ...card, adjustments: [...(card.adjustments ?? []), { note, at: this.now() }] });
        this.emit({ type: "decisions.changed", workspaceId });
      }
    }
    return updated;
  }

  /** Orchestrator: marks/clears the turn during which a contract change landed mid-flight. */
  async setWorkItemStaleTurn(workspaceId: string, workItemId: string, staleTurnId: string | undefined): Promise<WorkItem> {
    return this.mutateWorkItem(workspaceId, workItemId, (item) => ({ ...item, run: { ...item.run, staleTurnId } }));
  }

  /**
   * Scheduler: the worker session ended without submit or decision. Back to the queue with the failure noted; after the
   * third failure the item is parked on a decision card instead so the user sees it.
   */
  async requeueWorkItem(workspaceId: string, workItemId: string, failure: string): Promise<WorkItem> {
    const item = await this.mutateWorkItem(workspaceId, workItemId, (current) => ({
      ...current,
      status: "queued",
      run: { ...current.run, sessionId: undefined, lastFailure: failure, attempts: (current.run.attempts ?? 0) + 1 }
    }));
    if ((item.run.attempts ?? 0) < MAX_ATTEMPTS) return item;
    await this.createDecision(workspaceId, {
      kind: "attempts",
      workItemId,
      missionId: item.missionId,
      question: "工单「" + item.title + "」连续 " + MAX_ATTEMPTS + " 次没有完成，要继续吗？",
      context: "最近一次失败：" + failure + "。每次都由新的 Worker 会话从上次的 worktree 继续，但都没有走到提交。",
      options: [
        { key: "retry", label: "再试一次", detail: "重新排队，失败计数清零，换一个 Worker 会话继续" },
        { key: "cancel", label: "取消工单", detail: "关闭工单并清理它的 worktree；需要的话由管家或你重新建单" }
      ],
      recommended: "cancel",
      recommendation: "三次都没提交通常说明工单本身有问题，先看看会话里卡在哪，比盲目重试有用"
    });
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
    const card = await store.decisions.put({ ...input, decisionId: createId("d"), createdAt: this.now() });
    if (input.workItemId) {
      await this.mutateWorkItem(workspaceId, input.workItemId, (item) => (item.status === "running" || item.status === "queued" ? { ...item, status: "decision" } : item));
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
    if (!answer.key && !answer.note?.trim()) throw new Error("Answer needs an option key or a note");
    if (answer.key && !card.options.some((o) => o.key === answer.key)) throw new Error("Unknown option: " + answer.key);
    const answered = await store.decisions.put({ ...card, answer: { ...answer, at: this.now() } });
    if (card.workItemId) {
      const line = describeAnswer(card, answer);
      if (card.kind === "attempts" && answer.key === "cancel") {
        await this.mutateWorkItem(workspaceId, card.workItemId, (item) => ({ ...item, decisions: [...item.decisions, line] }));
        await this.cancelWorkItem(workspaceId, card.workItemId);
      } else {
        const resetAttempts = card.kind === "attempts";
        await this.mutateWorkItem(workspaceId, card.workItemId, (item) => ({
          ...item,
          status: item.status === "decision" ? "queued" : item.status,
          decisions: [...item.decisions, line],
          run: resetAttempts
            ? { ...item.run, sessionId: undefined, resumeMessage: undefined, attempts: 0, lastFailure: undefined }
            : item.status === "decision"
              ? { ...item.run, sessionId: card.sessionId ?? item.run.sessionId, resumeMessage: "用户决策答复：" + line }
              : item.run
        }));
      }
    }
    this.emit({ type: "decisions.changed", workspaceId });
    return answered;
  }

  // ---- inbox ----

  async listInbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const workspace of await this.listWorkspaces()) {
      const { store } = await this.context(workspace.workspaceId);
      for (const card of await store.decisions.list()) {
        if (!card.answer) items.push({ kind: "decision", workspaceId: workspace.workspaceId, card });
      }
      const missions = await store.missions.list();
      for (const workItem of await store.workItems.list()) {
        if (workItem.status !== "review") continue;
        items.push({ kind: "review", workspaceId: workspace.workspaceId, workItem, mission: missions.find((m) => m.missionId === workItem.missionId) });
      }
    }
    return items;
  }
}

const isLowRisk = (risk: Risk): boolean => risk === "R0" || risk === "R1";

/** "question -> chosen option (note)" or "question -> 备注：note", followed by the contract changes made while the card waited. */
const describeAnswer = (card: DecisionCard, answer: { key?: string; note?: string }): string => {
  const option = card.options.find((o) => o.key === answer.key);
  const note = answer.note?.trim();
  const chosen = option ? option.label + (note ? " (" + note + ")" : "") : "备注：" + note;
  const adjustments = (card.adjustments ?? []).map((a) => "；挂起期间工单调整：" + a.note).join("");
  return card.question + " -> " + chosen + adjustments;
};

const watchedAreas: Record<string, Exclude<Extract<WorkbenchEvent, { workspaceId: string }>, { workItemId: string }>["type"] | undefined> = {
  docs: "docs.changed",
  roles: "roles.changed",
  missions: "missions.changed",
  workitems: "workItems.changed",
  decisions: "decisions.changed",
  runs: "runs.changed",
  "scheduler.json": "scheduler.changed"
};
