import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { RoleService } from "../src/roles.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("condition not reached");
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "verm-action-orch-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const roles = new RoleService({ globalDir: join(root, "roles"), defaultsDir: new URL("../roles/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  await roles.ensureGlobal();
  await writeFile(join(root, "roles", "workspace-repair.md"), "# Workspace repair\nRepair the main workspace and preserve others' changes.");
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
  const ws = await service.addWorkspace({ rootPath: root, label: "actions" });
  const id = ws.workspaceId;
  await service.setScheduler(id, { enabled: true, maxWorkers: 1 });
  const active = new Set<string>();
  const messages: string[] = [];
  const listeners = new Set<Parameters<AgentRunner["onTurnCompleted"]>[0]>();
  const runner: AgentRunner = {
    open: vi.fn(async () => ({ sessionId: "session" })),
    resume: vi.fn(async () => true),
    send: vi.fn(async (session, message) => { active.add(session); messages.push(message); }),
    steer: vi.fn(async (_session, message) => { messages.push(message); return { turnId: "turn" }; }),
    interrupt: vi.fn(async (session) => { active.delete(session); }),
    isActive: (session) => active.has(session), lastReply: () => "text only", turnMessages: () => [], registerTool: () => {},
    onTurnCompleted: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  let orchestrator = new Orchestrator({ service, roles, runner, maxIdleTurns: 1 });
  cleanup.push(async () => { orchestrator.dispose(); service.dispose(); await new Promise((r) => setTimeout(r, 100)); });
  const start = () => orchestrator.start();
  const restart = () => { orchestrator.dispose(); orchestrator = new Orchestrator({ service, roles, runner, maxIdleTurns: 1 }); orchestrator.start(); };
  const complete = (finishReason: "completed" | "failed" = "completed") => { active.delete("session"); for (const listener of listeners) listener({ sessionId: "session", turnId: "turn", finishReason }); };
  const item = await service.createWorkItem(id, { title: "work", objective: "implement", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "works" }] });
  return { root, service, id, item, runner, messages, active, start, restart, complete };
}

it("recovers the active session without duplicate delivery and steers a durable contract update", async () => {
  const t = await setup(); t.start();
  await until(() => t.messages.length === 1);
  t.restart();
  await t.service.recoverWorkItem(t.id, t.item.workItemId);
  expect(t.messages).toHaveLength(1);
  expect(t.runner.open).toHaveBeenCalledTimes(1);
  await t.service.updateWorkItem(t.id, t.item.workItemId, { objective: "changed", note: "new contract" });
  await until(async () => !!(await t.service.getWorkItem(t.id, t.item.workItemId)).run.staleTurnId);
  expect(t.runner.steer).toHaveBeenCalled();
  expect((await t.service.listActions(t.id)).find((a) => a.kind === "execute")?.message).toContain("new contract");
  t.complete();
  await until(async () => !(await t.service.getWorkItem(t.id, t.item.workItemId)).run.staleTurnId);
});

it("keeps delivery failures at deliver and retries the original session", async () => {
  const t = await setup();
  vi.mocked(t.runner.send).mockRejectedValueOnce(new Error("delivery down"));
  t.start();
  await until(async () => (await t.service.listActions(t.id)).some((a) => a.status === "retry"));
  const failed = (await t.service.listActions(t.id))[0]!;
  expect(failed.stage).toBe("deliver"); expect(failed.attempts).toBe(1);
  await t.service.recoverWorkItem(t.id, t.item.workItemId);
  await until(() => t.messages.length === 1);
  expect(t.runner.open).toHaveBeenCalledTimes(1);
  expect(t.messages[0]).toContain("delivery down");
});

it("contract text completion reminds then fails the steward, not the waiting worker", async () => {
  const t = await setup();
  await t.service.escalateWorkItem(t.id, t.item.workItemId, "contract conflict");
  t.start(); await until(() => t.messages.length === 1);
  expect(t.messages[0]).toContain('resolution:{actionId:');
  expect(t.messages[0]).toContain("保持无 Mission");
  t.complete(); await until(() => t.messages.length === 2);
  t.complete();
  await until(async () => (await t.service.listActions(t.id)).some((a) => a.kind === "contract" && a.status === "retry"));
  expect((await t.service.getWorkItem(t.id, t.item.workItemId)).run.attempts).toBeUndefined();
  expect(t.runner.open).toHaveBeenCalledTimes(1);
});

it("adopts its existing worktree after creation succeeded before the run write", async () => {
  const t = await setup();
  await exec("git", ["init"], { cwd: t.root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base"], { cwd: t.root });
  const path = join(t.root, ".vermillion", "worktrees", t.item.workItemId);
  await exec("git", ["worktree", "add", "-b", "vermillion/" + t.item.workItemId, path, "HEAD"], { cwd: t.root });
  await t.service.updateWorkItem(t.id, t.item.workItemId, { scope: { inScope: [], outOfScope: [], allowedPaths: ["src/"] }, note: "write scope" });
  t.start(); await until(() => t.messages.length === 1);
  expect((await t.service.getWorkItem(t.id, t.item.workItemId)).run.worktreePath).toBe(path);
  expect(t.messages[0]).toContain("git rebase");
});

it("pauses the active worker when its updated contract adds an unfinished dependency", async () => {
  const t = await setup(); t.start(); await until(() => t.messages.length === 1);
  const predecessor = await t.service.createWorkItem(t.id, { title: "predecessor", objective: "prerequisite", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "ready" }] });
  await t.service.updateWorkItem(t.id, t.item.workItemId, { dependsOn: [predecessor.workItemId], note: "wait for prerequisite" });
  await until(() => vi.mocked(t.runner.interrupt).mock.calls.length > 0);
  expect((await t.service.getWorkItem(t.id, t.item.workItemId)).status).toBe("queued");
  expect(await t.service.isWorkItemBlocked(t.id, t.item.workItemId)).toBe(true);
});

it("sends repair submission protocol and preserves a pending decision across restart", async () => {
  const t = await setup();
  await t.service.createAction(t.id, { kind: "repair", role: "workspace-repair", ownerKey: "repair:" + t.id, workItemIds: [t.item.workItemId], status: "pending", stage: "open", message: "main workspace locked; cleanup failed; evidence: lock owner" });
  t.start(); await until(() => t.messages.length === 1);
  expect(t.messages[0]).toContain("workspace.repair.submit {workspaceId,actionId,sessionId,summary,evidence:[string]}");
  expect(t.messages[0]).toContain("不修改产品功能");
  const action = (await t.service.listActions(t.id)).find((a) => a.kind === "repair")!;
  await t.service.createDecision(t.id, { actionId: action.actionId, sessionId: "session", workItemId: t.item.workItemId, question: "Permission?", context: "unknown owner", options: [{ key: "keep", label: "keep" }] });
  t.complete(); t.restart();
  await t.service.recoverWorkItem(t.id, t.item.workItemId);
  expect(t.messages).toHaveLength(1);
  expect((await t.service.listActions(t.id)).find((a) => a.actionId === action.actionId)?.status).toBe("decision");
});

it("does not replace a session when resume throws a runtime error", async () => {
  const t = await setup();
  await t.service.patchWorkItemRun(t.id, t.item.workItemId, { sessionId: "original" });
  vi.mocked(t.runner.resume).mockRejectedValue(new Error("runtime unavailable"));
  t.start();
  await until(async () => (await t.service.listActions(t.id)).some((a) => a.status === "retry"));
  expect(t.runner.open).not.toHaveBeenCalled();
  expect((await t.service.listActions(t.id))[0]?.sessionId).toBe("original");
});
