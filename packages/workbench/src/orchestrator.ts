import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { latestRevision, type AgentRun, type Mission, type WorkItem, type RoleExecutionOverrides } from "./contracts.js";
import { DOCS_DIR, STATE_DIR } from "./docs.js";
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
  /** Text of the last assistant message in the session, if any. */
  lastReply: (sessionId: string) => string | undefined;
  /** All assistant messages of the session's latest turn, in order. */
  turnMessages: (sessionId: string) => string[];
  /** Offers a tool to sessions whose metadata.role matches; handler receives the calling session id. */
  registerTool: (tool: { role: string; name: string; description: string; inputSchema: unknown; handle: (args: Record<string, unknown>, callerSessionId: string) => Promise<string> }) => void;
  onTurnCompleted: (listener: (event: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed" }) => void) => () => void;
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

type WorkerBinding = { workspaceId: string; run: AgentRun; idleTurns: number };

const createId = (prefix: string): string => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

/**
 * Event-driven loops over the workbench: steward (mission revision -> work items), scheduler (queued work item -> worker
 * session), supervisor (per worker turn). Sessions are opened through AgentRunner; all state lives in the workbench files,
 * so a restart resumes from what is on disk.
 */
export class Orchestrator {
  private readonly service: WorkbenchService;
  private readonly roles: RoleService;
  private readonly runner: AgentRunner;
  private readonly now: () => string;
  private readonly maxIdleTurns: number;
  private readonly patrolIntervalMs: number;
  private readonly disposers: Array<() => void> = [];
  /** Per patrol group (mission id, or work item id for standalone items): timer + in-flight flag. */
  private readonly patrols = new Map<string, { workspaceId: string; timer: NodeJS.Timeout; busy: boolean }>();
  /** Serializes work per workspace so two events do not schedule the same item twice. */
  private readonly queues = new Map<string, Promise<void>>();
  /** sessionId -> run, for sessions opened in this process. */
  private readonly runsBySession = new Map<string, WorkerBinding>();

  constructor(options: OrchestratorOptions) {
    this.service = options.service;
    this.roles = options.roles;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxIdleTurns = options.maxIdleTurns ?? 3;
    this.patrolIntervalMs = options.patrolIntervalMs ?? 4 * 60_000;
    this.runner.registerTool({
      role: "supervisor",
      name: "remind",
      description: "把一句提醒插进指定 Worker 正在进行的一轮里，把它拉回工单范围。只在确实偏离时调用。",
      inputSchema: { type: "object", properties: { workItemId: { type: "string" }, message: { type: "string" } }, required: ["workItemId", "message"], additionalProperties: false },
      handle: (args) => this.remind(String(args.workItemId ?? ""), String(args.message ?? ""))
    });
  }

  start(): void {
    this.disposers.push(
      this.service.subscribe((event) => {
        if (!("workspaceId" in event)) return;
        if (event.type === "missions.changed" || event.type === "scheduler.changed") this.enqueue(event.workspaceId, () => this.reconcile(event.workspaceId));
        else if (event.type === "workItems.changed") this.enqueue(event.workspaceId, async () => { await this.settleMissions(event.workspaceId); await this.schedule(event.workspaceId); });
        else if (event.type === "decisions.changed") this.enqueue(event.workspaceId, () => this.schedule(event.workspaceId));
        else if (event.type === "runs.changed") this.enqueue(event.workspaceId, () => this.settleMissions(event.workspaceId));
        else if (event.type === "workItem.updated") this.enqueue(event.workspaceId, () => this.steerWorker(event.sessionId, event.note));
        else if (event.type === "workItem.cancelled") this.enqueue(event.workspaceId, () => this.onCancelled(event.workspaceId, event.workItemId, event.sessionId, event.dependants));
      }),
      this.runner.onTurnCompleted((event) => {
        const bound = this.runsBySession.get(event.sessionId);
        if (bound) this.enqueue(bound.workspaceId, () => this.onTurn(bound.workspaceId, bound.run, event.finishReason));
      })
    );
    void this.service.listWorkspaces().then((workspaces) => {
      for (const workspace of workspaces) this.enqueue(workspace.workspaceId, () => this.reconcile(workspace.workspaceId));
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const patrol of this.patrols.values()) clearInterval(patrol.timer);
    this.patrols.clear();
  }

  private enqueue(workspaceId: string, task: () => Promise<void>): void {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(task).catch((error) => {
      console.error("[orchestrator]", workspaceId, error instanceof Error ? error.message : error);
    });
    this.queues.set(workspaceId, next);
  }

  /** Runs whatever the files say is pending: unprocessed revisions, then queued items. Also the restart entry point. */
  private async reconcile(workspaceId: string): Promise<void> {
    await this.settleMissions(workspaceId);
    const scheduler = await this.service.getScheduler(workspaceId);
    if (!scheduler.enabled) return;
    await this.recoverStaleRuns(workspaceId);
    await this.steward(workspaceId);
    await this.schedule(workspaceId);
  }

  /**
   * Runs recorded as running but not owned by this process were cut off by a restart. Their sessions are persistent, so
   * the agent is resumed with its full context and told to carry on; only when the session cannot be opened does the
   * work item go back to the queue for a fresh worker.
   */
  private async recoverStaleRuns(workspaceId: string): Promise<void> {
    for (const run of await this.service.listRuns(workspaceId)) {
      if (run.status !== "running" || this.runsBySession.has(run.sessionId)) continue;
      if (run.role === "supervisor") {
        // Stateless per turn; a new one is opened when next needed.
        await this.service.putRun(workspaceId, { ...run, status: "done", note: "进程重启", endedAt: this.now() });
        continue;
      }
      const item = run.workItemId ? await this.service.getWorkItem(workspaceId, run.workItemId).catch(() => undefined) : undefined;
      if (item?.status === "queued" && item.run.resumeMessage && item.run.sessionId === run.sessionId) {
        await this.service.putRun(workspaceId, { ...run, status: "done", note: "等待续做", endedAt: this.now() });
        continue;
      }
      const stillOwns = run.role === "steward" || (item?.status === "running" && item.run.sessionId === run.sessionId);
      const resumed = stillOwns && (await this.runner.resume(run.sessionId).catch(() => false));
      if (resumed) {
        const resumedRun = await this.service.putRun(workspaceId, { ...run, note: "进程重启后恢复会话" });
        this.runsBySession.set(run.sessionId, { workspaceId, run: resumedRun, idleTurns: 0 });
        if (run.role === "worker") this.ensurePatrol(workspaceId, run.missionId ?? run.workItemId!);
        await this.runner.send(run.sessionId, run.role === "worker"
          ? "工作台重启过，你的会话已恢复。先看 worktree 当前状态（git status / diff）和你上一条回复停在哪，再继续处理工单；完成后仍然 workItem.submit。"
          : "工作台重启过，你的会话已恢复。检查 workItem.list 里已建的工单，把没做完的处理完，最后回复一行摘要。");
        continue;
      }
      await this.service.putRun(workspaceId, { ...run, status: "failed", note: "进程重启，会话无法恢复", endedAt: this.now() });
      if (item?.status === "running") await this.service.requeueWorkItem(workspaceId, item.workItemId, "进程重启，会话无法恢复");
    }
  }

  // ---- missions ----

  /**
   * A mission is done once no work item under it is still open, at least one was closed (a mission whose items were
   * all cancelled has produced nothing, like one with no items), and the steward has finished with its latest
   * revision: a steward still issuing items, or a revision it has not picked up yet, keeps the mission active.
   * A further revision reopens it (WorkbenchService.addMissionRevision). Runs on every work item and run change, so
   * a steward finishing (its run is written as done) settles its mission.
   */
  private async settleMissions(workspaceId: string): Promise<void> {
    const [missions, items, runs] = await Promise.all([this.service.listMissions(workspaceId), this.service.listWorkItems(workspaceId), this.service.listRuns(workspaceId)]);
    for (const mission of missions.filter((m) => m.status === "active")) {
      const own = items.filter((i) => i.missionId === mission.missionId);
      if (!own.some((i) => i.status === "closed") || own.some((i) => i.status !== "closed" && i.status !== "cancelled")) continue;
      const stewards = runs.filter((r) => r.role === "steward" && r.missionId === mission.missionId);
      if (stewards.some((r) => r.status === "running") || !this.stewarded(mission, stewards)) continue;
      await this.service.setMissionStatus(workspaceId, mission.missionId, "done");
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

  // ---- steward ----

  /** One revision per steward run. A running steward gets the next revision steered into its session rather than a new one. */
  private async steward(workspaceId: string): Promise<void> {
    const [missions, runs] = await Promise.all([this.service.listMissions(workspaceId), this.service.listRuns(workspaceId)]);
    const mission = missions.find((m) => m.status === "active" && !this.stewarded(m, runs.filter((r) => r.role === "steward" && r.missionId === m.missionId)));
    if (!mission) return;
    const revision = latestRevision(mission);
    const previous = mission.revisions.length > 1 ? mission.revisions[mission.revisions.length - 2]!.commit : undefined;
    const root = await this.service.workspaceRoot(workspaceId);
    // Range is fixed here so the steward cannot diff the wrong pair; the full diff is left for it to pull on demand.
    const range = previous ? previous + " " + revision.commit : revision.commit;
    const diffCommand = previous ? "git diff " + range + " -- " + DOCS_DIR : "git show --format= " + revision.commit + " -- " + DOCS_DIR;
    const stat = (previous
      ? await git(root, ["diff", "--stat", previous, revision.commit, "--", DOCS_DIR]).catch(() => "")
      : await git(root, ["show", "--stat", "--format=", revision.commit, "--", DOCS_DIR]).catch(() => "")).trim();
    const items = await this.service.listWorkItems(workspaceId, mission.missionId);
    const existing = items.length === 0 ? "（还没有工单）" : items.map((i) => "- " + i.workItemId + " [" + i.status + "] " + i.title + (i.refs.length ? " @ " + i.refs.map((r) => r.commit.slice(0, 8)).join(",") : "")).join("\n");
    const message = [
      "任务「" + mission.title + "」" + (previous ? "有了新的 revision" : "刚创建，这是首个 revision") + "。",
      "workspaceId: " + workspaceId,
      "missionId: " + mission.missionId,
      ...(mission.summary.trim() ? ["任务摘要: " + mission.summary.trim()] : []),
      "revision: " + revision.commit + (revision.message ? "（变更说明：" + revision.message + "）" : ""),
      ...(revision.sessionId ? ["来源会话: " + revision.sessionId + "（用 vermillion.read_session 工具读，看这次讨论到底要做什么、哪些已否定或已实现）"] : []),
      "涉及文件: " + revision.paths.join(", "),
      ...(stat ? ["", stat] : []),
      "",
      "现有工单：",
      existing,
      "",
      "完整 diff 用这条命令看：" + diffCommand,
      previous ? "读某个文件在本 revision 的内容：git show " + revision.commit + ":<path>" : "这是首次入库：文档里的内容不一定都是新需求，以变更说明和任务摘要为准判断哪些要开单，其余先核对项目现状。",
      "",
      "请按你的规则处理：新建、调整或取消工单。工单主体是 refs；acceptance 只写做完能观察到什么、不写怎么验；文档分寸拿不准就 session.ask 问设计伙伴。用 CLI 完成所有写入；最后回复一行摘要说明做了什么。"
    ].join("\n");
    await this.stewardTurn(workspaceId, mission, revision.commit, message);
  }

  /**
   * Starts a steward run for the mission. If a steward is already running for it, the message is steered into that
   * session and the run's revision advances; otherwise a fresh session is opened.
   */
  private async stewardTurn(workspaceId: string, mission: Mission, revision: string | undefined, message: string): Promise<void> {
    const active = [...this.runsBySession.values()].find((b) => b.workspaceId === workspaceId && b.run.role === "steward" && b.run.missionId === mission.missionId);
    if (active) {
      if (revision) {
        active.run = await this.service.putRun(workspaceId, { ...active.run, revision });
      }
      await this.runner.steer(active.run.sessionId, "（追加）" + message);
      return;
    }
    const root = await this.service.workspaceRoot(workspaceId);
    const { content, modelConfig } = await this.roles.resolve(root, "steward");
    const { sessionId } = await this.runner.open({
      workspaceId,
      cwd: root,
      developerInstructions: content,
      modelConfig,
      title: "管家 · " + mission.title,
      metadata: { role: "steward", missionId: mission.missionId }
    });
    const run = await this.service.putRun(workspaceId, {
      runId: createId("run"),
      role: "steward",
      sessionId,
      missionId: mission.missionId,
      revision,
      status: "running",
      turns: 0,
      startedAt: this.now()
    });
    this.runsBySession.set(sessionId, { workspaceId, run, idleTurns: 0 });
    await this.runner.send(sessionId, message);
  }


  // ---- scheduler ----

  private async schedule(workspaceId: string): Promise<void> {
    const scheduler = await this.service.getScheduler(workspaceId);
    if (!scheduler.enabled) return;
    const items = await this.service.listWorkItems(workspaceId);
    const running = items.filter((i) => i.status === "running").length;
    const capacity = scheduler.maxWorkers - running;
    if (capacity <= 0) return;
    const closed = new Set(items.filter((i) => i.status === "closed").map((i) => i.workItemId)); // cancelled never satisfies a dependency
    const busy = new Set(items.filter((i) => i.status === "running").flatMap((i) => i.needs));
    const ready = items.filter(
      (i) => i.status === "queued" && i.dependsOn.every((id) => closed.has(id)) && !i.needs.some((need) => busy.has(need))
        // Inbox may receive a submit or decision before its turn ends. Deliver feedback after that turn finishes.
        && !(i.run.resumeMessage && i.run.sessionId && this.runsBySession.has(i.run.sessionId))
    );
    for (const item of ready.slice(0, capacity)) {
      await this.openWorker(workspaceId, item);
      for (const need of item.needs) busy.add(need);
    }
  }

  /** The steward changed a running item's contract: tell the worker now, mid-turn if needed. */
  private async steerWorker(sessionId: string, note: string): Promise<void> {
    const bound = this.runsBySession.get(sessionId);
    if (!bound) return;
    bound.idleTurns = 0; // a new contract restarts the progress budget
    const { turnId } = await this.runner.steer(sessionId, [
      "工单已调整：" + note,
      "立即重新执行 vermillion workItem.get 读取最新合同（objective / scope / acceptance 已变），按新合同继续；已完成但不再需要的部分回退。"
    ].join("\n"));
    // Landed mid-turn: a submit from this same turn was made against the old contract.
    if (turnId) await this.service.setWorkItemStaleTurn(bound.workspaceId, bound.run.workItemId!, turnId);
  }

  /**
   * A work item was cancelled: interrupt its worker if one held it, and when queued items depended on it, wake the
   * steward of each dependant's own mission to decide what happens to them (a worker may have deferred on an item from
   * another mission). Standalone dependants have no steward and stay queued; the task board shows them waiting on a
   * cancelled item.
   */
  private async onCancelled(workspaceId: string, workItemId: string, sessionId: string | undefined, dependants: string[]): Promise<void> {
    const bound = sessionId ? this.runsBySession.get(sessionId) : undefined;
    if (bound) {
      this.runsBySession.delete(bound.run.sessionId);
      await this.runner.interrupt(bound.run.sessionId).catch(() => undefined);
      await this.service.putRun(workspaceId, { ...bound.run, status: "failed", note: "工单已取消", endedAt: this.now() });
    }
    if (dependants.length === 0) return;
    const [item, items, missions] = await Promise.all([this.service.getWorkItem(workspaceId, workItemId), this.service.listWorkItems(workspaceId), this.service.listMissions(workspaceId)]);
    const affected = items.filter((w) => dependants.includes(w.workItemId));
    for (const mission of missions) {
      const mine = affected.filter((w) => w.missionId === mission.missionId);
      if (mine.length === 0) continue;
      await this.stewardTurn(workspaceId, mission, undefined, [
        "工单「" + item.title + "」（" + workItemId + "）已取消。以下排队中的工单依赖它：",
        ...mine.map((w) => "- " + w.workItemId + " " + w.title + "（dependsOn: " + w.dependsOn.join(", ") + "）"),
        "",
        "workspaceId: " + workspaceId,
        "missionId: " + mission.missionId,
        "",
        "请逐张判断：去掉依赖继续（workItem.update 改 dependsOn，带 note）、改依赖到替代工单、或一并取消（workItem.cancel）。拿不准就 decision.create。最后回复一行摘要。"
      ].join("\n"));
    }
  }

  private async openWorker(workspaceId: string, item: WorkItem): Promise<void> {
    const root = await this.service.workspaceRoot(workspaceId);
    // Anything that edits project files runs in its own worktree, mission or not; only operations with no write
    // scope (package, run tests) share the workspace root.
    const isolated = item.scope.allowedPaths.length > 0;
    let cwd = root;
    let worktreePath: string | undefined;
    let branch: string | undefined;
    if (isolated) {
      // Rework and retries continue in the same worktree; only the first run creates it.
      branch = item.run.branch ?? "vermillion/" + item.workItemId;
      worktreePath = item.run.worktreePath ?? join(root, STATE_DIR, "worktrees", item.workItemId);
      if (!item.run.worktreePath) {
        await mkdir(join(root, STATE_DIR, "worktrees"), { recursive: true });
        await git(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
      }
      cwd = worktreePath;
    }
    const resumed = !!(item.run.resumeMessage && item.run.sessionId && await this.runner.resume(item.run.sessionId).catch(() => false));
    let sessionId = item.run.sessionId!;
    if (!resumed) {
      // Reviewer and verifier run as the worker's subagents, so their prompts ride along verbatim instead of relying on the worker to fetch them.
      const [worker, reviewer, verifier] = await Promise.all([this.roles.resolve(root, "worker"), this.roles.resolve(root, "reviewer"), this.roles.resolve(root, "verifier")]);
      const developerInstructions = [
        worker.content.trim(),
        "",
        "## 附：reviewer subagent 的 prompt（spawn 时原样作为它的首条消息，再附上工单和 diff）",
        "----- reviewer begin -----",
        reviewer.content.trim(),
        "----- reviewer end -----",
        "",
        "## 附：verifier subagent 的 prompt（spawn 时原样作为它的首条消息，再附上 acceptance、refs 原文、diff）",
        "----- verifier begin -----",
        verifier.content.trim(),
        "----- verifier end -----"
      ].join("\n");
      ({ sessionId } = await this.runner.open({
        workspaceId,
        cwd,
        developerInstructions,
        modelConfig: worker.modelConfig,
        title: "Worker · " + item.title,
        metadata: { role: "worker", workItemId: item.workItemId, missionId: item.missionId }
      }));
    }
    await this.service.startWorkItem(workspaceId, item.workItemId, { sessionId, worktreePath, branch, heartbeatAt: this.now() });
    const run = await this.service.putRun(workspaceId, {
      runId: createId("run"),
      role: "worker",
      sessionId,
      missionId: item.missionId,
      workItemId: item.workItemId,
      status: "running",
      turns: 0,
      startedAt: this.now()
    });
    this.runsBySession.set(sessionId, { workspaceId, run, idleTurns: 0 });
    this.ensurePatrol(workspaceId, item.missionId ?? item.workItemId);
    if (resumed) {
      await this.runner.send(sessionId, [
        item.run.resumeMessage,
        "请在当前会话和原 worktree 中继续处理。先用 vermillion workItem.get '" + JSON.stringify({ workspaceId, workItemId: item.workItemId }) + "' 读取工单，完成后重新提交 evidence、review 处置和 verify 报告。"
      ].join("\n"));
      return;
    }
    const prior = [
      ...item.rejections.map((r) => "用户打回：" + r.reason),
      ...item.decisions.map((d) => "已决策：" + d),
      ...(item.run.lastFailure ? ["上次运行失败：" + item.run.lastFailure] : [])
    ];
    await this.runner.send(sessionId, [
      "你负责工单「" + item.title + "」。",
      "workspaceId: " + workspaceId,
      "workItemId: " + item.workItemId,
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
      "完成后必须调用 workItem.submit，需要用户决定时调用 decision.create，发现依赖另一张未合入的工单时调用 workItem.defer；三者之一是这个会话唯一的合法结束方式。"
    ].join("\n"));
  }

  // ---- turn handling ----

  private async onTurn(workspaceId: string, run: AgentRun, finishReason: "completed" | "interrupted" | "failed"): Promise<void> {
    const bound = this.runsBySession.get(run.sessionId);
    if (!bound) return;
    bound.run = { ...bound.run, turns: bound.run.turns + 1 };
    if (run.role === "steward") return this.finishSteward(workspaceId, bound.run, finishReason);
    if (run.role === "worker") return this.onWorkerTurn(workspaceId, bound, finishReason);
  }

  private async finishSteward(workspaceId: string, run: AgentRun, finishReason: string): Promise<void> {
    this.runsBySession.delete(run.sessionId);
    await this.service.putRun(workspaceId, {
      ...run,
      status: finishReason === "completed" ? "done" : "failed",
      note: this.runner.lastReply(run.sessionId)?.slice(0, 400),
      endedAt: this.now()
    });
    await this.steward(workspaceId); // next unprocessed revision, if any
    await this.schedule(workspaceId);
  }

  private async onWorkerTurn(workspaceId: string, bound: WorkerBinding, finishReason: string): Promise<void> {
    const run = bound.run;
    let item = await this.service.getWorkItem(workspaceId, run.workItemId!);
    if (item.status === "running" && item.run.sessionId === run.sessionId && item.run.staleTurnId) {
      item = await this.service.setWorkItemStaleTurn(workspaceId, item.workItemId, undefined); // next turn starts on the new contract
    }
    // The item left this session: submitted, parked on a decision, voided (and possibly already re-assigned).
    if (item.status !== "running" || item.run.sessionId !== run.sessionId) {
      this.runsBySession.delete(run.sessionId);
      const note = item.run.sessionId !== run.sessionId && item.status !== "review" && item.status !== "closed" && item.status !== "cancelled" ? "提交作废：合同已变更"
        : item.status === "decision" ? "等待决策"
        : item.status === "queued" ? "退回队列"
        : "已提交 (" + item.status + ")";
      await this.service.putRun(workspaceId, { ...run, status: "done", note, endedAt: this.now() });
      await this.schedule(workspaceId);
      return;
    }
    if (finishReason !== "completed") {
      await this.failWorker(workspaceId, run, "turn " + finishReason);
      return;
    }
    await this.service.heartbeatWorkItem(workspaceId, item.workItemId);
    bound.idleTurns += 1;
    if (bound.idleTurns > this.maxIdleTurns) {
      await this.failWorker(workspaceId, run, "多轮未提交");
      return;
    }
    await this.runner.send(run.sessionId, "工单仍是进行中。继续；完成后调用 workItem.submit，需要用户决定则调用 decision.create，依赖另一张未合入的工单则调用 workItem.defer。");
  }

  private async failWorker(workspaceId: string, run: AgentRun, note: string): Promise<void> {
    this.runsBySession.delete(run.sessionId);
    await this.service.putRun(workspaceId, { ...run, status: "failed", note, endedAt: this.now() });
    await this.service.requeueWorkItem(workspaceId, run.workItemId!, note);
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
