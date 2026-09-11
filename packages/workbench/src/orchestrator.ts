import { effectiveNeeds, actionIsOpen, type AgentRun, type Execution, type WorkItem, type WorkMessage, type RoleExecutionOverrides } from "./contracts.js";
import type { RoleService } from "./roles.js";
import type { WorkbenchService } from "./workbench-service.js";

/** What the orchestrator needs from the session engine. Implemented in Electron main over SessionShellService. */
export type AgentRunner = {
  /** Resolves the session's latest turn; undefined means a verified empty session. */
  resolveSourceTurn?: (sessionId: string) => Promise<string | undefined>;
  fork: (input: { workspaceId: string; sourceSessionId: string; sourceTurnId: string; developerInstructions?: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string; treeId?: string }>;
  open: (input: { workspaceId: string; cwd: string; developerInstructions: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string }>;
  send: (sessionId: string, content: string, options?: Omit<WorkMessage, "content">) => Promise<void | { turnId?: string }>;
  /** Delivers into the running turn when there is one (returns its id), otherwise as the next message (returns undefined). */
  steer: (sessionId: string, content: string) => Promise<{ turnId?: string }>;
  interrupt: (sessionId: string) => Promise<void>;
  /** Loads an existing session so it can receive messages again. Resolves false when the session cannot be opened. */
  resume: (sessionId: string, options?: { cwd?: string; developerInstructions?: string; modelConfig?: RoleExecutionOverrides; metadata?: Record<string, unknown>; title?: string }) => Promise<boolean>;
  /** Requests unsubscribe of an idle worker; preserves its history and permits native idle unloading. */
  release: (sessionId: string) => Promise<void>;
  /** True while the runtime is executing a turn, including tool/model waits. */
  isActive?: (sessionId: string) => boolean;
  getActiveTurnId?: (sessionId: string) => string | undefined;
  onTurnStarted?: (listener: (event: { sessionId: string; turnId: string }) => void) => () => void;
  onTurnCompleted: (listener: (event: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed"; failure?: string }) => void) => () => void;
};

export type OrchestratorOptions = {
  service: WorkbenchService;
  roles: RoleService;
  runner: AgentRunner;
  now?: () => string;
  /** Worker turns without status progress before the item is requeued. */
  maxIdleTurns?: number;
  cleanupIntervalMs?: number;
};

type WorkerBinding = { workspaceId: string; run: AgentRun; actionId: string };
type WorkerTurn = { turnId?: string; scheduled: boolean; settled?: boolean; bound?: WorkerBinding };
const createId = (prefix: string): string => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
// A replacement orchestrator takes ownership only after the previous generation's in-flight task drains.
const workspaceQueues = new Map<string, Promise<void>>();

/** Resumes each item's execution and drains workspace integration checkpoints. */
export class Orchestrator {
  private readonly service: WorkbenchService;
  private readonly roles: RoleService;
  private readonly runner: AgentRunner;
  private readonly now: () => string;
  private readonly maxIdleTurns: number;
  private readonly cleanupIntervalMs: number;
  private readonly disposers: Array<() => void> = [];
  private readonly runsBySession = new Map<string, WorkerBinding>();
  private readonly turnsBySession = new Map<string, WorkerTurn>();
  private readonly unsettledTurns = new Map<string, Set<WorkerTurn>>();
  private readonly settling = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly preparing = new Map<string, string>();
  private disposed = false;

  constructor(options: OrchestratorOptions) {
    this.service = options.service;
    this.roles = options.roles;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxIdleTurns = options.maxIdleTurns ?? 3;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60_000;

  }

  start(): void {
    this.disposed = false;
    this.disposers.push(this.service.setWorkerActiveChecker((sessionId) => this.active(sessionId)));
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
    this.disposers.push(this.service.subscribe((event) => {
      if (!("workspaceId" in event)) return;
      if (event.type === "workItem.updated") {
        void this.enqueue(event.workspaceId, () => this.deliverUpdate(event.workspaceId, event.workItemId, event.sessionId, event.note));
      } else if (["actions.changed", "workItems.changed", "workRequests.changed", "decisions.changed", "scheduler.changed"].includes(event.type)) {
        void this.enqueue(event.workspaceId, () => this.reconcile(event.workspaceId));
      } else if (event.type === "workRequest.cancelled") {
        const sessionId = event.sessionId;
        void this.enqueue(event.workspaceId, async () => {
          if (sessionId) {
            const wasPreparing = this.preparing.get(sessionId) === event.workspaceId;
            this.preparing.delete(sessionId);
            if (wasPreparing || this.runner.isActive?.(sessionId)) await this.runner.interrupt(sessionId);
          }
          await this.service.releaseIdleWorkers(event.workspaceId);
          await this.reconcile(event.workspaceId);
        });
      } else if (event.type === "workItem.cancelled" && event.sessionId) {
        const sessionId = event.sessionId;
        void this.enqueue(event.workspaceId, async () => { await this.runner.interrupt(sessionId); await this.service.releaseIdleWorkers(event.workspaceId); await this.reconcile(event.workspaceId); });
      }
    }));
    if (this.runner.onTurnStarted) this.disposers.push(this.runner.onTurnStarted((event) => {
      if (this.turnsBySession.get(event.sessionId)?.turnId === event.turnId) return;
      this.trackTurn(event.sessionId, { turnId: event.turnId, scheduled: false });
    }));
    this.disposers.push(this.runner.onTurnCompleted((event) => {
      // Install the barrier synchronously: a queued reconcile may run before this event is processed.
      this.settling.set(event.sessionId, (this.settling.get(event.sessionId) ?? 0) + 1);
      void this.settleTurn(event).catch((error) => console.error("[orchestrator] turn completion", event.sessionId, event.turnId, error));
    }));
    void this.service.listWorkspaces().then((workspaces) => {
      for (const workspace of workspaces) void this.enqueue(workspace.workspaceId, async () => {
        await this.service.releaseIdleWorkers(workspace.workspaceId);
        await this.reconcile(workspace.workspaceId);
      });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.allSettled([...workspaceQueues.values()]);
  }

  private enqueue(workspaceId: string, task: () => Promise<void>): Promise<void> {
    const next = (workspaceQueues.get(workspaceId) ?? Promise.resolve()).then(() => this.disposed ? undefined : task());
    const drained = next.catch((error) => console.error("[orchestrator]", workspaceId, error)).finally(() => {
      if (workspaceQueues.get(workspaceId) === drained) workspaceQueues.delete(workspaceId);
    });
    workspaceQueues.set(workspaceId, drained);
    return next;
  }

  private async settleTurn(event: Parameters<Parameters<AgentRunner["onTurnCompleted"]>[0]>[0]): Promise<void> {
    const turn = [...(this.unsettledTurns.get(event.sessionId) ?? [])].find((turn) => !turn.turnId || turn.turnId === event.turnId);
    const bound = turn?.bound;
    const workspaces = await this.service.listWorkspaces();
    try {
      await Promise.all(workspaces.map(({ workspaceId }) => this.enqueue(workspaceId, async () => {
        await this.service.workerTurnCompleted(workspaceId, event.sessionId);
        if (bound?.workspaceId === workspaceId && turn && !turn.settled) {
          await this.onTurn(bound, turn, event.finishReason, event.failure);
          turn.settled = true;
          this.unsettledTurns.get(event.sessionId)?.delete(turn);
        }
        if (this.preparing.get(event.sessionId) === workspaceId &&
            (!turn?.turnId || turn.turnId === event.turnId) && this.turnsBySession.get(event.sessionId) === turn) {
          this.preparing.delete(event.sessionId);
          const request = (await this.service.listWorkRequests(workspaceId)).find((entry) => entry.workerSessionId === event.sessionId && entry.status === "preparing");
          const items = await this.service.listWorkItems(workspaceId);
          if (request && (event.finishReason !== "completed" || !items.some((item) => item.requestId === request.requestId)))
            await this.service.failWorkRequest(workspaceId, request.requestId, event.failure ?? "准备轮未完成工单登记，请核对当前准备进度并继续。");
          else await this.service.finishPreparation(workspaceId, event.sessionId, event.turnId);
        }
      })));
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

  private async reconcile(workspaceId: string): Promise<void> {
    if (this.disposed) return;
    await this.prepareRequests(workspaceId);
    await this.service.refreshActions(workspaceId);
    const scheduler = await this.service.getScheduler(workspaceId);
    this.clearRetryTimer(workspaceId);
    if (!scheduler.enabled) { await this.scheduleRetry(workspaceId); return; }
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
    for (const action of actions) {
      if (this.disposed) break;
      if (action.kind !== "execute" || !actionIsOpen(action) || action.status === "decision") continue;
      if (action.retryAt && Date.parse(action.retryAt) > Date.parse(this.now())) continue;
      const items = await this.service.listWorkItems(workspaceId);
      const item = items.find((i) => i.workItemId === action.workItemId);
      if (!item || !["queued", "running"].includes(item.status) || await this.service.isWorkItemBlocked(workspaceId, item.workItemId)) continue;
      const running = items.filter((i) => i.status === "running" && i.workItemId !== item.workItemId);
      if (running.length >= scheduler.maxWorkers || running.some((i) => effectiveNeeds(i).some((need) => effectiveNeeds(item).includes(need)))) continue;
      await this.dispatch(workspaceId, action);
    }
    await this.scheduleRetry(workspaceId);
  }

  private async scheduleRetry(workspaceId: string): Promise<void> {
    const actions = await this.service.listActions(workspaceId);
    const requests = await this.service.listWorkRequests(workspaceId);
    const retryAt = [...actions.filter((a) => actionIsOpen(a) && a.status === "retry" && a.retryAt),
      ...requests.filter((request) => request.status !== "failed" && request.status !== "ready" && request.retryAt)]
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
    let action = initial;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      let item = await this.service.getWorkItem(workspaceId, action.workItemId);
      const cwd = root;
      let sessionId = action.sessionId;
      const bound = sessionId ? this.runsBySession.get(sessionId) : undefined;
      if (sessionId && this.settling.has(sessionId)) return;
      const priorTurn = sessionId ? this.turnsBySession.get(sessionId) : undefined;
      // A returned submission belongs to the old turn until its completion has settled.
      if (bound?.run.status === "running" && priorTurn?.scheduled && !priorTurn.settled &&
          (item.status === "queued" || (priorTurn.turnId && !this.runner.isActive?.(sessionId!)))) return;
      if (sessionId && (!bound || bound.run.status !== "running")) {
        const role = await this.workerRole(root);
        if (!await this.runner.resume(sessionId, { cwd, developerInstructions: role.content, modelConfig: role.modelConfig, title: "Worker · " + item.title, metadata: { role: "worker", workItemId: item.workItemId, sourceSessionId: item.sourceSessionId, sourceTurnId: item.sourceTurnId, treeId: item.treeId } })) throw new Error("原执行会话无法恢复：" + sessionId);
      }
      if (!sessionId) {
        if (action.stage !== "open") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "open" }));
        const role = await this.workerRole(root);
        const developerInstructions = role.content;
        if (action.forkSessionId && action.forkTurnId) {
          ({ sessionId } = await this.runner.fork({ workspaceId, sourceSessionId: action.forkSessionId, sourceTurnId: action.forkTurnId,
            developerInstructions, modelConfig: role.modelConfig, title: "Worker · " + item.title,
            metadata: { role: "worker", workItemId: item.workItemId, sourceSessionId: item.sourceSessionId, sourceTurnId: item.sourceTurnId } }));
          if (!await this.runner.resume(sessionId, { cwd })) throw new Error("无法恢复工单分支");
        } else ({ sessionId } = await this.runner.open({ workspaceId, cwd, developerInstructions, modelConfig: role.modelConfig,
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
        this.trackTurn(sessionId, {
          turnId, scheduled: !turnId || !action.scheduledTurnId || turnId === action.scheduledTurnId
        });
      }
      const wasQueued = item.status === "queued";
      if (item.status === "queued") item = await this.service.startWorkItem(workspaceId, item.workItemId, { sessionId, heartbeatAt: this.now() });
      if (action.stage === "execute" && !wasQueued && (wasActive || priorTurn?.scheduled === false)) return;
      if (wasQueued && action.stage === "execute") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver", status: "pending" }));
      if (action.stage === "execute") {
        // An unbound inactive execute stage is a restart recovery, not evidence of failure.
        action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver", status: "pending",
          message: action.message + "\n会话已恢复。核对当前成果与持久化处置结果，继续尚未完成的动作。" }));
      }
      if (action.stage === "open") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver" }));
      const message = await this.actionMessage(workspaceId, action, cwd);
      let scheduledTurnId: string | undefined;
      // Delivery is durable even when send throws. The same session and message are retried.
      if (wasActive) {
        const before = this.turnsBySession.get(sessionId);
        const { turnId } = await this.runner.steer(sessionId, message);
        const turn = this.turnsBySession.get(sessionId);
        if (!turnId && turn && turn !== before) {
          turn.scheduled = true;
          scheduledTurnId = turn.turnId;
        }
      } else {
        const before = this.turnsBySession.get(sessionId);
        const sent = await this.runner.send(sessionId, message);
        const turn = this.turnsBySession.get(sessionId);
        const turnId = sent?.turnId ?? (turn !== before ? turn?.turnId : undefined) ?? this.runner.getActiveTurnId?.(sessionId);
        if (!turn || turn === before) this.trackTurn(sessionId, { turnId, scheduled: true });
        else if (turn.turnId === turnId) turn.scheduled = true;
        scheduledTurnId = turnId;
      }
      // Sending may synchronously cause a decision/completion write: preserve its latest state.
      await this.service.updateAction(workspaceId, action, (latest) => ({
        ...latest,
        ...(scheduledTurnId ? { scheduledTurnId } : {}),
        ...(latest.message === action.message && latest.stage === "deliver" && actionIsOpen(latest) && latest.status !== "decision"
          ? { status: "running" as const, stage: "execute" as const, message: "", failure: undefined, retryAt: undefined } : {}),
        deliveredAt: this.now()
      }));
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
    const result = bound.run.workItemId ? await this.service.settleWorkerTurn(bound.workspaceId, bound.run.workItemId, {
      ownsExecution, turnId: turn.turnId, scheduled: turn.scheduled, finishReason, failure, maxIdleTurns: this.maxIdleTurns, completion: this.completion()
    }) : undefined;
    // Every turn settles its own run once, even when a newer turn already owns the execution.
    bound.run = { ...bound.run, turns: bound.run.turns + 1 };
    if (result && ownsExecution()) await this.release(bound, result.status, result.note);
    else await this.service.putRun(bound.workspaceId, bound.run);
  }

  private async workerMessage(workspaceId: string, item: WorkItem, cwd: string): Promise<string> {
    const root = await this.service.workspaceRoot(workspaceId);
    const isolated = !!item.run.worktreePath;
    const branch = item.run.branch;
    const related = "sourceSessionId: " + (item.sourceSessionId ?? "") + "\nsourceTurnId: " + (item.sourceTurnId ?? "");
    return [
      "你负责工单「" + item.title + "」。",
      "workspaceId: " + workspaceId,
      "workItemId: " + item.workItemId,
      "contractRevision: " + item.contractRevision,
      related,
      "会话 cwd: " + cwd,
      "工作目录: " + (item.run.worktreePath ?? root) + (isolated ? "（独立 worktree，分支 " + branch + "）" : "（workspace 根目录，不开分支）"),
      ...(isolated ? [
        "会话 cwd 保持 workspace 根目录。操作本工单文件时显式指定工具 workdir、git -C 或 worktree 内的绝对路径。",
        "workspace 根目录（只读主分支）: " + root,
        "提交前先在自己的分支提交 allowedPaths 内的成果，再用 git -C " + JSON.stringify(root) + " rev-parse HEAD 读取主分支当前 SHA，在本 worktree 执行 git rebase <该 SHA>。不要修改或合并主分支。",
        "rebase 冲突在自己的分支解决并继续；基于 rebase 后的结果做 review 和验收。workItem.submit 前再次读取主分支 HEAD，若已前进则重复 rebase 并更新受影响的验证和提交材料。"
      ] : []),
      "",
      "先用 CLI 读取完整工单：vermillion workItem.get '" + JSON.stringify({ workspaceId, workItemId: item.workItemId }) + "'",
      "",
      "完成后必须调用 workItem.submit，需要用户决定时调用 decision.create，发现依赖另一张未合入的工单时通过 workItem.update 修改 dependsOn，需要用户取舍时直接创建决策卡；调用后结束会话。"
    ].join("\n");
  }

  private completion(): string {
    return "完成后重新读取 workItem.get，将当前 contractRevision 传给 workItem.submit，并提交证据、review 和逐条验收；需要用户取舍时调用 decision.create。";
  }

  private async workerRole(root: string) {
    const [worker, reviewer, verifier] = await Promise.all(["worker", "reviewer", "verifier"].map((role) => this.roles.resolve(root, role)));
    const roleBlock = (role: "reviewer" | "verifier", resolved: typeof reviewer): string => [
      `## ${role} subagent prompt（spawn 时原样传入，并附工单与 diff）`,
      resolved.content,
      `## ${role} subagent model configuration（JSON；单独传给 spawn_agent）`,
      JSON.stringify(resolved.modelConfig ?? {})
    ].join("\n");
    return { ...worker!, content: [worker!.content, roleBlock("reviewer", reviewer), roleBlock("verifier", verifier)].join("\n\n") };
  }

  private async actionMessage(workspaceId: string, action: Execution, cwd: string): Promise<string> {
    const update = [action.message.trim(), action.failure].filter(Boolean).join("\n");
    if (action.deliveredAt) return update;
    const item = await this.service.getWorkItem(workspaceId, action.workItemId);
    return [await this.workerMessage(workspaceId, item, cwd), "sessionId: " + action.sessionId,
      "actionId: " + action.actionId, update].filter(Boolean).join("\n");
  }

  private async prepareRequests(workspaceId: string): Promise<void> {
    for (let request of await this.service.listWorkRequests(workspaceId)) {
      if (["ready", "failed", "cancelled"].includes(request.status)) continue;
      if (request.retryAt && request.retryAt > this.now()) continue;
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
          request = await this.service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: fork.sessionId, treeId: fork.treeId });
          if (request.status === "cancelled") continue;
        }
        const sessionId = request.workerSessionId!;
        if (this.preparing.has(sessionId)) continue;
        if (this.runner.isActive?.(sessionId)) { this.preparing.set(sessionId, workspaceId); continue; }
        if (!request.failure && (await this.service.listWorkItems(workspaceId)).some((item) => item.run.sessionId === sessionId)) {
          if (!this.runner.isActive?.(sessionId)) await this.service.finishPreparation(workspaceId, sessionId);
          else this.preparing.set(sessionId, workspaceId);
          continue;
        }
        if (request.sourceTurnId && !await this.runner.resume(sessionId, { cwd: root })) throw new Error("无法恢复准备分支");
        this.preparing.set(sessionId, workspaceId);
        await this.runner.send(sessionId, [request.message?.content, preparation.content,
          "workspaceId: " + workspaceId, "sessionId: " + sessionId, "requestId: " + request.requestId,
          "sourceSessionId: " + request.sourceSessionId, request.sourceTurnId ? "sourceTurnId: " + request.sourceTurnId : "",
          "开工范围: " + (request.scope ?? "根据当前讨论确定完整范围。"),
          request.failure ? "上次准备未完成：" + request.failure : ""].filter(Boolean).join("\n\n"),
          request.message ? { attachments: request.message.attachments, execution: request.message.execution } : undefined);
      } catch (error) {
        if (request.workerSessionId) this.preparing.delete(request.workerSessionId);
        await this.service.failWorkRequest(workspaceId, request.requestId, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async deliverUpdate(workspaceId: string, workItemId: string, sessionId: string, note: string): Promise<void> {
    const item = await this.service.getWorkItem(workspaceId, workItemId);
    const action = (await this.service.listActions(workspaceId)).find((a) => a.kind === "execute" && a.workItemId === workItemId && actionIsOpen(a));
    if (await this.service.isWorkItemBlocked(workspaceId, workItemId)) {
      // The service persists the waiting condition before this event. Stop work on the old contract.
      await this.runner.interrupt(sessionId);
    } else if (action?.kind === "execute" && item.status === "running") {
      await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver", status: "pending", idleTurns: 0,
        message: "工单已调整：" + note + "\n立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。" }));
    }
    await this.reconcile(workspaceId);
  }

}
