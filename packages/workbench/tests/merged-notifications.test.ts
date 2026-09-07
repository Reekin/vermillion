import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { createWorkbenchClient, workbenchRpc } from "../src/rpc.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const commit = async (cwd: string) => { await git(cwd, "add", "-A"); await git(cwd, "commit", "-qm", "result"); };
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const submission = {
  evidence: { summary: "输出内容已更新", commands: [{ command: "read output.txt", output: "worker" }], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
  review: [{ comment: "scope", decision: "accepted" as const, reason: "checked" }],
  verify: { items: [{ index: 0, pass: true, evidence: "读取输出文件，内容为 worker" }], verdict: "pass" as const }
};
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-merged-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const roles = new RoleService({ globalDir: join(root, ".vermillion", "roles") });
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
  cleanup.push(() => service.dispose());
  const { workspaceId } = await service.addWorkspace({ rootPath: root });
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@local");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(join(root, "output.txt"), "base\n");
  await commit(root);
  const client = createWorkbenchClient({ request: createWorkbenchRpcHandler(service), onEvent: (listener) => service.subscribe(listener) });
  const item = await client.request("workItem.create", { workspaceId, title: "输出", objective: "更新输出", risk: "R2", scope: { inScope: [], outOfScope: [], allowedPaths: ["output.txt"] }, acceptance: [{ text: "输出更新" }] });
  const params = { workspaceId, workItemId: item.workItemId };
  const branch = "vermillion/" + item.workItemId;
  const worktreePath = join(root, ".vermillion", "worktrees", item.workItemId);
  await git(root, "worktree", "add", "-b", branch, worktreePath);
  await service.startWorkItem(workspaceId, item.workItemId, { branch, worktreePath, sessionId: "original-worker" });
  await writeFile(join(worktreePath, "output.txt"), "worker\n");
  await commit(worktreePath);
  return { root, service, roles, client, params, branch, worktreePath };
};

describe("automatic merge notifications", { timeout: 30000 }, () => {
  it("accepts only R0–R2 and exposes no approval methods", () => {
    for (const risk of ["R0", "R1", "R2"]) expect(workbenchRpc["workItem.create"].params.shape.risk.safeParse(risk).success).toBe(true);
    expect(workbenchRpc["workItem.create"].params.shape.risk.safeParse("R3").success).toBe(false);
    expect(workbenchRpc).not.toHaveProperty("workItem.approve");
    expect(workbenchRpc).not.toHaveProperty("workItem.reject");
  });

  it("merges through RPC, preserves evidence and diff, cleans up, and acknowledges persistently", async () => {
    const { root, client, params, branch, worktreePath } = await setup();
    const closed = await client.request("workItem.submit", { ...params, ...submission });
    expect(closed.status).toBe("closed");
    expect(closed.merge?.commit).toBe(await git(root, "rev-parse", "HEAD"));
    expect((await git(root, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")).toHaveLength(3);
    expect(closed.merge?.diffStat).toContain("output.txt");
    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("worker\n");
    await expect(access(worktreePath)).rejects.toThrow();
    expect(await git(root, "branch", "--list", branch)).toBe("");
    const inbox = await client.request("inbox.list", {});
    expect(inbox).toMatchObject([{ kind: "merged", workItem: { ...submission, merge: closed.merge } }]);
    await client.request("inbox.acknowledge", params);
    expect(await client.request("inbox.list", {})).toEqual([]);
    expect((await client.request("workItem.get", params)).merge?.acknowledgedAt).toBeTruthy();
  });

  it("returns failed verification and real Git conflict to the same worker and worktree", async () => {
    const { root, client, service, params, branch, worktreePath } = await setup();
    const failed = await client.request("workItem.submit", { ...params, ...submission, verify: { verdict: "rework", items: [{ index: 0, pass: false, evidence: "输出错误" }] } });
    expect(failed).toMatchObject({ status: "queued", run: { sessionId: "original-worker", branch, worktreePath, resumeMessage: "验收未通过：输出错误" } });
    await service.startWorkItem(params.workspaceId, params.workItemId, {});
    await writeFile(join(root, "output.txt"), "upstream\n");
    await commit(root);
    const head = await git(root, "rev-parse", "HEAD");
    const conflict = await client.request("workItem.submit", { ...params, ...submission });
    expect(conflict).toMatchObject({ status: "queued", run: { sessionId: "original-worker", branch, worktreePath } });
    expect(conflict.run.resumeMessage).toContain("合并冲突：\n- output.txt");
    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "status", "--porcelain")).toBe("");
    await access(worktreePath);
    expect(await client.request("inbox.list", {})).toEqual([]);
  });

  it("rolls back and resumes the original session with a fresh branch that can merge the same changes again", async () => {
    const { root, client, service, roles, params, worktreePath } = await setup();
    const first = await client.request("workItem.submit", { ...params, ...submission });
    await expect(client.request("workItem.rollback", { ...params, reason: " " })).rejects.toThrow();
    const rolled = await client.request("workItem.rollback", { ...params, reason: "输出需要重做" });
    expect(rolled.status).toBe("queued");
    expect(rolled.merge?.rollbackCommit).toBe(await git(root, "rev-parse", "HEAD"));
    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("base\n");
    const messages: Array<{ sessionId: string; content: string }> = [];
    const runner: AgentRunner = {
      open: async () => { throw new Error("must resume the original worker"); },
      resume: async (id) => id === "original-worker",
      send: async (sessionId, content) => { messages.push({ sessionId, content }); },
      steer: async () => ({}), interrupt: async () => {}, lastReply: () => undefined,
      turnMessages: () => [], registerTool: () => {}, onTurnCompleted: () => () => {}
    };
    await service.setScheduler(params.workspaceId, { enabled: true, maxWorkers: 1 });
    const orchestrator = new Orchestrator({ service, roles, runner, patrolIntervalMs: 60000 });
    cleanup.push(() => orchestrator.dispose());
    orchestrator.start();
    const deadline = Date.now() + 10000;
    while (!messages.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages[0]?.sessionId).toBe("original-worker");
    expect(messages[0]?.content).toContain("输出需要重做");
    expect(await readFile(join(worktreePath, "output.txt"), "utf8")).toBe("base\n");
    await writeFile(join(worktreePath, "output.txt"), "worker\n");
    await commit(worktreePath);
    const second = await client.request("workItem.submit", { ...params, ...submission });
    expect(second.status).toBe("closed");
    expect(second.merge?.commit).not.toBe(first.merge?.commit);
    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("worker\n");
  });

  it("delivers failed verifier observations to the original worker without replacing its worktree", async () => {
    const { client, service, roles, params, worktreePath, branch } = await setup();
    const workerHead = await git(worktreePath, "rev-parse", "HEAD");
    await client.request("workItem.submit", { ...params, ...submission, verify: { verdict: "rework", items: [{ index: 0, pass: false, evidence: "看到输出缺失" }] } });
    const messages: Array<{ sessionId: string; content: string }> = [];
    const runner: AgentRunner = {
      open: async () => { throw new Error("must resume the original worker"); },
      resume: async (id) => id === "original-worker",
      send: async (sessionId, content) => { messages.push({ sessionId, content }); },
      steer: async () => ({}), interrupt: async () => {}, lastReply: () => undefined,
      turnMessages: () => [], registerTool: () => {}, onTurnCompleted: () => () => {}
    };
    await service.setScheduler(params.workspaceId, { enabled: true, maxWorkers: 1 });
    const orchestrator = new Orchestrator({ service, roles, runner, patrolIntervalMs: 60000 });
    cleanup.push(() => orchestrator.dispose());
    orchestrator.start();
    const deadline = Date.now() + 10000;
    while (!messages.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages[0]).toMatchObject({ sessionId: "original-worker" });
    expect(messages[0]?.content).toContain("看到输出缺失");
    expect(await client.request("workItem.get", params)).toMatchObject({ status: "running", run: { sessionId: "original-worker", branch, worktreePath } });
    expect(await git(worktreePath, "rev-parse", "HEAD")).toBe(workerHead);
  });

  it("serializes simultaneous worker merges against the shared workspace index", async () => {
    const { root, client, service, params } = await setup();
    const second = await client.request("workItem.create", { workspaceId: params.workspaceId, title: "第二份输出", objective: "输出", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: ["second.txt"] }, acceptance: [{ text: "输出更新" }] });
    const branch = "vermillion/" + second.workItemId;
    const worktreePath = join(root, ".vermillion", "worktrees", second.workItemId);
    await git(root, "worktree", "add", "-b", branch, worktreePath);
    await writeFile(join(worktreePath, "second.txt"), "second\n");
    await commit(worktreePath);
    await service.startWorkItem(params.workspaceId, second.workItemId, { branch, worktreePath, sessionId: "second-worker" });
    const results = await Promise.all([
      client.request("workItem.submit", { ...params, ...submission }),
      client.request("workItem.submit", { ...params, workItemId: second.workItemId, ...submission })
    ]);
    expect(results.map((item) => item.status)).toEqual(["closed", "closed"]);
    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("worker\n");
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second\n");
    expect(await client.request("inbox.list", {})).toHaveLength(2);
  });
});
