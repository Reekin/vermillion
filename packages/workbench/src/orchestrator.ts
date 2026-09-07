import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { latestRevision, actionIsOpen, type Mission, type AgentRun, type WorkflowAction, type WorkItem, type RoleExecutionOverrides } from "./contracts.js";
import { STATE_DIR } from "./docs.js";
import type { RoleService } from "./roles.js";
import type { WorkbenchService } from "./workbench-service.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;

/** What the orchestrator needs from the session engine. Implemented in Electron main over SessionShellService. */
export type AgentRunner = {
  open: (input: { workspaceId: string; cwd: string; developerInstructions: string; modelConfig?: RoleExecutionOverrides; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string }>;
  send: (sessionId: string, content: string) => Promise<void>;
  /** Delivers into the running turn when there is one (returns its id), otherwise as the next message (returns undefined). */
  steer: (sessionId: string, content: string) => Promise<{ turnId?: string }>;
  interrupt: (sessionId: string) => Promise<void>;
  /** Loads an existing session so it can receive messages again. Resolves false when the session cannot be opened. */
  resume: (sessionId: string) => Promise<boolean>;
  /** True while the runtime is executing a turn, including tool/model waits. */
  isActive?: (sessionId: string) => boolean;
  /** Text of the last assistant message in the session, if any. */
  lastReply: (sessionId: string) => string | undefined;
  /** All assistant messages of the session's latest turn, in order. */
  turnMessages: (sessionId: string) => string[];
  /** Offers a tool to sessions whose metadata.role matches; handler receives the calling session id. */
  registerTool: (tool: { role: string; name: string; description: string; inputSchema: unknown; handle: (args: Record<string, unknown>, callerSessionId: string) => Promise<string> }) => void;
  onTurnCompleted: (listener: (event: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed"; failure?: string }) => void) => () => void;
};

export type OrchestratorOptions = {
  service: WorkbenchService;
  roles: RoleService;
  runner: AgentRunner;
  now?: () => string;
  /** Worker turns without status progress before the item is requeued. */
  maxIdleTurns?: number;
  /** How often a mission with running workers gets a supervisor patrol. */
  patrolIntervalMs?: number;
};

type WorkerBinding = { workspaceId: string; run: AgentRun; actionId: string };
const createId = (prefix: string): string => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

/** One durable dispatch/recovery path for all responsibility owners. */
export class Orchestrator {
  private readonly service: WorkbenchService;
  private readonly roles: RoleService;
  private readonly runner: AgentRunner;
  private readonly now: () => string;
  private readonly maxIdleTurns: number;
  private readonly patrolIntervalMs: number;
  private readonly disposers: Array<() => void> = [];
  private readonly patrols = new Map<string, { workspaceId: string; timer: NodeJS.Timeout; busy: boolean }>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly runsBySession = new Map<string, WorkerBinding>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(options: OrchestratorOptions) {
    this.service = options.service;
    this.roles = options.roles;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxIdleTurns = options.maxIdleTurns ?? 3;
    this.patrolIntervalMs = options.patrolIntervalMs ?? 4 * 60_000;
    this.runner.registerTool({ role: "supervisor", name: "remind", description: "提醒正在执行的 Worker 回到工单范围。",
      inputSchema: { type: "object", properties: { workItemId: { type: "string" }, message: { type: "string" } }, required: ["workItemId", "message"], additionalProperties: false },
      handle: (args) => this.remind(String(args.workItemId ?? ""), String(args.message ?? "")) });
  }

  start(): void {
    this.disposed = false;
    this.disposers.push(this.service.setRecoveryHandler((workspaceId) => this.enqueue(workspaceId, () => this.reconcile(workspaceId))));
    this.disposers.push(this.service.subscribe((event) => {
      if (!("workspaceId" in event)) return;
      if (event.type === "workItem.updated") {
        void this.enqueue(event.workspaceId, () => this.deliverUpdate(event.workspaceId, event.workItemId, event.sessionId, event.note));
      } else if (["actions.changed", "workItems.changed", "missions.changed", "decisions.changed", "scheduler.changed"].includes(event.type)) {
        void this.enqueue(event.workspaceId, () => this.reconcile(event.workspaceId));
      } else if (event.type === "workItem.cancelled" && event.sessionId) {
        const sessionId = event.sessionId;
        void this.enqueue(event.workspaceId, async () => { await this.runner.interrupt(sessionId); await this.reconcile(event.workspaceId); });
      }
    }));
    this.disposers.push(this.runner.onTurnCompleted((event) => {
      const bound = this.runsBySession.get(event.sessionId);
      if (bound) void this.enqueue(bound.workspaceId, () => this.onTurn(bound, event.finishReason, event.failure, event.turnId));
    }));
    void this.service.listWorkspaces().then((workspaces) => {
      for (const workspace of workspaces) void this.enqueue(workspace.workspaceId, () => this.reconcile(workspace.workspaceId));
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const patrol of this.patrols.values()) clearInterval(patrol.timer);
    this.patrols.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private enqueue(workspaceId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(workspaceId) ?? Promise.resolve()).then(() => this.disposed ? undefined : task());
    this.queues.set(workspaceId, next.catch((error) => console.error("[orchestrator]", workspaceId, error)));
    // The recovery RPC receives the actual failure; event callers have the logged queue catch.
    return next;
  }

  private async reconcile(workspaceId: string): Promise<void> {
    await this.service.refreshActions(workspaceId);
    const scheduler = await this.service.getScheduler(workspaceId);
    this.clearRetryTimer(workspaceId);
    if (!scheduler.enabled) return;
    await this.service.continueIntegrations(workspaceId);
    let actions = await this.service.listActions(workspaceId);
    // Completed actions can still have a final turn in flight. Keep the owner until it ends.
    for (const bound of [...this.runsBySession.values()].filter((b) => b.workspaceId === workspaceId)) {
      const action = actions.find((a) => a.actionId === bound.actionId);
      if ((!action || !actionIsOpen(action) || action.status === "decision" || action.status === "waiting") && !this.active(bound.run.sessionId)) {
        await this.release(bound, "done", action?.status ?? "done");
      }
    }
    await this.settleMissions(workspaceId);
    actions = await this.service.listActions(workspaceId);
    const claimed = new Set<string>();
    for (const action of actions) {
      if (action.role === "workbench" || !actionIsOpen(action) || action.status === "decision" || action.status === "waiting") continue;
      if (claimed.has(action.ownerKey)) continue;
      const occupying = [...this.runsBySession.values()].find((b) => b.workspaceId === workspaceId &&
        actions.some((a) => a.actionId === b.actionId && a.ownerKey === action.ownerKey));
      if (occupying && occupying.actionId !== action.actionId) continue;
      claimed.add(action.ownerKey);
      if (action.retryAt && Date.parse(action.retryAt) > Date.parse(this.now())) continue;
      if (action.role === "worker") {
        const items = await this.service.listWorkItems(workspaceId);
        const item = items.find((i) => i.workItemId === action.workItemIds[0]);
        if (!item || await this.service.isWorkItemBlocked(workspaceId, item.workItemId)) continue;
        const running = items.filter((i) => i.status === "running" && i.workItemId !== item.workItemId);
        if (running.length >= scheduler.maxWorkers || running.some((i) => i.needs.some((need) => item.needs.includes(need)))) continue;
      }
      await this.dispatch(workspaceId, action);
    }
    actions = await this.service.listActions(workspaceId);
    const retryAt = actions.filter((a) => actionIsOpen(a) && a.status === "retry" && a.retryAt)
      .map((a) => Date.parse(a.retryAt!)).filter((at) => at > Date.parse(this.now()));
    if (retryAt.length) this.retryTimers.set(workspaceId, setTimeout(() => {
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

  private async dispatch(workspaceId: string, initial: WorkflowAction): Promise<void> {
    let action = initial;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      let item = action.role === "worker" ? await this.service.getWorkItem(workspaceId, action.workItemIds[0]!) : undefined;
      let cwd = item?.run.worktreePath ?? root;
      if (item && action.stage === "worktree") {
        if (item.scope.allowedPaths.length && !item.run.worktreePath) {
          // The action already records the worktree stage before any external operation.
          action = await this.service.putAction(workspaceId, { ...action, status: "running" });
          const branch = item.run.branch ?? "vermillion/" + item.workItemId;
          const worktreePath = join(root, STATE_DIR, "worktrees", item.workItemId);
          await mkdir(join(root, STATE_DIR, "worktrees"), { recursive: true });
          const entries = (await git(root, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
          const existing = entries.map((entry) => entry.split("\0")).find((fields) => fields.some((field) => field.startsWith("worktree ") && resolve(field.slice(9)) === resolve(worktreePath)));
          if (existing) {
            if (!existing.includes("branch refs/heads/" + branch)) throw new Error("Worktree target belongs to a different branch: " + worktreePath);
          } else await git(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
          item = await this.service.patchWorkItemRun(workspaceId, item.workItemId, { worktreePath, branch });
          cwd = worktreePath;
        }
        action = await this.service.putAction(workspaceId, { ...action, status: "running", stage: "open" });
      }
      let sessionId = action.sessionId;
      const bound = sessionId ? this.runsBySession.get(sessionId) : undefined;
      if (sessionId && !bound) {
        // A thrown resume is a stage failure. Only a definitive false permits replacing the session.
        if (!await this.runner.resume(sessionId)) {
          sessionId = undefined;
          action = await this.service.putAction(workspaceId, { ...action, sessionId: undefined, runId: undefined, stage: "open" });
        }
      }
      if (!sessionId) {
        if (action.stage !== "open") action = await this.service.putAction(workspaceId, { ...action, stage: "open" });
        const previous = [...await this.service.listActions(workspaceId)].reverse().find((a) => a.actionId !== action.actionId && a.ownerKey === action.ownerKey && a.sessionId);
        const candidate = item?.run.sessionId ?? previous?.sessionId;
        if (candidate && await this.runner.resume(candidate)) sessionId = candidate;
        else {
          const role = await this.roles.resolve(root, action.role === "workbench" ? "worker" : action.role);
          let developerInstructions = role.content;
          if (action.role === "worker") {
            const [reviewer, verifier] = await Promise.all([this.roles.resolve(root, "reviewer"), this.roles.resolve(root, "verifier")]);
            developerInstructions += "\n\n## reviewer subagent prompt（spawn 时原样传入，并附工单与 diff）\n" + reviewer.content +
              "\n\n## verifier subagent prompt（spawn 时原样传入，并附 acceptance、refs 与 diff）\n" + verifier.content;
          }
          ({ sessionId } = await this.runner.open({ workspaceId, cwd, developerInstructions, modelConfig: role.modelConfig,
            title: action.role + " · " + (item?.title ?? action.missionId ?? workspaceId),
            metadata: { role: action.role, actionId: action.actionId, workItemId: item?.workItemId ?? action.workItemIds[0], missionId: action.missionId } }));
        }
        action = await this.service.putAction(workspaceId, { ...action, sessionId, stage: "deliver", status: "running" });
      }
      let run = (await this.service.listRuns(workspaceId)).find((r) => r.runId === action.runId && r.sessionId === sessionId);
      if (!run || run.status !== "running") {
        run = await this.service.putRun(workspaceId, { runId: createId("run"), role: action.role === "workbench" ? "worker" : action.role,
          actionId: action.actionId, sessionId, workItemId: item?.workItemId ?? action.workItemIds[0], missionId: action.missionId,
          revision: action.revision, closureKey: action.closureKey, status: "running", turns: 0, startedAt: this.now() });
        action = await this.service.putAction(workspaceId, { ...action, runId: run.runId });
      }
      const wasActive = this.runner.isActive?.(sessionId) ?? !!bound;
      this.runsBySession.set(sessionId, { workspaceId, actionId: action.actionId, run });
      if (item && item.status === "queued") item = await this.service.startWorkItem(workspaceId, item.workItemId, { ...item.run, sessionId, heartbeatAt: this.now() });
      else if (item && item.run.sessionId !== sessionId) item = await this.service.patchWorkItemRun(workspaceId, item.workItemId, { sessionId });
      if (item) this.ensurePatrol(workspaceId, item.missionId ?? item.workItemId);
      if (action.stage === "execute" && wasActive) return;
      if (action.stage === "execute") {
        // An unbound inactive execute stage is a restart recovery, not evidence of failure.
        action = await this.service.putAction(workspaceId, { ...action, stage: "deliver", status: "pending",
          message: action.message + "\n会话已恢复。核对当前成果与持久化处置结果，继续尚未完成的动作。" });
      }
      if (action.stage === "open") action = await this.service.putAction(workspaceId, { ...action, stage: "deliver" });
      const message = await this.actionMessage(workspaceId, action, cwd);
      // Delivery is durable even when send throws. The same session and message are retried.
      if (wasActive) {
        const { turnId } = await this.runner.steer(sessionId, message);
        if (item && turnId) await this.service.setWorkItemStaleTurn(workspaceId, item.workItemId, turnId);
      } else await this.runner.send(sessionId, message);
      // Sending may synchronously cause a decision/completion write: preserve its latest state.
      const current = (await this.service.listActions(workspaceId)).find((a) => a.actionId === action.actionId)!;
      if (current.message === action.message && current.stage === "deliver" && actionIsOpen(current) && current.status !== "decision") {
        await this.service.putAction(workspaceId, { ...current, status: "running", stage: "execute", deliveredAt: this.now(), retryAt: undefined });
        if (item?.run.resumeMessage) await this.service.patchWorkItemRun(workspaceId, item.workItemId, { resumeMessage: undefined });
      }
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
    if (!action || !actionIsOpen(action) || action.status === "decision" || action.status === "waiting") {
      await this.release(bound, "done", action?.status ?? "done");
    } else if (action.kind === "execute" && item?.status !== "running") {
      await this.service.finishAction(workspaceId, actionId, "工单已进入 " + item?.status);
      await this.release(bound, "done", "已交接");
    } else if (finishReason !== "completed") {
      await this.fail(workspaceId, actionId, "turn " + finishReason + (failure ? ": " + failure : ""));
    } else if (action.kind === "revision") {
      await this.service.finishAction(workspaceId, actionId, this.runner.lastReply(bound.run.sessionId)?.slice(0, 400) ?? "已处理 revision");
      await this.release(bound, "done", "已处理 revision");
    } else if (action.stage === "deliver") {
      await this.release(bound, "done", "待送达后续消息");
    } else if (action.idleTurns >= this.maxIdleTurns) {
      await this.fail(workspaceId, actionId, "连续未落实处置：" + this.completion(action));
    } else {
      if (item) await this.service.heartbeatWorkItem(workspaceId, item.workItemId);
      await this.service.putAction(workspaceId, { ...action, idleTurns: action.idleTurns + 1, stage: "deliver", status: "pending",
        message: action.message + "\n尚未落实处置。请执行：" + this.completion(action) });
      await this.release(bound, "done", "要求落实具体动作");
    }
    await this.reconcile(workspaceId);
  }

  /** Persist one closure notification per snapshot; only the steward can finish the mission. */
  private async settleMissions(workspaceId: string): Promise<void> {
    if (!(await this.service.getScheduler(workspaceId)).enabled) return;
    const [missions, items, runs, actions] = await Promise.all([this.service.listMissions(workspaceId), this.service.listWorkItems(workspaceId), this.service.listRuns(workspaceId), this.service.listActions(workspaceId)]);
    for (const mission of missions.filter((m) => m.status === "active")) {
      const own = items.filter((i) => i.missionId === mission.missionId);
      const related = (mission.relatedWorkItemIds ?? []).map((id) => items.find((i) => i.workItemId === id));
      if (!own.length && !related.length) continue;
      const stewards = runs.filter((r) => r.role === "steward" && r.missionId === mission.missionId);
      if (stewards.some((r) => r.status === "running") || !this.stewarded(mission, stewards)) continue;
      const stewardship = actions.filter((a) => a.ownerKey === "steward:" + mission.missionId);
      if (stewardship.some(actionIsOpen)) continue;
      const allEnded = own.every((i) => i.status === "closed" || i.status === "cancelled");
      if (!allEnded && !related.length) continue;
      const revision = latestRevision(mission);
      const closureKey = JSON.stringify([revision, own.map((i) => [i.workItemId, i.status]), related.map((i, index) => [mission.relatedWorkItemIds![index], i?.status])]);
      const lastClosure = stewardship.filter((a) => a.closureKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        ?? stewards.filter((r) => r.closureKey).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (lastClosure?.closureKey === closureKey) continue;
      const describe = (item: WorkItem) => ({ workItemId: item.workItemId, missionId: item.missionId, title: item.title, objective: item.objective, status: item.status, refs: item.refs, evidence: item.evidence, verify: item.verify, decisions: item.decisions });
      const message = [
        "任务收尾判断请求：" + mission.title,
        "workspaceId: " + workspaceId,
        "missionId: " + mission.missionId,
        "任务摘要: " + mission.summary,
        "revision: " + JSON.stringify(revision),
        "本任务工单全部结束: " + allEnded,
        "本任务工单与执行结果: " + JSON.stringify(own.map(describe)),
        "已登记承接工单与执行结果: " + JSON.stringify(related.filter((i): i is WorkItem => Boolean(i)).map(describe)),
        "已保存的结果说明: " + (mission.resultSummary ?? ""),
        "其他任务工单索引（供核实承接工作）: " + JSON.stringify(items.filter((i) => i.missionId && i.missionId !== mission.missionId).map((i) => ({ workItemId: i.workItemId, missionId: i.missionId, title: i.title, status: i.status }))),
        "任务保持进行中，等待管家按角色职责判断。"
      ].join("\n");
      await this.service.createAction(workspaceId, { kind: "revision", role: "steward", ownerKey: "steward:" + mission.missionId,
        missionId: mission.missionId, closureKey, workItemIds: [], status: "pending", stage: "open", message });
    }
  }

  /**
   * Whether a steward run has taken the mission's latest revision. Revisions can share a commit (appending without
   * doc changes points at HEAD again), so the run must also postdate the revision; a running run holding the commit
   * counts because new revisions are steered into it.
   */
  private stewarded(mission: Mission, stewards: AgentRun[]): boolean {
    const latest = latestRevision(mission);
    return stewards.some((r) => r.revision === latest.commit && (r.status === "running" || (r.endedAt ?? r.startedAt) >= latest.at));
  }


  private async relatedSessionContext(workspaceId: string, owner: { missionId?: string; workItemId?: string }): Promise<string> {
    const [missions, runs] = await Promise.all([
      owner.missionId ? this.service.listMissions(workspaceId) : Promise.resolve([]),
      this.service.listRuns(workspaceId)
    ]);
    const mission = missions.find((entry) => entry.missionId === owner.missionId);
    return [
      ...((mission?.revisions ?? []).flatMap((revision) => revision.sessionId
        ? [`设计伙伴 sessionId: ${revision.sessionId}（revision: ${revision.commit}）`] : [])),
      ...[...new Set(runs.filter((run) => run.role === "steward" &&
        (owner.missionId ? run.missionId === owner.missionId : !!owner.workItemId && run.workItemId === owner.workItemId))
        .map((run) => run.sessionId))].map((sessionId) => `管家 sessionId: ${sessionId}`)
    ].join("\n");
  }

  private async workerMessage(workspaceId: string, item: WorkItem, cwd: string): Promise<string> {
    const root = await this.service.workspaceRoot(workspaceId);
    const isolated = item.scope.allowedPaths.length > 0;
    const branch = item.run.branch;
    const related = await this.relatedSessionContext(workspaceId, item);
    const prior = [
      ...(item.run.resumeMessage ? [item.run.resumeMessage] : []),
      ...item.rejections.map((r) => "用户打回：" + r.reason),
      ...item.decisions.map((d) => "已决策：" + d),
      ...(item.run.lastFailure ? ["上次运行失败：" + item.run.lastFailure] : [])
    ];
    return [
      "你负责工单「" + item.title + "」。",
      "workspaceId: " + workspaceId,
      "workItemId: " + item.workItemId,
      related,
      "工作目录: " + cwd + (isolated ? "（独立 worktree，分支 " + branch + "）" : "（workspace 根目录，不开分支）"),
      ...(isolated ? [
        "workspace 根目录（只读主分支）: " + root,
        "提交前先在自己的分支提交 allowedPaths 内的成果，再用 git -C " + JSON.stringify(root) + " rev-parse HEAD 读取主分支当前 SHA，在本 worktree 执行 git rebase <该 SHA>。不要修改或合并主分支。",
        "rebase 冲突在自己的分支解决并继续；基于 rebase 后的结果做 review 和验收。workItem.submit 前再次读取主分支 HEAD，若已前进则重复 rebase 并更新受影响的验证和提交材料。"
      ] : []),
      "",
      "先用 CLI 读取完整工单：vermillion workItem.get '" + JSON.stringify({ workspaceId, workItemId: item.workItemId }) + "'",
      ...(prior.length ? ["", "历史记录：", ...prior.map((p) => "- " + p)] : []),
      "",
      "完成后必须调用 workItem.submit，需要用户决定时调用 decision.create，发现依赖另一张未合入的工单时调用 workItem.defer，合同与现实对不上时调用 workItem.escalate（workspaceId、workItemId、message）；调用后结束会话。"
    ].join("\n");
  }

  private completion(action: WorkflowAction): string {
    if (action.closureKey) return "按角色职责判断任务收尾；需要变更任务状态时实际调用 mission.setStatus。完成本次判断后回复摘要，任务不会因回复而自动完成。";
    switch (action.kind) {
      case "contract": return 'workItem.update 带 resolution:{actionId:"' + action.actionId + '",disposition:"updated"|"clarified",reason:"具体处置依据"}；updated 必须实际修改 requiredChanges 指定的合同字段，改标题、引用或仅写 note 不算解决。也可 workItem.cancel；需要用户取舍时 decision.create 关联 actionId 和自己的 sessionId。';
      case "dependency": return "workItem.update 调整 dependsOn 或 workItem.cancel；需要用户取舍时 decision.create 关联 actionId 和自己的 sessionId。登记的前置未关闭时保持等待。";
      case "repair": return 'workspace.repair.submit {workspaceId,actionId,sessionId,summary,evidence:[string]}，由工作台检查恢复条件；需要用户授权时 decision.create 关联 actionId 和自己的 sessionId。';
      case "execute": return "完成后调用 workItem.submit 提交 evidence、review 处置和 verify；需要用户决定时 decision.create 关联 actionId 和自己的 sessionId，依赖未合入工单时 workItem.defer，合同不符时 workItem.escalate。调用后结束本轮。";
      default: return "读取任务 revision 和现有工单，完成本次任务安排后回复摘要。";
    }
  }

  private async actionMessage(workspaceId: string, action: WorkflowAction, cwd: string): Promise<string> {
    const items = (await this.service.listWorkItems(workspaceId)).filter((item) => action.workItemIds.includes(item.workItemId));
    const context = [
      "workspaceId: " + workspaceId, "actionId: " + action.actionId, "sessionId: " + action.sessionId,
      "当前动作: " + action.kind, action.message,
      ...(action.failure ? ["上次失败: " + action.failure] : []),
      "读取当前处置与关联决定：vermillion action.list '" + JSON.stringify({ workspaceId }) + "'",
      "vermillion decision.list '" + JSON.stringify({ workspaceId }) + "'",
      this.completion(action)
    ];
    if (action.role === "worker" && items[0]) return [await this.workerMessage(workspaceId, items[0], cwd), ...context].join("\n");
    context.push(await this.relatedSessionContext(workspaceId, { missionId: action.missionId, workItemId: action.workItemIds[0] }));
    if (action.role === "workspace-repair") context.push(
      "工作目录（主工作区）: " + cwd,
      "只处理主工作区故障，不修改产品功能，不替 Worker 解决分支业务代码冲突，不发布部署。保留他人未提交改动与成果，不覆盖、删除、提交或 stash；归属不明需授权时发决策卡。",
      "受影响工单及成果: " + JSON.stringify(items)
    );
    else {
      if (!action.missionId) context.push("这是独立工单，保持无 Mission。处理原单合同，不重新拆单或补建 Mission。");
      context.push("原工单合同、已有决定、成果位置: " + JSON.stringify(items));
      if (action.requiredChanges) context.push("requiredChanges: " + action.requiredChanges.join(", "));
      context.push("仅回复文字或保存答复不解除阻塞。通过持久化工单动作处置，不与 Worker 自由对话。合同与依赖调整落实前暂停 Worker 执行与提交。");
      if (action.kind === "revision" && action.missionId && !action.closureKey) {
        const mission = (await this.service.listMissions(workspaceId)).find((m) => m.missionId === action.missionId);
        if (mission) {
          const index = mission.revisions.map((r) => r.commit).lastIndexOf(action.revision!);
          const revision = mission.revisions[index] ?? latestRevision(mission);
          const previous = mission.revisions[index - 1];
          const range = previous ? [previous.commit, revision.commit] : [revision.commit + "^", revision.commit];
          context.push("任务: " + JSON.stringify(mission), "现有工单: " + JSON.stringify((await this.service.listWorkItems(workspaceId)).filter((i) => i.missionId === mission.missionId)),
            "按需读取完整 diff: git diff " + range.join(" ") + " -- " + revision.paths.map((p) => JSON.stringify(p)).join(" "));
          context.push(await git(cwd, ["diff", "--stat", ...range, "--", ...revision.paths]).catch(() => "无法生成 diff stat，请按 revision 读取文档。"));
        }
      }
    }
    return context.join("\n");
  }

  private async deliverUpdate(workspaceId: string, workItemId: string, sessionId: string, note: string): Promise<void> {
    const item = await this.service.getWorkItem(workspaceId, workItemId);
    const action = (await this.service.listActions(workspaceId)).find((a) => a.kind === "execute" && a.workItemIds.includes(workItemId) && actionIsOpen(a));
    if (await this.service.isWorkItemBlocked(workspaceId, workItemId)) {
      // The service persists the waiting condition before this event. Stop work on the old contract.
      await this.runner.interrupt(sessionId);
    } else if (action && item.status === "running") {
      await this.service.putAction(workspaceId, { ...action, stage: "deliver", status: "pending", idleTurns: 0,
        message: "工单已调整：" + note + "\n立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。" });
    }
    await this.reconcile(workspaceId);
  }

  // ---- supervisor ----

  private ensurePatrol(workspaceId: string, groupId: string): void {
    if (this.patrols.has(groupId)) return;
    // Not enqueued: a patrol waits on a model turn and must not block scheduling for that workspace.
    const timer = setInterval(() => { void this.patrol(workspaceId, groupId).catch((error) => console.error("[orchestrator] patrol", groupId, error instanceof Error ? error.message : error)); }, this.patrolIntervalMs);
    this.patrols.set(groupId, { workspaceId, timer, busy: false });
  }

  private stopPatrol(groupId: string): void {
    const patrol = this.patrols.get(groupId);
    if (!patrol) return;
    clearInterval(patrol.timer);
    this.patrols.delete(groupId);
  }

  private workersInGroup(workspaceId: string, groupId: string): WorkerBinding[] {
    return [...this.runsBySession.values()].filter((b) => b.workspaceId === workspaceId && b.run.role === "worker" && (b.run.missionId ?? b.run.workItemId) === groupId);
  }

  /**
   * One fresh supervisor session looks at every running worker of the group: contract, this turn's agent messages,
   * diff stat and out-of-scope paths. It nudges a worker through the remind tool; the session is archived afterwards.
   */
  private async patrol(workspaceId: string, groupId: string): Promise<void> {
    const patrolState = this.patrols.get(groupId);
    const workers = this.workersInGroup(workspaceId, groupId);
    if (workers.length === 0) {
      this.stopPatrol(groupId);
      return;
    }
    if (!patrolState || patrolState.busy) return;
    patrolState.busy = true;
    try {
      const root = await this.service.workspaceRoot(workspaceId);
      const sections: string[] = [];
      for (const bound of workers) {
        const item = await this.service.getWorkItem(workspaceId, bound.run.workItemId!).catch(() => undefined);
        if (!item || item.status !== "running") continue;
        const cwd = item.run.worktreePath ?? root;
        const stat = (await git(cwd, ["diff", "--stat", "HEAD"]).catch(() => "")).trim();
        const changed = await git(cwd, ["diff", "--name-only", "HEAD"]).catch(() => "");
        const outside = item.scope.allowedPaths.length
          ? changed.split("\n").filter(Boolean).filter((p) => !item.scope.allowedPaths.some((allowed) => p.startsWith(allowed.replace(/\*+$/, "").replace(/\/$/, ""))))
          : [];
        const messages = this.runner.turnMessages(bound.run.sessionId);
        sections.push([
          "### 工单「" + item.title + "」 workItemId: " + item.workItemId,
          "objective: " + item.objective,
          "allowedPaths: " + (item.scope.allowedPaths.join(", ") || "(无限制)"),
          "acceptance: " + item.acceptance.map((a, i) => (i + 1) + ") " + a.text).join("; "),
          "越界路径: " + (outside.length ? outside.join(", ") : "无"),
          "diff --stat:",
          stat || "(无改动)",
          "",
          "本轮 agent 消息（" + messages.length + " 条）：",
          ...messages.map((m, i) => (i + 1) + ". " + m.slice(0, 1500)),
        ].join("\n"));
      }
      if (sections.length === 0) return;
      const mission = (await this.service.listMissions(workspaceId)).find((m) => m.missionId === groupId);
      const { content, modelConfig } = await this.roles.resolve(root, "supervisor");
      const { sessionId } = await this.runner.open({
        workspaceId,
        cwd: root,
        developerInstructions: content,
        modelConfig,
        title: "Supervisor · " + (mission?.title ?? groupId),
        metadata: { role: "supervisor", missionId: mission?.missionId }
      });
      const run = await this.service.putRun(workspaceId, { runId: createId("run"), role: "supervisor", sessionId, missionId: mission?.missionId, status: "running", turns: 0, startedAt: this.now() });
      const done = new Promise<void>((resolve) => {
        const off = this.runner.onTurnCompleted((e) => { if (e.sessionId === sessionId) { off(); resolve(); } });
      });
      await this.runner.send(sessionId, [
        "巡视任务「" + (mission?.title ?? groupId) + "」，当前 " + sections.length + " 个 Worker 在进行中。",
        "",
        ...sections,
        "",
        "对偏离的 Worker 调用 remind 工具；都正常就回复一行“无事”。"
      ].join("\n\n"));
      await done;
      await this.service.putRun(workspaceId, { ...run, status: "done", turns: 1, note: (this.runner.lastReply(sessionId) ?? "").slice(0, 200), endedAt: this.now() });
    } finally {
      patrolState.busy = false;
    }
  }

  private async remind(workItemId: string, message: string): Promise<string> {
    const bound = [...this.runsBySession.values()].find((b) => b.run.role === "worker" && b.run.workItemId === workItemId);
    if (!bound) throw new Error("没有正在进行的 Worker 持有工单 " + workItemId);
    if (!message.trim()) throw new Error("message 不能为空");
    await this.runner.steer(bound.run.sessionId, "Supervisor 提醒：" + message.trim());
    return "已提醒 " + workItemId;
  }
}
