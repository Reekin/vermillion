import { effectiveNeeds, actionIsOpen, renderExecutionNotices, type AgentRun, type Execution, type PatrolRun, type WorkMessage, type RoleExecutionOverrides } from "./contracts.js";
import type { RoleService } from "./roles.js";
import type { WorkbenchService } from "./workbench-service.js";
import type { SessionDispatchReceipt, TurnInspector } from "./execution-control.js";

/** What the orchestrator needs from the session engine. Implemented in Electron main over SessionShellService. */
export type AgentRunner = {
  inspectTurn?: TurnInspector;
  /** Resolves the session's latest turn; undefined means a verified empty session. */
  resolveSourceTurn?: (sessionId: string) => Promise<string | undefined>;
  fork: (input: { workspaceId: string; sourceSessionId: string; sourceTurnId: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string; treeId?: string }>;
  open: (input: { workspaceId: string; cwd: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string }>;
  /** The caller supplies the message id so it can recognize the turn this message opens. */
  send: (sessionId: string, content: string, options?: Omit<WorkMessage, "content"> & { messageId?: string }) => Promise<void | (Partial<SessionDispatchReceipt> & { messageId?: string })>;
  /** Delivers into the running turn when there is one, otherwise starts the next message. */
  steer: (sessionId: string, content: string, messageId?: string) => Promise<Partial<SessionDispatchReceipt> & { messageId?: string }>;
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

type WorkerBinding = { workspaceId: string; run: AgentRun; actionId: string };
type TurnOrigin = "scheduler" | "user";
type WorkerTurn = { turnId?: string; origin: TurnOrigin; settled?: boolean; bound?: WorkerBinding };
type PatrolBinding = { workspaceId: string; patrolRunId: string; sessionId: string };
const createId = (prefix: string): string => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

// A replacement orchestrator takes ownership only after the previous generation's in-flight task drains.
const workspaceQueues = new Map<string, Promise<void>>();

/** Resumes each item's execution and drains workspace integration checkpoints. */
export class Orchestrator {
  private readonly service: WorkbenchService;
  private readonly roles: RoleService;
  private readonly runner: AgentRunner;
  private readonly now: () => string;
  private readonly cleanupIntervalMs: number;
  private readonly patrolIntervalMs: number;
  private readonly disposers: Array<() => void> = [];
  private readonly runsBySession = new Map<string, WorkerBinding>();
  private readonly turnsBySession = new Map<string, WorkerTurn>();
  private readonly unsettledTurns = new Map<string, Set<WorkerTurn>>();
  private readonly settling = new Map<string, number>();
  private readonly settlements = new Set<Promise<void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly preparing = new Map<string, string>();
  private readonly turnAttributions = new Map<string, Promise<void>>();
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
    this.disposers.push(this.service.setWorkerActiveChecker((sessionId) => this.runner.isActive?.(sessionId) ?? false));
    this.disposers.push(this.service.setWorkerSettlingChecker((sessionId) => !!this.settling.get(sessionId)));
    if (this.runner.inspectTurn) this.disposers.push(this.service.setTurnInspector(this.runner.inspectTurn));
    this.disposers.push(this.service.setTurnInterrupter((sessionId, turnId) => this.runner.interrupt(sessionId, turnId)));
    this.disposers.push(this.service.setWorkerEnvironmentReleaser((sessionId) => this.runner.release(sessionId)));
    if (this.runner.resolveSourceTurn) this.disposers.push(this.service.setSourceTurnResolver(this.runner.resolveSourceTurn));
    this.disposers.push(this.service.registerScheduler());
    const cleanupTimer = setInterval(() => {
      void this.service.listWorkspaces().then((workspaces) => {
        for (const workspace of workspaces) void this.enqueue(workspace.workspaceId, async () => {
          await this.service.releaseIdleWorkers(workspace.workspaceId);
          await this.service.cleanupWorktrees(workspace.workspaceId);
        });
      });
    }, this.cleanupIntervalMs);
    cleanupTimer.unref();
    this.disposers.push(() => clearInterval(cleanupTimer));
    const patrolTimer = setInterval(() => {
      void this.service.listWorkspaces().then((workspaces) => {
        for (const workspace of workspaces) this.requestPatrol(workspace.workspaceId);
      });
    }, this.patrolIntervalMs);
    patrolTimer.unref();
    this.disposers.push(() => clearInterval(patrolTimer));
    this.disposers.push(this.service.subscribe((event) => {
      if (!("workspaceId" in event)) return;
      if (event.type === "workItem.updated") {
        void this.enqueue(event.workspaceId, () => this.deliverUpdate(event.workspaceId, event.workItemId, event.sessionId));
      } else if (["actions.changed", "workItems.changed", "workRequests.changed", "decisions.changed", "scheduler.changed"].includes(event.type)) {
        void this.enqueue(event.workspaceId, () => this.reconcile(event.workspaceId));
      } else if (["domains.changed", "docs.changed", "issues.changed"].includes(event.type)) {
        this.requestPatrol(event.workspaceId);
      } else if (event.type === "workRequest.cancelled") {
        const sessionId = event.sessionId;
        void this.enqueue(event.workspaceId, async () => {
          if (sessionId) {
            this.preparing.delete(sessionId);
            if (event.turnId) await this.runner.interrupt(sessionId, event.turnId);
          }
          await this.service.releaseIdleWorkers(event.workspaceId);
          await this.reconcile(event.workspaceId);
        });
      } else if (event.type === "workItem.cancelled" && event.sessionId) {
        const sessionId = event.sessionId;
        void this.enqueue(event.workspaceId, async () => { if (event.turnId) await this.runner.interrupt(sessionId, event.turnId); await this.service.releaseIdleWorkers(event.workspaceId); await this.reconcile(event.workspaceId); });
      }
    }));
    if (this.runner.onTurnStarted) this.disposers.push(this.runner.onTurnStarted((event) => this.attributeTurn(event)));
    this.disposers.push(this.runner.onTurnCompleted((event) => {
      // Install the barrier synchronously: a queued reconcile may run before this event is processed.
      this.settling.set(event.sessionId, (this.settling.get(event.sessionId) ?? 0) + 1);
      const settlement = this.settleTurn(event).catch((error) => console.error("[orchestrator] turn completion", event.sessionId, event.turnId, error));
      this.settlements.add(settlement);
      void settlement.finally(() => this.settlements.delete(settlement));
    }));
    void this.service.listWorkspaces().then((workspaces) => {
      for (const workspace of workspaces) {
        this.requestPatrol(workspace.workspaceId);
        void this.enqueue(workspace.workspaceId, async () => {
          await this.service.releaseIdleWorkers(workspace.workspaceId);
          await this.reconcile(workspace.workspaceId);
        });
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    await Promise.allSettled(this.turnAttributions.values());
    await Promise.allSettled(this.settlements);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.allSettled([...workspaceQueues.values(), ...this.patrolQueues.values()]);
  }

  private enqueue(workspaceId: string, task: () => Promise<void>): Promise<void> {
    const next = (workspaceQueues.get(workspaceId) ?? Promise.resolve()).then(() => this.disposed ? undefined : task());
    const drained = next.catch((error) => console.error("[orchestrator]", workspaceId, error)).finally(() => {
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

  private async settleTurn(event: Parameters<Parameters<AgentRunner["onTurnCompleted"]>[0]>[0]): Promise<void> {
    await this.turnAttributions.get(event.sessionId);
    const turn = [...(this.unsettledTurns.get(event.sessionId) ?? [])].find((turn) => !turn.turnId || turn.turnId === event.turnId);
    const bound = turn?.bound;
    const workspaces = await this.service.listWorkspaces();
    try {
      const patrol = this.patrolsBySession.get(event.sessionId);
      if (patrol) {
        const run = await this.service.getPatrolRun(patrol.workspaceId, patrol.patrolRunId);
        if (run.status === "running") await this.service.failPatrolRun(patrol.workspaceId, patrol.patrolRunId,
          event.finishReason === "completed" ? "巡检轮次结束但未登记结果。" : event.failure ?? `巡检轮次${event.finishReason}。`);
        this.patrolsBySession.delete(event.sessionId);
        await this.runner.release(event.sessionId);
      }
      await Promise.all(workspaces.map(async ({ workspaceId }) => {
        await this.service.workerTurnCompleted(workspaceId, event.sessionId);
        if (bound?.workspaceId === workspaceId && turn && !turn.settled) {
          turn.settled = true;
          await this.onTurn(bound, turn, event.finishReason, event.failure);
          this.unsettledTurns.get(event.sessionId)?.delete(turn);
        }
        if (bound?.workspaceId !== workspaceId) await this.service.settleExecutionTurn(workspaceId, event.sessionId, event.turnId, event.finishReason, event.failure);
        this.preparing.delete(event.sessionId);
      }));
    } finally {
      if (turn && !bound) {
        turn.settled = true;
        this.unsettledTurns.get(event.sessionId)?.delete(turn);
      }
      const remaining = this.settling.get(event.sessionId)! - 1;
      if (remaining) this.settling.set(event.sessionId, remaining);
      else this.settling.delete(event.sessionId);
      for (const { workspaceId } of workspaces) void this.enqueue(workspaceId, async () => {
        await this.service.releaseIdleWorkers(workspaceId);
        await this.reconcile(workspaceId);
      });
    }
  }

  private trackTurn(sessionId: string, turn: WorkerTurn): void {
    turn.bound = this.runsBySession.get(sessionId);
    this.turnsBySession.set(sessionId, turn);
    const pending = this.unsettledTurns.get(sessionId) ?? new Set<WorkerTurn>();
    pending.add(turn);
    this.unsettledTurns.set(sessionId, pending);
  }

  /**
   * Turn attribution is explicit: a turn belongs to the scheduler when the message that opened it is
   * one the scheduler sent. Everything else, including turns the engine reports on its own, is the
   * user's.
   */
  private attributeTurn(event: { sessionId: string; turnId: string; messageId?: string }): void {
    const attribution = this.service.observeSessionTurn(event.sessionId, event.turnId, event.messageId).then((origin) => {
      const tracked = this.turnsBySession.get(event.sessionId);
      if (tracked?.turnId !== event.turnId) this.trackTurn(event.sessionId, { turnId: event.turnId, origin });
    });
    this.turnAttributions.set(event.sessionId, attribution);
    void attribution.finally(() => { if (this.turnAttributions.get(event.sessionId) === attribution) this.turnAttributions.delete(event.sessionId); });
  }

  /** A supplement keeps the running turn's existing attribution. */
  private adoptTurn(sessionId: string, turnId: string): void {
    const tracked = this.turnsBySession.get(sessionId);
    if (tracked?.turnId !== turnId) this.trackTurn(sessionId, { turnId, origin: "scheduler" });
  }

  /**
   * Restart recovery: a turn that is still running was opened before this process existed, so the
   * persisted delivery is the only record of who sent it. Without that record the run keeps its
   * ownership; only a delivery naming a different turn marks the active turn as the user's.
   */
  private recoveredOrigin(turnId: string | undefined, scheduledTurnId: string | undefined): TurnOrigin {
    return !turnId || !scheduledTurnId || turnId === scheduledTurnId ? "scheduler" : "user";
  }

  private async reconcile(workspaceId: string): Promise<void> {
    if (this.disposed) return;
    await this.service.reconcileExecutionTurns(workspaceId);
    await this.service.flushSessionMessages(workspaceId, async (message) => ({ accepted: true,
      ...await (this.runner.isActive?.(message.sessionId)
        ? this.runner.steer(message.sessionId, message.content, message.messageId)
        : this.runner.send(message.sessionId, message.content, message)) }));
    await this.service.refreshActions(workspaceId);
    const scheduler = await this.service.getScheduler(workspaceId);
    this.clearRetryTimer(workspaceId);
    for (const request of await this.service.listWorkRequests(workspaceId)) {
      if (request.status !== "cancelled" && request.control === "paused" && request.workerSessionId && this.runner.isActive?.(request.workerSessionId))
        await this.runner.interrupt(request.workerSessionId);
    }
    for (const item of await this.service.listWorkItems(workspaceId)) {
      if (!["closed", "cancelled"].includes(item.status) && item.run.control === "paused" && item.run.sessionId && this.runner.isActive?.(item.run.sessionId))
        await this.runner.interrupt(item.run.sessionId);
    }
    if (!scheduler.enabled) { await this.scheduleRetry(workspaceId); return; }
    await this.prepareRequests(workspaceId);
    await this.service.continueIntegrations(workspaceId);
    let actions = await this.service.listActions(workspaceId);
    // Completed actions can still have a final turn in flight. Keep the owner until it ends.
    for (const bound of [...this.runsBySession.values()].filter((b) => b.workspaceId === workspaceId && b.run.status === "running")) {
      const action = actions.find((a) => a.actionId === bound.actionId);
      if ((!action || !actionIsOpen(action) || action.status === "decision") && !this.active(bound.run.sessionId)) {
        await this.release(bound, "done", action?.status ?? "done");
      }
    }
    actions = await this.service.listActions(workspaceId);
    const requests = await this.service.listWorkRequests(workspaceId);
    for (const action of actions) {
      if (this.disposed) break;
      if (action.kind !== "execute" || !actionIsOpen(action) || (action.status === "decision" && action.control !== "manual")) continue;
      if (action.control === "manual" && action.sessionId && this.runner.isActive?.(action.sessionId) && !this.turnsBySession.has(action.sessionId))
        this.trackTurn(action.sessionId, { turnId: this.runner.getActiveTurnId?.(action.sessionId), origin: "user" });
      if (action.retryAt && Date.parse(action.retryAt) > Date.parse(this.now())) continue;
      const items = await this.service.listWorkItems(workspaceId);
      const item = items.find((i) => i.workItemId === action.workItemId);
      if (!item || !["queued", "running"].includes(item.status) || await this.service.isWorkItemBlocked(workspaceId, item.workItemId)) continue;
      if (action.control === "manual" || action.control === "paused") continue;
      const occupancy = await this.service.getExecutionOccupancy(workspaceId);
      const running = occupancy.workItems.filter((i) => i.workItemId !== item.workItemId);
      if (occupancy.sessionIds.filter((sessionId) => sessionId !== action.sessionId).length >= scheduler.maxWorkers || running.some((i) => effectiveNeeds(i).some((need) => effectiveNeeds(item).includes(need)))) continue;
      await this.dispatch(workspaceId, action);
    }
    await this.scheduleRetry(workspaceId);
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

  private async scheduleRetry(workspaceId: string): Promise<void> {
    const actions = await this.service.listActions(workspaceId);
    const requests = await this.service.listWorkRequests(workspaceId);
    const retryAt = [...actions.filter((a) => a.kind === "execute" && actionIsOpen(a) && a.status === "retry" && a.control !== "paused" && a.control !== "manual" && a.retryAt),
      ...requests.filter((request) => request.control !== "paused" && request.control !== "manual" && request.status !== "failed" && request.status !== "ready" && request.retryAt)]
      .map((a) => Date.parse(a.retryAt!)).filter((at) => at > Date.parse(this.now()));
    if (!this.disposed && retryAt.length) this.retryTimers.set(workspaceId, setTimeout(() => {
      this.retryTimers.delete(workspaceId);
      void this.enqueue(workspaceId, () => this.reconcile(workspaceId));
    }, Math.min(2_147_483_647, Math.max(1, Math.min(...retryAt) - Date.parse(this.now())))));
  }

  private active(sessionId: string): boolean {
    return this.settling.has(sessionId) || (this.runner.isActive?.(sessionId) ?? this.runsBySession.get(sessionId)?.run.status === "running");
  }

  private clearRetryTimer(workspaceId: string): void {
    const timer = this.retryTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(workspaceId);
  }

  private async dispatch(workspaceId: string, initial: Execution): Promise<void> {
    let action = (await this.service.listActions(workspaceId)).find((entry): entry is Execution => entry.kind === "execute" && entry.actionId === initial.actionId) ?? initial;
    if (action.control && action.control !== "auto") return;
    if (action.retryAt && action.retryAt > this.now()) return;
    if (action.deliveries?.some((message) => ["queued", "sending", "unknown"].includes(message.state))) return;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      let item = await this.service.getWorkItem(workspaceId, action.workItemId);
      const cwd = root;
      let sessionId = action.sessionId;
      const bound = sessionId ? this.runsBySession.get(sessionId) : undefined;
      if (sessionId && this.settling.has(sessionId)) return;
      const priorTurn = sessionId ? this.turnsBySession.get(sessionId) : undefined;
      const outstanding = !!priorTurn && priorTurn.origin === "scheduler" && !priorTurn.settled;
      // The user drives the session until they stop: a turn they opened is not a reason to deliver.
      const userOwnsSession = priorTurn?.origin === "user";
      // A returned submission belongs to the old turn until its completion has settled.
      if (bound?.run.status === "running" && outstanding &&
          (item.status === "queued" || (priorTurn!.turnId && !this.runner.isActive?.(sessionId!)))) return;
      if (sessionId && (!bound || bound.run.status !== "running")) {
        const role = await this.service.resolveWorkerRole(workspaceId);
        if (!await this.runner.resume(sessionId, { cwd, modelConfig: role.modelConfig, title: "Worker · " + item.title, metadata: { role: "worker", workItemId: item.workItemId, sourceSessionId: item.sourceSessionId, sourceTurnId: item.sourceTurnId, treeId: item.treeId } })) throw new Error("原执行会话无法恢复：" + sessionId);
      }
      if (!sessionId) {
        if (action.stage !== "open") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "open" }));
        const role = await this.service.resolveWorkerRole(workspaceId);
        if (action.forkSessionId && action.forkTurnId) {
          ({ sessionId } = await this.runner.fork({ workspaceId, sourceSessionId: action.forkSessionId, sourceTurnId: action.forkTurnId,
            modelConfig: role.modelConfig, title: "Worker · " + item.title,
            metadata: { role: "worker", workItemId: item.workItemId, sourceSessionId: item.sourceSessionId, sourceTurnId: item.sourceTurnId } }));
          if (!await this.runner.resume(sessionId, { cwd })) throw new Error("无法恢复工单分支");
        } else ({ sessionId } = await this.runner.open({ workspaceId, cwd, modelConfig: role.modelConfig,
          title: "Worker · " + item.title,
          metadata: { role: "worker", actionId: action.actionId, workItemId: item.workItemId } }));
        action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, sessionId, stage: "deliver", status: "running" }));
      }
      let run = bound?.run.status === "running" && bound.run.runId === action.runId ? bound.run
        : (await this.service.listRuns(workspaceId)).find((r) => r.runId === action.runId && r.sessionId === sessionId);
      if (!run || run.status !== "running") {
        run = await this.service.putRun(workspaceId, { runId: createId("run"), role: "worker",
          actionId: action.actionId, sessionId, workItemId: item.workItemId,
          status: "running", turns: 0, startedAt: this.now() });
        const runId = run.runId;
        action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, runId }));
      }
      const wasActive = this.runner.isActive?.(sessionId) ?? !!bound;
      this.runsBySession.set(sessionId, bound?.run.runId === run.runId ? bound : { workspaceId, actionId: action.actionId, run });
      const tracked = this.turnsBySession.get(sessionId);
      if (tracked && !tracked.settled) tracked.bound = this.runsBySession.get(sessionId);
      if (wasActive && !this.turnsBySession.has(sessionId)) {
        const turnId = this.runner.getActiveTurnId?.(sessionId);
        this.trackTurn(sessionId, { turnId, origin: this.recoveredOrigin(turnId, action.scheduledTurnId) });
      }
      const wasQueued = item.status === "queued";
      if (item.status === "queued") item = await this.service.startWorkItem(workspaceId, item.workItemId, { sessionId, heartbeatAt: this.now() });
      if (action.stage === "execute" && !wasQueued && (wasActive || userOwnsSession)) return;
      if (wasQueued && action.stage === "execute") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver", status: "pending" }));
      if (action.stage === "execute") {
        // Unknown engine history retains its identity for an explicit or subsequent reconciliation.
        return;
      }
      if (action.stage === "open") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver" }));
      if (action.pendingMessageId) return;
      const message = await this.actionMessage(workspaceId, action);
      let scheduledTurnId: string | undefined;
      const messageId = action.pendingMessageId ?? createId("message");
      action = await this.service.updateAction(workspaceId, action, (current) => ({ ...current,
        pendingMessageId: messageId, attemptId: current.attemptId ?? createId("attempt"), control: "auto" }));
      // Delivery is durable even when send throws. The same session and message are retried.
      try {
        if (wasActive) {
          const receipt = await this.service.dispatchSessionMessage({ sessionId, content: message, messageId, origin: "scheduler" },
            async (delivery) => ({ accepted: true, ...await this.runner.steer(sessionId, delivery.content, messageId) }));
          if (!receipt.accepted) return;
          scheduledTurnId = receipt.turnId;
          // Steering joins a turn that is already running, so no turn-start event names our message;
          // the receipt itself hands that turn to this run.
          if (receipt.delivery !== "started") {
            if (receipt.turnId) this.adoptTurn(sessionId, receipt.turnId);
          }
        } else {
          const receipt = await this.service.dispatchSessionMessage({ sessionId, content: message, messageId, origin: "scheduler" },
            async (delivery) => ({ accepted: true, ...await this.runner.send(sessionId, delivery.content, { messageId }) }));
          if (!receipt.accepted) return;
          scheduledTurnId = receipt.turnId;
        }
      } catch (error) {
        return;
      }
      // Sending may synchronously cause a decision/completion write: preserve its latest state.
      await this.service.updateAction(workspaceId, action, (latest) => {
        if (latest.sessionId !== sessionId || latest.attemptId !== (wasActive ? action.attemptId : messageId) || latest.control === "paused" || !actionIsOpen(latest)) return latest;
        const settled = { ...(scheduledTurnId ? { scheduledTurnId } : {}),
          ...(latest.stage === "deliver" && actionIsOpen(latest) && latest.status !== "decision"
            ? { status: "running" as const, stage: "execute" as const, failure: undefined, retryAt: undefined } : {}),
          deliveredAt: this.now(), pendingMessageId: undefined };
        // Only the notices this delivery carried are consumed; append-only writers keep the rest.
        return { ...latest, ...settled };
      });
    } catch (error) {
      await this.fail(workspaceId, action.actionId, error instanceof Error ? error.message : String(error));
    }
  }

  private async release(bound: WorkerBinding, status: "done" | "failed", note: string): Promise<void> {
    bound.run = { ...bound.run, status, note, endedAt: this.now() };
    await this.service.putRun(bound.workspaceId, bound.run);
  }

  private async fail(workspaceId: string, actionId: string, reason: string): Promise<void> {
    const action = (await this.service.listActions(workspaceId)).find((a) => a.actionId === actionId);
    const bound = [...this.runsBySession.values()].find((b) => b.workspaceId === workspaceId && b.actionId === actionId);
    if (bound) await this.release(bound, "failed", reason);
    if (action && actionIsOpen(action) && action.status !== "decision") await this.service.failAction(workspaceId, actionId, reason);
  }

  private async onTurn(bound: WorkerBinding, turn: WorkerTurn, finishReason: string, failure?: string): Promise<void> {
    const ownsExecution = () => this.turnsBySession.get(bound.run.sessionId) === turn && this.runsBySession.get(bound.run.sessionId) === bound;
    const result = turn.turnId ? await this.service.settleExecutionTurn(bound.workspaceId, bound.run.sessionId, turn.turnId,
      finishReason, failure, await this.completion(bound.workspaceId, bound.actionId)) : undefined;
    // Every turn settles its own run once, even when a newer turn already owns the execution.
    bound.run = result ? (await this.service.listRuns(bound.workspaceId)).find((run) => run.runId === bound.run.runId) ?? bound.run
      : { ...bound.run, turns: bound.run.turns + 1 };
    if (result && ownsExecution()) await this.release(bound, result.status, result.note);
    else await this.service.putRun(bound.workspaceId, bound.run);
  }

  private async completion(workspaceId: string, actionId: string): Promise<string> {
    const action = (await this.service.listActions(workspaceId)).find((entry) => entry.actionId === actionId);
    if (action?.kind === "execute" && action.integrationActionId) return "处理当前合入后执行 vermillion workItem.integration.complete " + JSON.stringify({
      workspaceId, workItemId: action.workItemId, actionId: action.integrationActionId, sessionId: action.sessionId
    }) + "；需要用户取舍时调用 decision.create。";
    return "完成后重新读取 workItem.get，将当前 contractRevision 传给 workItem.submit，并提交证据、review 和逐条验收；需要用户取舍时调用 decision.create。";
  }

  private async actionMessage(workspaceId: string, action: Execution): Promise<string> {
    const update = [action.failure ? "继续" : "", renderExecutionNotices(action.notices)].filter(Boolean).join("\n");
    if (action.integrationActionId) return [update, await this.completion(workspaceId, action.actionId)].filter(Boolean).join("\n");
    return update;
  }

  private async prepareRequests(workspaceId: string): Promise<void> {
    const scheduler = await this.service.getScheduler(workspaceId);
    for (let request of await this.service.listWorkRequests(workspaceId)) {
      if (["ready", "failed", "cancelled"].includes(request.status) || request.control === "paused" || request.control === "manual") continue;
      if (request.retryAt && request.retryAt > this.now()) continue;
      if (request.pendingMessageId) continue;
      const existingActivePreparation = Boolean(request.workerSessionId && this.runner.isActive?.(request.workerSessionId));
      if (!existingActivePreparation) {
        const occupancy = await this.service.getExecutionOccupancy(workspaceId);
        if (occupancy.sessionIds.filter((sessionId) => sessionId !== request.workerSessionId).length >= scheduler.maxWorkers) continue;
      }
      if (!request.workerSessionId && this.runner.isActive?.(request.sourceSessionId)) continue;
      try {
        const root = await this.service.workspaceRoot(workspaceId);
        const preparation = await this.roles.resolve(root, "work-preparation");
        const latest = (await this.service.listWorkRequests(workspaceId)).find((entry) => entry.requestId === request.requestId);
        if (!latest || latest.status === "cancelled") continue;
        request = latest;
        if (!request.workerSessionId) {
          const fork = request.sourceTurnId ? await this.runner.fork({ workspaceId, sourceSessionId: request.sourceSessionId,
            sourceTurnId: request.sourceTurnId, modelConfig: preparation.modelConfig,
            title: "开工准备", metadata: { role: "work-preparation", requestId: request.requestId,
              sourceSessionId: request.sourceSessionId, sourceTurnId: request.sourceTurnId } })
            : { sessionId: request.sourceSessionId, treeId: request.sourceSessionId };
          request = await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => current.status === "cancelled" || current.control !== "auto" ? current : ({ ...current, status: "preparing", workerSessionId: fork.sessionId, treeId: fork.treeId }));
          if (request.status === "cancelled") continue;
        }
        const sessionId = request.workerSessionId!;
        if (this.preparing.has(sessionId)) continue;
        if (this.runner.isActive?.(sessionId)) { this.preparing.set(sessionId, workspaceId); continue; }
        if (request.activeTurnId) {
          continue;
        }
        if (!request.failure && (await this.service.listWorkItems(workspaceId)).some((item) => item.run.sessionId === sessionId)) {
          if (!this.runner.isActive?.(sessionId)) await this.service.finishPreparation(workspaceId, sessionId);
          else this.preparing.set(sessionId, workspaceId);
          continue;
        }
        if (request.sourceTurnId && !await this.runner.resume(sessionId, { cwd: root })) throw new Error("无法恢复准备分支");
        this.preparing.set(sessionId, workspaceId);
        const messageId = createId("prep-message");
        request = await this.service.updateWorkRequest(workspaceId, request.requestId, (current) => current.status === "cancelled" || current.control !== "auto" ? current : ({ ...current, pendingMessageId: messageId,
          attemptId: current.attemptId ?? createId("attempt"), activeTurnId: undefined }));
        if (request.status === "cancelled" || request.control !== "auto") { this.preparing.delete(sessionId); continue; }
        const content = request.deliveries?.some((entry) => entry.state === "accepted")
          ? ["继续当前准备，保留已有工单与文档成果。", request.waitReason ?? request.failure,
            "requestId: " + request.requestId, "完成后调用 work.prepare.complete 登记完整交接。"].filter(Boolean).join("\n")
          : [request.message?.content, preparation.content,
          "workspaceId: " + workspaceId, "sessionId: " + sessionId, "requestId: " + request.requestId,
          "sourceSessionId: " + request.sourceSessionId, request.sourceTurnId ? "sourceTurnId: " + request.sourceTurnId : "",
          "开工范围: " + (request.scope ?? "根据当前讨论确定完整范围。"),
          "建单与目录登记完成后，必须调用 vermillion work.prepare.complete --help，并用当前 requestId、sessionId、全部 workItemIds 及相关文档 refs 登记完整交接；仅回复文字不算准备完成。",
          request.failure ? "上次准备未完成：" + request.failure : ""].filter(Boolean).join("\n\n");
        const receipt = await this.service.dispatchSessionMessage({ ...request.message, sessionId, content, messageId, origin: "scheduler" },
          async (delivery) => ({ accepted: true, ...await this.runner.send(sessionId, delivery.content,
            request.message ? { attachments: request.message.attachments, execution: request.message.execution, messageId } : { messageId }) }));
        if (!receipt.accepted) { this.preparing.delete(sessionId); continue; }
        await this.service.confirmPreparationDelivery(workspaceId, request.requestId, messageId, receipt?.turnId, true, request.workerSessionId, request.attemptId);
      } catch (error) {
        if (request.workerSessionId) this.preparing.delete(request.workerSessionId);
        const reason = error instanceof Error ? error.message : String(error);
        if (request.pendingMessageId) await this.service.markPreparationDeliveryUnknown(workspaceId, request.requestId, request.pendingMessageId, reason);
        else await this.service.failWorkRequest(workspaceId, request.requestId, reason);
      }
    }
  }

  /** The pending notices already sit on the record; this only decides when to hand them over. */
  private async deliverUpdate(workspaceId: string, workItemId: string, sessionId: string): Promise<void> {
    const item = await this.service.getWorkItem(workspaceId, workItemId);
    const action = (await this.service.listActions(workspaceId)).find((a) => a.kind === "execute" && a.workItemId === workItemId && actionIsOpen(a));
    if (await this.service.isWorkItemBlocked(workspaceId, workItemId)) {
      // The service persists the waiting condition before this event. Stop work on the old contract.
      await this.runner.interrupt(sessionId);
    } else if (action?.kind === "execute" && item.status === "running") {
      await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver", status: "pending", idleTurns: 0 }));
    }
    await this.reconcile(workspaceId);
  }

}
