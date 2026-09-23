import { effectiveNeeds, actionIsOpen, renderExecutionNotices, type Execution, type PatrolRun, type WorkMessage, type WorkRequest, type RoleExecutionOverrides } from "./contracts.js";
import type { RoleService } from "./roles.js";
import type { WorkbenchService } from "./workbench-service.js";
import type { SessionReceipt, TurnInspector } from "./execution-runtime.js";
import { workerOpeningMessage } from "./execution-message.js";

/** What the orchestrator needs from the session engine. Implemented in Electron main over SessionShellService. */
export type AgentRunner = {
  inspectTurn?: TurnInspector;
  /** Resolves the session's latest turn; undefined means a verified empty session. */
  resolveSourceTurn?: (sessionId: string) => Promise<string | undefined>;
  fork: (input: { workspaceId: string; sourceSessionId: string; sourceTurnId: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string; treeId?: string }>;
  open: (input: { workspaceId: string; cwd: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string }>;
  /** The caller supplies the message id so it can recognize the turn this message opens. */
  send: (sessionId: string, content: string, options?: Omit<WorkMessage, "content"> & { messageId?: string }) => Promise<void | (SessionReceipt & { messageId?: string })>;
  /** Delivers into the running turn when there is one, otherwise starts the next message. */
  steer: (sessionId: string, content: string, messageId?: string) => Promise<SessionReceipt & { messageId?: string }>;
  interrupt: (sessionId: string, turnId?: string) => Promise<void>;
  /** Loads an existing session so it can receive messages again. Resolves false when the session cannot be opened. */
  resume: (sessionId: string, options?: { cwd?: string; modelConfig?: RoleExecutionOverrides; metadata?: Record<string, unknown>; title?: string }) => Promise<boolean>;
  /** Requests unsubscribe of an idle worker; preserves its history and permits native idle unloading. */
  release: (sessionId: string) => Promise<void>;
  /** True while the runtime is executing a turn, including tool/model waits. */
  isActive?: (sessionId: string) => boolean;
  getActiveTurnId?: (sessionId: string) => string | undefined;
  confirmMessage?: (sessionId: string, messageId: string) => Promise<{ accepted: boolean; turnId?: string }>;
  onTurnStarted?: (listener: (event: { sessionId: string; turnId: string; messageId?: string }) => void) => () => void;
  onTurnCompleted: (listener: (event: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed"; failure?: string }) => void) => () => void;
};


export type OrchestratorOptions = {
  service: WorkbenchService;
  roles: RoleService;
  runner: AgentRunner;
  now?: () => string;
  cleanupIntervalMs?: number;
  patrolIntervalMs?: number;
};
type PatrolBinding = { workspaceId: string; patrolRunId: string; sessionId: string };
const createId = (prefix: string) => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
export const SUPERVISOR_INTERVAL_MS = 5 * 60_000;
const workspaceQueues = new Map<string, Promise<void>>();

/** Dispatches explicit business work; a completed conversation never implies another task. */
export class Orchestrator {
  private readonly service: WorkbenchService;
  private readonly roles: RoleService;
  private readonly runner: AgentRunner;
  private readonly now: () => string;
  private readonly cleanupIntervalMs: number;
  private readonly patrolIntervalMs: number;
  private readonly disposers: Array<() => void> = [];
  private readonly supervisorTimers = new Map<string, NodeJS.Timeout>();
  private readonly patrolsBySession = new Map<string, PatrolBinding>();
  private readonly patrolQueues = new Map<string, Promise<void>>();
  private readonly patrolRequested = new Set<string>();
  private disposed = false;

  constructor(options: OrchestratorOptions) {
    this.service = options.service;
    this.roles = options.roles;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60_000;
    this.patrolIntervalMs = options.patrolIntervalMs ?? 60_000;
  }

  start(): void {
    this.disposed = false;
    this.disposers.push(
      this.service.setWorkerActiveChecker((id) => this.runner.isActive?.(id) ?? false),
      this.service.setTurnInterrupter((id, turnId) => this.runner.interrupt(id, turnId)),
      this.service.setWorkerEnvironmentReleaser((id) => this.runner.release(id)),
      this.service.registerScheduler(),
      this.service.setExecutionStarter((workspaceId, workItemId) =>
        this.enqueue(workspaceId, () => this.dispatchItem(workspaceId, workItemId, true)))
    );
    if (this.runner.inspectTurn) this.disposers.push(this.service.setTurnInspector(this.runner.inspectTurn));
    if (this.runner.resolveSourceTurn) this.disposers.push(this.service.setSourceTurnResolver(this.runner.resolveSourceTurn));
    const cleanupTimer = setInterval(() => {
      void this.service.listWorkspaces().then((workspaces) => {
        for (const { workspaceId } of workspaces) void this.enqueue(workspaceId, async () => {
          await this.service.releaseIdleWorkers(workspaceId);
          await this.service.cleanupWorktrees(workspaceId);
        });
      });
    }, this.cleanupIntervalMs);
    const patrolTimer = setInterval(() => {
      void this.service.listWorkspaces().then((workspaces) => {
        for (const { workspaceId } of workspaces) this.requestPatrol(workspaceId);
      });
    }, this.patrolIntervalMs);
    cleanupTimer.unref();
    patrolTimer.unref();
    this.disposers.push(() => clearInterval(cleanupTimer), () => clearInterval(patrolTimer));
    this.disposers.push(this.service.subscribe((event) => {
      if (!("workspaceId" in event)) return;
      if (["domains.changed", "docs.changed", "issues.changed"].includes(event.type)) {
        this.requestPatrol(event.workspaceId);
      } else if (["workItem.cancelled", "workRequest.cancelled"].includes(event.type)) {
        const cancelled = event as { workspaceId: string; sessionId?: string; turnId?: string };
        void this.enqueue(event.workspaceId, async () => {
          if (cancelled.sessionId && cancelled.turnId) await this.runner.interrupt(cancelled.sessionId, cancelled.turnId);
          await this.reconcile(event.workspaceId);
        });
      } else if (["workItem.updated", "workItems.changed", "workRequests.changed", "actions.changed", "decisions.changed", "scheduler.changed"].includes(event.type)) {
        void this.enqueue(event.workspaceId, () => this.reconcile(event.workspaceId));
      }
    }));
    if (this.runner.onTurnStarted) this.disposers.push(this.runner.onTurnStarted((event) => {
      void this.service.listWorkspaces().then((workspaces) => {
        for (const { workspaceId } of workspaces) void this.enqueue(workspaceId, async () => {
          await this.service.observeSessionTurn(event.sessionId, event.turnId, event.messageId);
          for (const request of await this.service.listWorkRequests(workspaceId)) {
            if (request.supervisor?.sessionId === event.sessionId && request.supervisor.activeTurnId !== event.turnId) {
              await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current,
                supervisor: { ...current.supervisor, activeTurnId: event.turnId, nextCheckAt: undefined,
                  pendingMessageId: event.messageId === current.supervisor?.pendingMessageId ? undefined : current.supervisor?.pendingMessageId } }));
            }
          }
        });
      });
    }));
    this.disposers.push(this.runner.onTurnCompleted((event) => {
      void this.service.listWorkspaces().then((workspaces) => {
        for (const { workspaceId } of workspaces) void this.enqueue(workspaceId, async () => {
          const patrol = this.patrolsBySession.get(event.sessionId);
          if (patrol?.workspaceId === workspaceId) {
            const run = await this.service.getPatrolRun(workspaceId, patrol.patrolRunId);
            if (run.status === "running") await this.service.failPatrolRun(workspaceId, patrol.patrolRunId,
              event.failure ?? "巡检轮次结束但未登记结果。");
            this.patrolsBySession.delete(event.sessionId);
            await this.runner.release(event.sessionId);
          }
          await this.service.settleExecutionTurn(workspaceId, event.sessionId, event.turnId, event.finishReason, event.failure);
          for (const request of await this.service.listWorkRequests(workspaceId)) {
            if (request.supervisor?.sessionId === event.sessionId && request.supervisor.activeTurnId === event.turnId) {
              await this.finishSupervisor(workspaceId, request, event.failure);
            }
          }
          await this.service.workerTurnCompleted(workspaceId, event.sessionId);
          await this.reconcile(workspaceId);
        });
      });
    }));
    void this.service.listWorkspaces().then((workspaces) => {
      for (const { workspaceId } of workspaces) {
        this.requestPatrol(workspaceId);
        void this.enqueue(workspaceId, () => this.reconcile(workspaceId));
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const timer of this.supervisorTimers.values()) clearTimeout(timer);
    this.supervisorTimers.clear();
    await Promise.allSettled([...workspaceQueues.values(), ...this.patrolQueues.values()]);
  }

  private enqueue(workspaceId: string, task: () => Promise<void>): Promise<void> {
    const next = (workspaceQueues.get(workspaceId) ?? Promise.resolve()).then(() => this.disposed ? undefined : task());
    const drained = next.catch((error) => console.error("[workbench]", workspaceId, error)).finally(() => {
      if (workspaceQueues.get(workspaceId) === drained) workspaceQueues.delete(workspaceId);
    });
    workspaceQueues.set(workspaceId, drained);
    return next;
  }

  private requestPatrol(workspaceId: string): void {
    if (this.disposed || this.patrolRequested.has(workspaceId)) return;
    this.patrolRequested.add(workspaceId);
    const next = (this.patrolQueues.get(workspaceId) ?? Promise.resolve()).then(async () => {
      this.patrolRequested.delete(workspaceId);
      if (!this.disposed) await this.reconcilePatrol(workspaceId);
    });
    const drained = next.catch((error) => console.error("[orchestrator] patrol", workspaceId, error)).finally(() => {
      if (this.patrolQueues.get(workspaceId) === drained) this.patrolQueues.delete(workspaceId);
    });
    this.patrolQueues.set(workspaceId, drained);
  }


  private async reconcile(workspaceId: string): Promise<void> {
    if (this.disposed) return;
    await this.service.reconcileExecutionTurns(workspaceId);
    await this.service.refreshActions(workspaceId);
    const enabled = (await this.service.getScheduler(workspaceId)).enabled;
    for (const request of await this.service.listWorkRequests(workspaceId)) {
      if (request.paused && request.workerSessionId && this.runner.isActive?.(request.workerSessionId)) {
        await this.runner.interrupt(request.workerSessionId, request.activeTurnId);
      }
      if (enabled) await this.prepareRequest(workspaceId, request);
      await this.checkSupervisor(workspaceId, request, enabled);
    }
    for (const item of await this.service.listWorkItems(workspaceId)) {
      if (item.run.paused && item.run.sessionId && this.runner.isActive?.(item.run.sessionId)) {
        await this.runner.interrupt(item.run.sessionId, item.run.activeTurnId);
      }
      if (enabled) await this.dispatchItem(workspaceId, item.workItemId);
    }
    await this.service.continueIntegrations(workspaceId);
    await this.service.releaseIdleWorkers(workspaceId);
  }

  private async dispatchItem(workspaceId: string, workItemId: string, explicit = false): Promise<void> {
    const item = await this.service.getWorkItem(workspaceId, workItemId);
    const action = (await this.service.listActions(workspaceId)).find((entry): entry is Execution =>
      entry.kind === "execute" && entry.workItemId === workItemId)!;
    if (!action || !actionIsOpen(action) || item.run.paused || item.run.userStopped ||
        ["preparing", "closed", "cancelled"].includes(item.status)) return;
    if (action.pendingMessageId) {
      if (action.sessionId && this.runner.confirmMessage) {
        const receipt = await this.runner.confirmMessage(action.sessionId, action.pendingMessageId);
        if (receipt.accepted) await this.service.updateAction(workspaceId, action, (current) => ({
          ...current, pendingMessageId: undefined, activeTurnId: receipt.turnId,
          status: "running", stage: "execute", deliveredAt: this.now()
        }));
      }
      return;
    }
    if (action.status !== "pending" && !action.notices.length) return;
    if (await this.service.isWorkItemBlocked(workspaceId, workItemId)) {
      if (explicit) throw new Error("工作仍有未解决的依赖、资源或决策等待。");
      return;
    }
    const occupancy = await this.service.getExecutionOccupancy(workspaceId);
    const others = occupancy.workItems.filter((entry) => entry.workItemId !== workItemId);
    const slots = occupancy.sessionIds.filter((id) => id !== action.sessionId);
    if (slots.length >= (await this.service.getScheduler(workspaceId)).maxWorkers ||
        others.some((entry) => effectiveNeeds(entry).some((need) => effectiveNeeds(item).includes(need)))) {
      if (explicit) throw new Error("并发或共享资源尚未释放。");
      return;
    }
    const root = await this.service.workspaceRoot(workspaceId);
    const role = await this.service.resolveWorkerRole(workspaceId);
    let sessionId = action.sessionId;
    try {
      if (!sessionId) {
        const metadata = { role: "worker", workItemId, sourceSessionId: item.sourceSessionId, sourceTurnId: item.sourceTurnId };
        const opened = action.forkSessionId && action.forkTurnId
          ? await this.runner.fork({ workspaceId, sourceSessionId: action.forkSessionId, sourceTurnId: action.forkTurnId, title: "Worker · " + item.title, modelConfig: role.modelConfig, metadata })
          : await this.runner.open({ workspaceId, cwd: root, title: "Worker · " + item.title, modelConfig: role.modelConfig, metadata });
        sessionId = opened.sessionId;
        await this.service.updateAction(workspaceId, action, (current) => ({ ...current, sessionId, stage: "deliver" }));
      }
      if (!await this.runner.resume(sessionId, { cwd: root, modelConfig: role.modelConfig,
        metadata: { role: "worker", workItemId, sourceSessionId: item.sourceSessionId, sourceTurnId: item.sourceTurnId } })) {
        throw new Error("无法恢复固定 Worker 会话：" + sessionId);
      }
      const active = this.runner.isActive?.(sessionId) === true;
      if (active && !action.notices.length) return;
      const latest = await this.service.getWorkItem(workspaceId, workItemId);
      if (latest.run.paused || latest.run.userStopped || ["closed", "cancelled"].includes(latest.status)) return;
      if (latest.status === "queued") await this.service.startWorkItem(workspaceId, workItemId, { sessionId });
      const content = [!action.deliveredAt ? workerOpeningMessage(workspaceId, { ...latest, run: { ...latest.run, sessionId } }, root) : undefined,
        renderExecutionNotices(action.notices)].filter(Boolean).join("\n\n") || "继续当前工单，读取最新合同与已有成果后完成交接。";
      const messageId = createId("dispatch");
      await this.service.updateAction(workspaceId, action, (current) => ({ ...current, pendingMessageId: messageId }));
      const receipt = active ? await this.runner.steer(sessionId, content, messageId)
        : await this.runner.send(sessionId, content, { messageId });
      if (receipt?.accepted === false) {
        await this.service.updateAction(workspaceId, action, (current) => ({ ...current, pendingMessageId: undefined }));
        throw new Error(receipt.error?.message ?? "引擎未受理派发。");
      }
      await this.service.updateAction(workspaceId, action, (current) => ({
        ...current, pendingMessageId: undefined, activeTurnId: receipt?.turnId ?? current.activeTurnId,
        status: "running", stage: "execute", deliveredAt: this.now(), failure: undefined,
        notices: current.notices.slice(action.notices.length)
      }));
    } catch (error) {
      await this.service.failAction(workspaceId, action.actionId, error instanceof Error ? error.message : String(error));
      if (explicit) throw error;
    }
  }

  private async prepareRequest(workspaceId: string, request: WorkRequest): Promise<void> {
    if (request.paused || request.userStopped || !["pending", "preparing"].includes(request.status)) return;
    if (request.workerSessionId && this.runner.isActive?.(request.workerSessionId)) return;
    if (request.activeTurnId) return;
    if (request.pendingMessageId) {
      if (request.workerSessionId && this.runner.confirmMessage) {
        const receipt = await this.runner.confirmMessage(request.workerSessionId, request.pendingMessageId);
        if (receipt.accepted) await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({
          ...current, pendingMessageId: undefined, activeTurnId: receipt.turnId, dispatchRequested: false
        }));
      }
      return;
    }
    if (request.status !== "pending" && !request.dispatchRequested) return;
    if ((await this.service.getExecutionOccupancy(workspaceId)).sessionIds.length >= (await this.service.getScheduler(workspaceId)).maxWorkers) return;
    if (!request.workerSessionId && this.runner.isActive?.(request.sourceSessionId)) return;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      const role = await this.roles.resolve(root, "work-preparation");
      let sessionId = request.workerSessionId;
      if (!sessionId) {
        const fork = request.sourceTurnId ? await this.runner.fork({
          workspaceId, sourceSessionId: request.sourceSessionId, sourceTurnId: request.sourceTurnId,
          title: "开工准备", modelConfig: role.modelConfig,
          metadata: { role: "work-preparation", requestId: request.requestId, sourceSessionId: request.sourceSessionId }
        }) : { sessionId: request.sourceSessionId };
        sessionId = fork.sessionId;
        await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, workerSessionId: sessionId, status: "preparing" }));
      }
      if (!await this.runner.resume(sessionId, { cwd: root })) throw new Error("无法恢复准备会话。");
      const latest = (await this.service.listWorkRequests(workspaceId)).find((entry) => entry.requestId === request.requestId)!;
      if (latest.paused || latest.userStopped || latest.status === "cancelled") return;
      const content = request.dispatchRequested
        ? "继续本次准备，保留已有成果，完成完整交接。\nrequestId: " + request.requestId
        : [request.message?.content, role.content, "workspaceId: " + workspaceId, "sessionId: " + sessionId,
          "requestId: " + request.requestId, "sourceSessionId: " + request.sourceSessionId,
          "开工范围: " + (request.scope ?? "根据讨论确定范围"),
          "结束前必须通过 work.prepare.complete 登记完整工单清单、文档依据和目录。"].filter(Boolean).join("\n\n");
      const messageId = createId("preparation");
      await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, pendingMessageId: messageId, dispatchRequested: false }));
      const receipt = await this.runner.send(sessionId, content, { ...request.message, messageId });
      if (receipt?.accepted === false) {
        await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...current, pendingMessageId: undefined }));
        throw new Error(receipt.error?.message ?? "引擎未受理准备任务。");
      }
      await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({
        ...current, pendingMessageId: undefined, activeTurnId: receipt?.turnId, failure: undefined
      }));
    } catch (error) {
      await this.service.failWorkRequest(workspaceId, request.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  private async finishSupervisor(workspaceId: string, request: WorkRequest, failure?: string): Promise<void> {
    const at = this.now();
    await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({
      ...current, supervisor: { ...current.supervisor, activeTurnId: undefined, pendingMessageId: undefined,
        lastCheckedAt: at, nextCheckAt: new Date(Date.parse(at) + SUPERVISOR_INTERVAL_MS).toISOString(), failure }
    }));
  }

  private async checkSupervisor(workspaceId: string, request: WorkRequest, enabled: boolean): Promise<void> {
    const key = workspaceId + ":" + request.requestId;
    const timer = this.supervisorTimers.get(key);
    if (timer) clearTimeout(timer);
    this.supervisorTimers.delete(key);
    if (!request.supervisor || request.status !== "ready") return;
    const unfinished = (await this.service.listWorkItems(workspaceId)).some((item) =>
      item.requestId === request.requestId && !["closed", "cancelled"].includes(item.status));
    if (!unfinished || request.paused || !enabled) return;
    const schedule = (at: string) => {
      const timeout = setTimeout(() => {
        this.supervisorTimers.delete(key);
        void this.enqueue(workspaceId, () => this.reconcile(workspaceId));
      }, Math.max(1, Date.parse(at) - Date.parse(this.now())));
      timeout.unref();
      this.supervisorTimers.set(key, timeout);
    };
    const supervisor = request.supervisor;
    if (supervisor.sessionId && this.runner.isActive?.(supervisor.sessionId)) return;
    if (supervisor.activeTurnId && supervisor.sessionId) {
      const fact = await this.runner.inspectTurn?.(supervisor.sessionId, supervisor.activeTurnId);
      if (fact?.status === "completed") await this.finishSupervisor(workspaceId, request, fact.failure);
      return;
    }
    if (supervisor.nextCheckAt && supervisor.nextCheckAt > this.now()) {
      schedule(supervisor.nextCheckAt);
      return;
    }
    let sessionId = supervisor.sessionId;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      const role = await this.roles.resolve(root, "supervisor");
      if (!sessionId) {
        if (!request.workerSessionId || !request.handoff?.turnId) throw new Error("准备末端尚未登记，不能创建监工。");
        sessionId = (await this.runner.fork({ workspaceId, sourceSessionId: request.workerSessionId,
          sourceTurnId: request.handoff.turnId, title: "监工 · " + (request.scope ?? request.requestId),
          modelConfig: role.modelConfig, metadata: { role: "supervisor", requestId: request.requestId } })).sessionId;
        await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({
          ...current, supervisor: { ...current.supervisor, sessionId }
        }));
      }
      if (!await this.runner.resume(sessionId, { cwd: root, modelConfig: role.modelConfig,
        metadata: { role: "supervisor", requestId: request.requestId } })) throw new Error("无法恢复监工会话。");
      if (supervisor.pendingMessageId) {
        const receipt = await this.runner.confirmMessage?.(sessionId, supervisor.pendingMessageId);
        if (!receipt?.accepted) throw new Error("监工检查消息受理状态未确认。");
        await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => ({
          ...current, supervisor: { ...current.supervisor, pendingMessageId: undefined, activeTurnId: receipt.turnId }
        }));
        return;
      }
      const current = (await this.service.listWorkRequests(workspaceId)).find((entry) => entry.requestId === request.requestId)!;
      if (current.paused || !(await this.service.getScheduler(workspaceId)).enabled) return;
      const messageId = createId("supervision");
      await this.service.updateWorkRequest(workspaceId, request.requestId, (latest) => ({
        ...latest, supervisor: { ...latest.supervisor, pendingMessageId: messageId, nextCheckAt: undefined, startedAt: this.now(), failure: undefined }
      }));
      const receipt = await this.runner.send(sessionId,
        "检查本工作当前进展，按监工职责处理。\nworkspaceId: " + workspaceId +
        "\nrequestId: " + request.requestId + "\nsessionId: " + sessionId +
        "\n业务处置调用携带 originatorSessionId: " + sessionId +
        "\n先查询 work.diagnose 与关联 workItem，再读取 Worker 最近消息和活动。", { messageId });
      if (receipt?.accepted === false) {
        await this.service.updateWorkRequest(workspaceId, request.requestId, (latest) => ({
          ...latest, supervisor: { ...latest.supervisor, pendingMessageId: undefined }
        }));
        throw new Error(receipt.error?.message ?? "引擎未受理监工检查。");
      }
      await this.service.updateWorkRequest(workspaceId, request.requestId, (latest) => ({
        ...latest, supervisor: { ...latest.supervisor, activeTurnId: receipt?.turnId, pendingMessageId: undefined }
      }));
    } catch (error) {
      const nextCheckAt = new Date(Date.parse(this.now()) + SUPERVISOR_INTERVAL_MS).toISOString();
      await this.service.updateWorkRequest(workspaceId, request.requestId, (latest) => ({
        ...latest, supervisor: { ...latest.supervisor, failure: error instanceof Error ? error.message : String(error), nextCheckAt }
      }));
      schedule(nextCheckAt);
    }
  }

  private async reconcilePatrol(workspaceId: string): Promise<void> {
    if (this.disposed) return;
    if (!(await this.service.getScheduler(workspaceId)).enabled) return;
    await this.service.scanPatrols(workspaceId);
    await this.dispatchPatrol(workspaceId);
  }

  private async dispatchPatrol(workspaceId: string): Promise<void> {
    const runs = await this.service.listPatrolRuns(workspaceId);
    const current = runs.find((run) => run.status === "running") ?? runs.find((run) => run.status === "queued");
    if (!current) return;
    let sessionId = current.sessionId;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      const role = await this.service.resolveMaintainer(workspaceId, current.domainId);
      const metadata = { role: "maintainer", patrolRunId: current.patrolRunId, domainId: current.domainId };
      if (current.status === "running") {
        if (!sessionId) throw new Error("运行中的巡检缺少会话。");
        if (this.patrolsBySession.has(sessionId)) return;
        if (!await this.runner.resume(sessionId, { cwd: root, modelConfig: role.modelConfig,
          title: "Maintainer · " + current.domainId, metadata })) throw new Error("无法恢复巡检会话：" + sessionId);
        this.patrolsBySession.set(sessionId, { workspaceId, patrolRunId: current.patrolRunId, sessionId });
        if (this.runner.isActive?.(sessionId)) return;
        const receipt = await this.runner.send(sessionId, "巡检会话已恢复。重新核对当前记录，避免重复创建 Issue 或工单，然后继续尚未完成的巡检。\n\n" + await this.service.patrolMessage(workspaceId, current.patrolRunId));
        await this.service.setPatrolTurn(workspaceId, current.patrolRunId, receipt?.turnId);
        return;
      }
      const opened = await this.runner.open({ workspaceId, cwd: root, modelConfig: role.modelConfig,
        title: "Maintainer · " + current.domainId, metadata });
      sessionId = opened.sessionId;
      await this.service.startPatrolRun(workspaceId, current.patrolRunId, sessionId);
      this.patrolsBySession.set(sessionId, { workspaceId, patrolRunId: current.patrolRunId, sessionId });
      const receipt = await this.runner.send(sessionId, await this.service.patrolMessage(workspaceId, current.patrolRunId));
      await this.service.setPatrolTurn(workspaceId, current.patrolRunId, receipt?.turnId);
    } catch (error) {
      this.patrolsBySession.delete(sessionId ?? "");
      if (sessionId) await this.runner.release(sessionId).catch(() => undefined);
      await this.service.failPatrolRun(workspaceId, current.patrolRunId, error instanceof Error ? error.message : String(error));
    }
  }


}
