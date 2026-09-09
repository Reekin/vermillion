import { effectiveNeeds, actionIsOpen, type AgentRun, type Execution, type WorkItem, type WorkMessage, type RoleExecutionOverrides } from "./contracts.js";
import type { RoleService } from "./roles.js";
import type { WorkbenchService } from "./workbench-service.js";

/** What the orchestrator needs from the session engine. Implemented in Electron main over SessionShellService. */
export type AgentRunner = {
  /** Resolves the session's latest turn; undefined means a verified empty session. */
  resolveSourceTurn?: (sessionId: string) => Promise<string | undefined>;
  fork: (input: { workspaceId: string; sourceSessionId: string; sourceTurnId: string; developerInstructions?: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string; treeId?: string }>;
  open: (input: { workspaceId: string; cwd: string; developerInstructions: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string }>;
  send: (sessionId: string, content: string, options?: Omit<WorkMessage, "content">) => Promise<void>;
  /** Delivers into the running turn when there is one (returns its id), otherwise as the next message (returns undefined). */
  steer: (sessionId: string, content: string) => Promise<{ turnId?: string }>;
  interrupt: (sessionId: string) => Promise<void>;
  /** Loads an existing session so it can receive messages again. Resolves false when the session cannot be opened. */
  resume: (sessionId: string, options?: { cwd?: string; developerInstructions?: string; modelConfig?: RoleExecutionOverrides; metadata?: Record<string, unknown>; title?: string }) => Promise<boolean>;
  /** Requests unsubscribe of an idle worker; preserves its history and permits native idle unloading. */
  release: (sessionId: string) => Promise<void>;
  /** True while the runtime is executing a turn, including tool/model waits. */
  isActive?: (sessionId: string) => boolean;
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
      } else if (event.type === "workItem.cancelled" && event.sessionId) {
        const sessionId = event.sessionId;
        void this.enqueue(event.workspaceId, async () => { await this.runner.interrupt(sessionId); await this.service.releaseIdleWorkers(event.workspaceId); await this.reconcile(event.workspaceId); });
      }
    }));
    this.disposers.push(this.runner.onTurnCompleted((event) => {
      const bound = this.runsBySession.get(event.sessionId);
      if (bound) void this.enqueue(bound.workspaceId, async () => {
        await this.service.workerTurnCompleted(bound.workspaceId, event.sessionId);
        await this.onTurn(bound, event.finishReason, event.failure, event.turnId);
        await this.service.releaseIdleWorkers(bound.workspaceId);
      });
      const preparingWorkspace = this.preparing.get(event.sessionId);
      if (preparingWorkspace) void this.enqueue(preparingWorkspace, async () => {
        this.preparing.delete(event.sessionId);
        const request = (await this.service.listWorkRequests(preparingWorkspace)).find((entry) => entry.workerSessionId === event.sessionId && entry.status === "preparing");
        const items = await this.service.listWorkItems(preparingWorkspace);
        if (request && (event.finishReason !== "completed" || !items.some((item) => item.requestId === request.requestId)))
          await this.service.failWorkRequest(preparingWorkspace, request.requestId, event.failure ?? "准备轮未完成工单登记，请核对当前准备进度并继续。");
        else await this.service.finishPreparation(preparingWorkspace, event.sessionId, event.turnId);
        await this.reconcile(preparingWorkspace);
      });
      void this.service.listWorkspaces().then((workspaces) => {
        for (const workspace of workspaces) void this.enqueue(workspace.workspaceId, async () => {
          if (workspace.workspaceId !== bound?.workspaceId) {
            await this.service.workerTurnCompleted(workspace.workspaceId, event.sessionId);
            await this.service.releaseIdleWorkers(workspace.workspaceId);
          }
          await this.reconcile(workspace.workspaceId);
        });
      });
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
    for (const bound of [...this.runsBySession.values()].filter((b) => b.workspaceId === workspaceId)) {
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
    return this.runner.isActive?.(sessionId) ?? this.runsBySession.has(sessionId);
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
      if (sessionId && !bound) {
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
      let run = (await this.service.listRuns(workspaceId)).find((r) => r.runId === action.runId && r.sessionId === sessionId);
      if (!run || run.status !== "running") {
        run = await this.service.putRun(workspaceId, { runId: createId("run"), role: "worker",
          actionId: action.actionId, sessionId, workItemId: item.workItemId,
          status: "running", turns: 0, startedAt: this.now() });
        const runId = run.runId;
        action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, runId }));
      }
      const wasActive = this.runner.isActive?.(sessionId) ?? !!bound;
      this.runsBySession.set(sessionId, { workspaceId, actionId: action.actionId, run });
      if (item.status === "queued") item = await this.service.startWorkItem(workspaceId, item.workItemId, { sessionId, heartbeatAt: this.now() });
      if (action.stage === "execute" && wasActive) return;
      if (action.stage === "execute") {
        // An unbound inactive execute stage is a restart recovery, not evidence of failure.
        action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver", status: "pending",
          message: action.message + "\n会话已恢复。核对当前成果与持久化处置结果，继续尚未完成的动作。" }));
      }
      if (action.stage === "open") action = await this.service.updateAction(workspaceId, action, (action) => ({ ...action, stage: "deliver" }));
      const message = await this.actionMessage(workspaceId, action, cwd);
      // Delivery is durable even when send throws. The same session and message are retried.
      if (wasActive) {
        const { turnId } = await this.runner.steer(sessionId, message);
        if (item && turnId) await this.service.setWorkItemStaleTurn(workspaceId, item.workItemId, turnId);
      } else await this.runner.send(sessionId, message);
      // Sending may synchronously cause a decision/completion write: preserve its latest state.
      await this.service.updateAction(workspaceId, action, (latest) => latest.message === action.message && latest.stage === "deliver" && actionIsOpen(latest) && latest.status !== "decision"
        ? { ...latest, status: "running", stage: "execute", message: "", failure: undefined, deliveredAt: this.now(), retryAt: undefined } : latest);
    } catch (error) {
      await this.fail(workspaceId, action.actionId, error instanceof Error ? error.message : String(error));
    }
  }

  private async release(bound: WorkerBinding, status: "done" | "failed", note: string): Promise<void> {
    this.runsBySession.delete(bound.run.sessionId);
    await this.service.putRun(bound.workspaceId, { ...bound.run, status, note, endedAt: this.now() });
  }

  private async fail(workspaceId: string, actionId: string, reason: string): Promise<void> {
    const action = (await this.service.listActions(workspaceId)).find((a) => a.actionId === actionId);
    const bound = [...this.runsBySession.values()].find((b) => b.workspaceId === workspaceId && b.actionId === actionId);
    if (bound) await this.release(bound, "failed", reason);
    if (action && actionIsOpen(action) && action.status !== "decision") await this.service.failAction(workspaceId, actionId, reason);
  }

  private async onTurn(bound: WorkerBinding, finishReason: string, failure?: string, turnId?: string): Promise<void> {
    const { workspaceId, actionId } = bound;
    bound.run = { ...bound.run, turns: bound.run.turns + 1 };
    const action = (await this.service.listActions(workspaceId)).find((a) => a.actionId === actionId);
    const item = bound.run.role === "worker" && bound.run.workItemId ? await this.service.getWorkItem(workspaceId, bound.run.workItemId) : undefined;
    if (item && item.run.staleTurnId && item.run.staleTurnId === turnId) await this.service.setWorkItemStaleTurn(workspaceId, item.workItemId, undefined);
    if (!action || action.kind !== "execute" || !actionIsOpen(action) || action.status === "decision") {
      await this.release(bound, "done", action?.status ?? "done");
    } else if (action.kind === "execute" && item?.status !== "running") {
      await this.service.finishAction(workspaceId, actionId, "工单已进入 " + item?.status);
      await this.release(bound, "done", "已交接");
    } else if (finishReason !== "completed") {
      await this.fail(workspaceId, actionId, "turn " + finishReason + (failure ? ": " + failure : ""));
    } else if (action.stage === "deliver") {
      await this.release(bound, "done", "待送达后续消息");
    } else if (action.idleTurns >= this.maxIdleTurns) {
      await this.fail(workspaceId, actionId, "连续未落实处置：" + this.completion());
    } else {
      if (item) await this.service.heartbeatWorkItem(workspaceId, item.workItemId);
      await this.service.updateAction(workspaceId, action, (action) => ({ ...action, idleTurns: action.idleTurns + 1, stage: "deliver", status: "pending",
        message: action.message + "\n尚未落实处置。请执行：" + this.completion() }));
      await this.release(bound, "done", "要求落实具体动作");
    }
    await this.reconcile(workspaceId);
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
    return "完成后调用 workItem.submit 提交证据、review 和逐条验收；需要用户取舍时调用 decision.create。";
  }

  private async workerRole(root: string) {
    const [worker, reviewer, verifier] = await Promise.all(["worker", "reviewer", "verifier"].map((role) => this.roles.resolve(root, role)));
    return { ...worker!, content: worker!.content + "\n\n## reviewer subagent prompt（spawn 时原样传入，并附工单与 diff）\n" + reviewer!.content +
      "\n\n## verifier subagent prompt（spawn 时原样传入，并附 acceptance、refs 与 diff）\n" + verifier!.content };
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
      if (request.status === "ready" || request.status === "failed") continue;
      if (request.retryAt && request.retryAt > this.now()) continue;
      if (!request.workerSessionId && this.runner.isActive?.(request.sourceSessionId)) continue;
      try {
        const root = await this.service.workspaceRoot(workspaceId);
        const preparation = await this.roles.resolve(root, "work-preparation");
        if (!request.workerSessionId) {
          const fork = request.sourceTurnId ? await this.runner.fork({ workspaceId, sourceSessionId: request.sourceSessionId,
            sourceTurnId: request.sourceTurnId, modelConfig: preparation.modelConfig,
            title: "开工准备", metadata: { role: "work-preparation", requestId: request.requestId,
              sourceSessionId: request.sourceSessionId, sourceTurnId: request.sourceTurnId } })
            : { sessionId: request.sourceSessionId, treeId: request.sourceSessionId };
          request = await this.service.putWorkRequest(workspaceId, { ...request, status: "preparing", workerSessionId: fork.sessionId, treeId: fork.treeId });
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
