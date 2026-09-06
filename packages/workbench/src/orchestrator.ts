import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { latestRevision, type AgentRun, type Mission, type WorkItem } from "./contracts.js";
import { DOCS_DIR, STATE_DIR } from "./docs.js";
import type { RoleService } from "./roles.js";
import type { WorkbenchService } from "./workbench-service.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;

/** What the orchestrator needs from the session engine. Implemented in Electron main over SessionShellService. */
export type AgentRunner = {
  open: (input: { workspaceId: string; cwd: string; developerInstructions: string; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string }>;
  send: (sessionId: string, content: string) => Promise<void>;
  /** Delivers into the running turn when there is one, otherwise as the next message. */
  steer: (sessionId: string, content: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  /** Text of the last assistant message in the session, if any. */
  lastReply: (sessionId: string) => string | undefined;
  onTurnCompleted: (listener: (event: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed" }) => void) => () => void;
};

export type OrchestratorOptions = {
  service: WorkbenchService;
  roles: RoleService;
  runner: AgentRunner;
  now?: () => string;
  /** Worker turns without status progress before the item is requeued. */
  maxIdleTurns?: number;
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
  private readonly disposers: Array<() => void> = [];
  /** Serializes work per workspace so two events do not schedule the same item twice. */
  private readonly queues = new Map<string, Promise<void>>();
  /** sessionId -> run, for sessions opened in this process. */
  private readonly runsBySession = new Map<string, WorkerBinding>();
  private readonly supervisorSessionByMission = new Map<string, string>();

  constructor(options: OrchestratorOptions) {
    this.service = options.service;
    this.roles = options.roles;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxIdleTurns = options.maxIdleTurns ?? 3;
  }

  start(): void {
    this.disposers.push(
      this.service.subscribe((event) => {
        if (!("workspaceId" in event)) return;
        if (event.type === "missions.changed" || event.type === "scheduler.changed") this.enqueue(event.workspaceId, () => this.reconcile(event.workspaceId));
        else if (event.type === "workItems.changed" || event.type === "decisions.changed") this.enqueue(event.workspaceId, () => this.schedule(event.workspaceId));
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
    const scheduler = await this.service.getScheduler(workspaceId);
    if (!scheduler.enabled) return;
    await this.recoverStaleRuns(workspaceId);
    await this.steward(workspaceId);
    await this.schedule(workspaceId);
  }

  /** Runs recorded as running but not owned by this process ended with the previous process; close them out. */
  private async recoverStaleRuns(workspaceId: string): Promise<void> {
    for (const run of await this.service.listRuns(workspaceId)) {
      if (run.status !== "running" || this.runsBySession.has(run.sessionId)) continue;
      await this.service.putRun(workspaceId, { ...run, status: "failed", note: "进程重启，会话未完成", endedAt: this.now() });
      if (run.workItemId) {
        const item = await this.service.getWorkItem(workspaceId, run.workItemId).catch(() => undefined);
        if (item?.status === "running") await this.service.requeueWorkItem(workspaceId, item.workItemId, "进程重启");
      }
    }
  }

  // ---- steward ----

  /** One revision per steward run. A running steward gets the next revision steered into its session rather than a new one. */
  private async steward(workspaceId: string): Promise<void> {
    const [missions, runs] = await Promise.all([this.service.listMissions(workspaceId), this.service.listRuns(workspaceId)]);
    const processed = new Set(runs.filter((r) => r.role === "steward" && r.revision).map((r) => r.revision));
    const mission = missions.find((m) => m.status === "active" && !processed.has(latestRevision(m).commit));
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
    const { content } = await this.roles.read(root, "steward");
    const { sessionId } = await this.runner.open({
      workspaceId,
      cwd: root,
      developerInstructions: content,
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
      (i) => i.status === "queued" && (i.run.attempts ?? 0) < 3 && i.dependsOn.every((id) => closed.has(id)) && !i.needs.some((need) => busy.has(need))
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
    await this.runner.steer(sessionId, [
      "工单已调整：" + note,
      "立即重新执行 vermillion workItem.get 读取最新合同（objective / scope / acceptance / contractVersion 已变），按新合同继续；已完成但不再需要的部分回退。",
      "submit 时带上最新的 contractVersion。"
    ].join("\n"));
  }

  /**
   * A work item was cancelled: interrupt its worker if one held it, and when queued items depended on it, wake the
   * steward of that mission to decide what happens to them.
   */
  private async onCancelled(workspaceId: string, workItemId: string, sessionId: string | undefined, dependants: string[]): Promise<void> {
    const bound = sessionId ? this.runsBySession.get(sessionId) : undefined;
    if (bound) {
      this.runsBySession.delete(bound.run.sessionId);
      await this.runner.interrupt(bound.run.sessionId).catch(() => undefined);
      await this.service.putRun(workspaceId, { ...bound.run, status: "failed", note: "工单已取消", endedAt: this.now() });
    }
    if (dependants.length === 0) return;
    const item = await this.service.getWorkItem(workspaceId, workItemId);
    const mission = item.missionId ? (await this.service.listMissions(workspaceId)).find((m) => m.missionId === item.missionId) : undefined;
    if (!mission) return;
    const items = await this.service.listWorkItems(workspaceId, mission.missionId);
    const lines = dependants.map((id) => { const w = items.find((x) => x.workItemId === id); return "- " + id + " " + (w?.title ?? "") + "（dependsOn: " + (w?.dependsOn.join(", ") ?? "") + "）"; });
    await this.stewardTurn(workspaceId, mission, undefined, [
      "工单「" + item.title + "」（" + workItemId + "）已取消。以下排队中的工单依赖它：",
      ...lines,
      "",
      "workspaceId: " + workspaceId,
      "missionId: " + mission.missionId,
      "",
      "请逐张判断：去掉依赖继续（workItem.update 改 dependsOn，带 note）、改依赖到替代工单、或一并取消（workItem.cancel）。拿不准就 decision.create。最后回复一行摘要。"
    ].join("\n"));
  }

  private async openWorker(workspaceId: string, item: WorkItem): Promise<void> {
    const root = await this.service.workspaceRoot(workspaceId);
    const isolated = item.missionId !== undefined && item.scope.allowedPaths.length > 0;
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
    const { content } = await this.roles.read(root, "worker");
    const { sessionId } = await this.runner.open({
      workspaceId,
      cwd,
      developerInstructions: content,
      title: "Worker · " + item.title,
      metadata: { role: "worker", workItemId: item.workItemId, missionId: item.missionId }
    });
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
      "",
      "先用 CLI 读取完整工单：vermillion workItem.get '" + JSON.stringify({ workspaceId, workItemId: item.workItemId }) + "'",
      ...(prior.length ? ["", "历史记录：", ...prior.map((p) => "- " + p)] : []),
      "",
      "完成后必须调用 workItem.submit，需要用户决定时调用 decision.create；两者之一是这个会话唯一的合法结束方式。"
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
    const item = await this.service.getWorkItem(workspaceId, run.workItemId!);
    // The item left this session: submitted, parked on a decision, voided (and possibly already re-assigned).
    if (item.status !== "running" || item.run.sessionId !== run.sessionId) {
      this.runsBySession.delete(run.sessionId);
      const note = item.run.sessionId !== run.sessionId && item.status !== "review" && item.status !== "closed" && item.status !== "cancelled" ? "提交作废：合同已变更" : item.status === "decision" ? "等待决策" : "已提交 (" + item.status + ")";
      await this.service.putRun(workspaceId, { ...run, status: "done", note, endedAt: this.now() });
      await this.schedule(workspaceId);
      return;
    }
    if (finishReason !== "completed") {
      await this.failWorker(workspaceId, run, "turn " + finishReason);
      return;
    }
    await this.service.heartbeatWorkItem(workspaceId, item.workItemId);
    const verdict = await this.supervise(workspaceId, item, run);
    if (verdict.kind === "interrupt") {
      await this.runner.interrupt(run.sessionId).catch(() => undefined);
      await this.failWorker(workspaceId, run, "Supervisor 中断：" + verdict.text);
      return;
    }
    bound.idleTurns += 1;
    if (bound.idleTurns > this.maxIdleTurns) {
      await this.failWorker(workspaceId, run, "多轮未提交");
      return;
    }
    await this.runner.send(run.sessionId, verdict.kind === "remind"
      ? "Supervisor 提醒：" + verdict.text + "\n继续处理工单；完成后调用 workItem.submit。"
      : "工单仍是进行中。继续；完成后调用 workItem.submit，需要用户决定则调用 decision.create。");
  }

  private async failWorker(workspaceId: string, run: AgentRun, note: string): Promise<void> {
    this.runsBySession.delete(run.sessionId);
    await this.service.putRun(workspaceId, { ...run, status: "failed", note, endedAt: this.now() });
    await this.service.requeueWorkItem(workspaceId, run.workItemId!, note);
  }

  // ---- supervisor ----

  private async supervise(workspaceId: string, item: WorkItem, run: AgentRun): Promise<{ kind: "none" | "remind" | "interrupt"; text: string }> {
    const root = await this.service.workspaceRoot(workspaceId);
    const cwd = item.run.worktreePath ?? root;
    const reply = this.runner.lastReply(run.sessionId) ?? "";
    const stat = await git(cwd, ["diff", "--stat", "HEAD"]).catch(() => "");
    const changed = await git(cwd, ["diff", "--name-only", "HEAD"]).catch(() => "");
    const outside = item.scope.allowedPaths.length
      ? changed.split("\n").filter(Boolean).filter((p) => !item.scope.allowedPaths.some((allowed) => p.startsWith(allowed.replace(/\*+$/, "").replace(/\/$/, ""))))
      : [];
    const key = item.missionId ?? item.workItemId;
    let sessionId = this.supervisorSessionByMission.get(key);
    if (!sessionId) {
      const { content } = await this.roles.read(root, "supervisor");
      sessionId = (await this.runner.open({ workspaceId, cwd: root, developerInstructions: content, title: "Supervisor · " + (item.missionId ?? item.title), metadata: { role: "supervisor", missionId: item.missionId } })).sessionId;
      this.supervisorSessionByMission.set(key, sessionId);
      await this.service.putRun(workspaceId, { runId: createId("run"), role: "supervisor", sessionId, missionId: item.missionId, status: "running", turns: 0, startedAt: this.now() });
    }
    const done = new Promise<void>((resolve) => {
      const off = this.runner.onTurnCompleted((e) => { if (e.sessionId === sessionId) { off(); resolve(); } });
    });
    await this.runner.send(sessionId, [
      "Worker turn #" + run.turns + " 结束，工单「" + item.title + "」。",
      "objective: " + item.objective,
      "allowedPaths: " + (item.scope.allowedPaths.join(", ") || "(无限制)"),
      "acceptance: " + item.acceptance.map((a, i) => (i + 1) + ") " + a.text).join("; "),
      "",
      "确定性信号：越界路径 " + (outside.length ? outside.join(", ") : "无") + "；diff --stat：\n" + (stat.trim() || "(无改动)"),
      "",
      "Worker 本 turn 输出：",
      reply.slice(-3000) || "(无文本)",
      "",
      "只回复一行，格式为 none | remind: <一句话> | interrupt: <一句话>。"
    ].join("\n"));
    await done;
    const text = (this.runner.lastReply(sessionId) ?? "").trim();
    const match = /^(none|remind|interrupt)\s*[:：]?\s*(.*)$/is.exec(text);
    if (!match) return { kind: "none", text: "" };
    return { kind: match[1]!.toLowerCase() as "none" | "remind" | "interrupt", text: match[2]!.trim() };
  }
}
