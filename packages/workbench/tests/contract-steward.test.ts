import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for scheduling");
};

const setup = async (missionOwned = false) => {
  const root = await mkdtemp(join(tmpdir(), "verm-contract-"));
  const roles = new RoleService({ globalDir: join(root, "roles"), defaultsDir: fileURLToPath(new URL("../roles/", import.meta.url)) });
  await roles.ensureGlobal();
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
  const ws = await service.addWorkspace({ rootPath: root, label: "Contract" });
  await service.writeDoc(ws.workspaceId, ".vermillion/docs/spec.md", "# Contract\n");
  await service.commitDocs(ws.workspaceId, { message: "Contract" });
  const mission = missionOwned ? await service.createMission(ws.workspaceId, { title: "Contract", summary: "" }) : undefined;
  const sessions: Array<{ sessionId: string; metadata: Record<string, unknown>; messages: string[] }> = [];
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  const runner: AgentRunner = {
    open: async ({ metadata }) => { const s = { sessionId: "s" + sessions.length, metadata, messages: [] as string[] }; sessions.push(s); return s; },
    send: async (id, message) => { sessions.find((s) => s.sessionId === id)!.messages.push(message); },
    steer: async (id, message) => { sessions.find((s) => s.sessionId === id)!.messages.push(message); return {}; },
    resume: async (id) => sessions.some((s) => s.sessionId === id),
    interrupt: async () => {}, lastReply: () => undefined, turnMessages: () => [], registerTool: () => {},
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  let orchestrator = new Orchestrator({ service, roles, runner, maxIdleTurns: 1 });
  const restart = () => { orchestrator.dispose(); orchestrator = new Orchestrator({ service, roles, runner, maxIdleTurns: 1 }); orchestrator.start(); };
  cleanup.push(async () => { orchestrator.dispose(); service.dispose(); await new Promise((r) => setTimeout(r, 100)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
  orchestrator.start();
  const item = await service.createWorkItem(ws.workspaceId, {
    missionId: mission?.missionId, title: "Original", objective: "fix", risk: "R2",
    scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, acceptance: [{ text: "fixed" }]
  });
  await until(async () => sessions.some((s) => s.metadata.role === "worker" && s.messages.length > 0));
  const worker = sessions.find((s) => s.metadata.role === "worker")!;
  const original = (await service.getWorkItem(ws.workspaceId, item.workItemId)).run;
  await writeFile(join(original.worktreePath!, "context.txt"), "retained work");
  const get = () => service.getWorkItem(ws.workspaceId, item.workItemId);
  const complete = (id: string, finishReason: "completed" | "failed" = "completed") => {
    for (const listener of listeners) listener({ sessionId: id, turnId: "t", finishReason });
  };
  const rpc = createWorkbenchRpcHandler(service);
  const call = async (method: string, params: Record<string, unknown>) => {
    const result = await rpc({ method, params: { workspaceId: ws.workspaceId, ...params } });
    if (!result.ok) throw new Error(result.error);
    return result.result;
  };
  return { service, ws, sessions, worker, item, original, get, complete, restart, call };
};

it("starts standalone stewards on demand and reuses them across completion and restart", async () => {
  const { service, ws, sessions, worker, item, original, get, complete, restart, call } = await setup();
  expect(sessions).toHaveLength(1);
  for (const round of [1, 2]) {
    const before = worker.messages.length;
    await call("workItem.escalate", { workItemId: item.workItemId, message: "范围问题 " + round });
    await until(async () => sessions.some((s) => s.metadata.role === "steward" && s.messages.some((m) => m.includes("范围问题 " + round))));
    const steward = sessions.find((s) => s.metadata.role === "steward")!;
    complete(worker.sessionId, "failed");
    await until(async () => !(await service.listRuns(ws.workspaceId)).some((r) => r.role === "worker" && r.status === "running"));
    expect((await get()).status).toBe("queued");
    expect((await get()).run.attempts).toBeUndefined();
    expect((await get()).missionId).toBeUndefined();
    expect(steward.messages.at(-1)).toContain("不重新拆单或补建 Mission");
    expect(await service.listMissions(ws.workspaceId)).toHaveLength(0);
    complete(steward.sessionId);
    await until(async () => !(await service.listRuns(ws.workspaceId)).some((r) => r.role === "steward" && r.status === "running"));
    await call("workItem.update", { workItemId: item.workItemId, objective: "fix " + round, note: "合同已落实 " + round });
    await until(async () => worker.messages.length === before + 1);
    expect((await get()).run).toMatchObject({ sessionId: original.sessionId, worktreePath: original.worktreePath, branch: original.branch });
    expect(await readFile(join(original.worktreePath!, "context.txt"), "utf8")).toBe("retained work");
    if (round === 1) {
      await service.setScheduler(ws.workspaceId, { enabled: false, maxWorkers: 1 });
      restart();
      await service.setScheduler(ws.workspaceId, { enabled: true, maxWorkers: 1 });
      await until(async () => worker.messages.some((m) => m.includes("工作台重启过")));
    }
  }
  expect(sessions.filter((s) => s.metadata.role === "steward")).toHaveLength(1);
}, 20000);

it.each([false, true])("delivers both answer forms to the original worker then holds escalated changes (mission=%s)", async (missionOwned) => {
  const { service, ws, sessions, worker, item, original, get, complete, call } = await setup(missionOwned);
  for (const answer of [{ key: "yes", note: "保留上下文" }, { note: "保留上下文，自由答复" }]) {
    const before = worker.messages.length;
    const card = await service.createDecision(ws.workspaceId, { workItemId: item.workItemId, sessionId: worker.sessionId, question: "如何继续？", context: "", options: [{ key: "yes", label: "继续" }] });
    await call("decision.answer", { decisionId: card.decisionId, ...answer });
    complete(worker.sessionId);
    await until(async () => worker.messages.length === before + 1);
    expect(worker.messages.at(-1)).toContain(answer.note);
    expect(worker.messages.at(-1)).toContain("合同更新前暂停开发与提交");
    expect((await get()).run.sessionId).toBe(original.sessionId);
    if (!missionOwned) expect(sessions.filter((s) => s.metadata.role === "steward")).toHaveLength(0);
  }
  await call("workItem.escalate", { workItemId: item.workItemId, message: "用户答复要求修改验收" });
  complete(worker.sessionId);
  await until(async () => sessions.some((s) => s.metadata.role === "steward" && s.messages.some((m) => m.includes("用户答复要求修改验收"))));
  expect((await get()).status).toBe("queued");
  const parkedMessages = worker.messages.length;
  const steward = sessions.find((s) => s.metadata.role === "steward")!;
  const confirmation = await service.createDecision(ws.workspaceId, { workItemId: item.workItemId, sessionId: steward.sessionId, question: "确认范围？", context: "", options: [{ key: "yes", label: "扩大" }] });
  await call("decision.answer", { decisionId: confirmation.decisionId, note: "确认扩大" });
  await until(async () => worker.messages.length === parkedMessages + 1);
  expect(worker.messages.at(-1)).toContain("确认扩大");
  expect((await get()).contractIssue?.resolvedAt).toBeUndefined();
  expect((await get()).status).toBe("queued");
  const other = await service.createWorkItem(ws.workspaceId, { title: "Other", objective: "read", risk: "R0", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [] });
  await until(async () => (await service.getWorkItem(ws.workspaceId, other.workItemId)).status === "running");
  await service.cancelWorkItem(ws.workspaceId, other.workItemId);
  await expect(call("workItem.submit", { workItemId: item.workItemId, evidence: { summary: "", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] }, review: [], verify: { verdict: "pass", items: [{ index: 0, pass: true, evidence: "" }] } })).rejects.toThrow("not running");
  await call("workItem.escalate", { workItemId: item.workItemId, message: "原 Worker 理解：确认扩大，需要更新目标" });
  complete(worker.sessionId);
  await until(async () => steward.messages.some((m) => m.includes("原 Worker 理解：确认扩大")));
  await call("workItem.update", { workItemId: item.workItemId, objective: "扩大后的目标", note: "落实用户决定" });
  await until(async () => worker.messages.length === parkedMessages + 2);
  expect(worker.messages.at(-1)).toContain("确认扩大");
  expect(worker.messages.at(-1)).toContain("落实用户决定");
  expect((await get()).run).toMatchObject({ sessionId: original.sessionId, worktreePath: original.worktreePath });
  expect((await get()).run.attempts).toBeUndefined();
}, 20000);
