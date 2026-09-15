import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionRuntimeService } from "@vermillion/desktop-server";
import { createWorkbenchRpcHandler, createMemoryWorkspaceSource, RoleService, WorkbenchService } from "@vermillion/workbench";
import { createSessionNavigation } from "../src/electron/session-navigation.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

it("binds RPC navigation to the latest real shell turn and retains it across reopening in its data directory", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "vermillion-navigation-"));
  disposers.push(() => rm(baseDir, { recursive: true, force: true }));
  const shell = createSessionRuntimeService({
    persistenceBaseDir: baseDir,
    engineCommands: {
      codex: {
        path: process.execPath,
        args: [fileURLToPath(new URL("../../desktop-server/tests/fixtures/fake-codex-app-server.mjs", import.meta.url))]
      }
    }
  });
  disposers.push(() => shell.dispose());
  const sourceWorkspace = await shell.addWorkspace({ rootPath: baseDir });
  const targetRoot = join(baseDir, "target");
  await mkdir(targetRoot);
  const targetWorkspace = await shell.addWorkspace({ rootPath: targetRoot });
  const source = await shell.createBrowserSession({ workspaceId: sourceWorkspace.workspaceId, engineId: "codex" });
  const target = await shell.createBrowserSession({ workspaceId: targetWorkspace.workspaceId, engineId: "codex", metadata: { role: "worker" } });
  await shell.setSessionTitle(target.sessionId, "目标工作会话");
  const port = createSessionNavigation(shell, baseDir);
  const options = { workspaces: createMemoryWorkspaceSource(), roles: new RoleService({ globalDir: join(baseDir, "roles"), defaultsDir: join(baseDir, "defaults") }) };
  const service = new WorkbenchService({ ...options, sessionNavigation: port });
  disposers.push(async () => service.dispose());
  const rpc = createWorkbenchRpcHandler(service);
  const events = vi.fn();
  service.subscribe(events);
  await expect(port.create({ sessionId: source.sessionId, targetSessionId: target.sessionId })).rejects.toThrow("no turn");
  for (let n = 1; n <= 2; n++) {
    await shell.executeCommand({ commandId: `navigation-send-${n}`, command: { type: "sendUserMessage", sessionId: source.sessionId, messageId: `navigation-message-${n}`, content: `message ${n}`, attachments: [] } });
    await vi.waitFor(() => expect(shell.getSnapshot().turns.filter((turn) => turn.sessionId === source.sessionId && turn.status === "completed")).toHaveLength(n));
  }
  const turns = shell.getSnapshot().turns.filter((turn) => turn.sessionId === source.sessionId);
  const turnId = turns.at(-1)!.turnId;
  const created = await rpc({ method: "sessionNavigation.create", params: { sessionId: source.sessionId, targetSessionId: target.sessionId, reason: "继续讨论" } });
  expect(created).toMatchObject({ ok: true, result: { sessionId: source.sessionId, turnId, targetSessionId: target.sessionId, targetWorkspaceId: targetWorkspace.workspaceId, title: "目标工作会话", role: "worker", reason: "继续讨论" } });
  expect(events).toHaveBeenCalledWith({ type: "sessionNavigation.changed", sessionId: source.sessionId, workspaceId: sourceWorkspace.workspaceId });
  const reopened = createSessionNavigation(shell, baseDir);
  expect(await reopened.list({ sessionId: source.sessionId, turnId })).toEqual([created.ok ? created.result : undefined]);
  expect(await reopened.list({ sessionId: source.sessionId, turnId: turns[0]!.turnId })).toEqual([]);
  expect(await createSessionNavigation(shell, join(baseDir, "isolated")).list({ sessionId: source.sessionId, turnId })).toEqual([]);
  const designer = await port.create({ sessionId: source.sessionId, targetSessionId: source.sessionId });
  expect(designer.navigation.role).toBe("design-partner");
  await expect(port.create({ sessionId: source.sessionId, targetSessionId: "missing" })).rejects.toThrow("Unknown session");
  const offline = new WorkbenchService(options);
  expect(await createWorkbenchRpcHandler(offline)({ method: "sessionNavigation.create", params: { sessionId: source.sessionId, targetSessionId: target.sessionId } })).toMatchObject({ ok: false, error: expect.stringContaining("running desktop") });
});
