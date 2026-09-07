import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

it.each(["session-design-source", undefined])(
  "provides recorded related sessions to steward and worker (revision source: %s)",
  async (sourceSessionId) => {
    const root = await mkdtemp(join(tmpdir(), "verm-session-context-"));
    const roles = new RoleService({
      globalDir: join(root, "roles"),
      defaultsDir: fileURLToPath(new URL("../roles/", import.meta.url))
    });
    const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
    const sessions: Array<{ sessionId: string; role: unknown; messages: string[] }> = [];
    const capture = async (sessionId: string, content: string) => {
      sessions.find((session) => session.sessionId === sessionId)!.messages.push(content);
    };
    const runner: AgentRunner = {
      open: async (input) => {
        const sessionId = `session-${input.metadata.role}-${sessions.length}`;
        sessions.push({ sessionId, role: input.metadata.role, messages: [] });
        return { sessionId };
      },
      send: capture,
      steer: async (sessionId, content) => { await capture(sessionId, content); return {}; },
      interrupt: async () => {},
      resume: async (sessionId) => sessions.some((session) => session.sessionId === sessionId),
      lastReply: () => undefined,
      turnMessages: () => [],
      registerTool: () => {},
      onTurnCompleted: () => () => {}
    };
    const orchestrator = new Orchestrator({ service, roles, runner, patrolIntervalMs: 60_000 });
    try {
      await roles.ensureGlobal();
      const workspace = await service.addWorkspace({ rootPath: root, label: "Context" });
      await service.writeDoc(workspace.workspaceId, ".vermillion/docs/spec.md", "# Session context\n");
      const mission = await service.createMission(workspace.workspaceId, {
        title: "Context", summary: "Related session context", sessionId: sourceSessionId
      });
      expect(mission.revisions[0]!.sessionId).toBe(sourceSessionId);
      await service.setScheduler(workspace.workspaceId, { enabled: true, maxWorkers: 1 });
      orchestrator.start();
      await vi.waitFor(() => expect(sessions.find((session) => session.role === "steward")?.messages.length).toBe(1), { timeout: 10_000 });
      const steward = sessions.find((session) => session.role === "steward")!;
      const item = await service.createWorkItem(workspace.workspaceId, {
        missionId: mission.missionId, title: "Read context", objective: "Read supplied session IDs", risk: "R2",
        scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "Context available" }]
      });
      await vi.waitFor(() => expect(sessions.find((session) => session.role === "worker")?.messages.length).toBe(1), { timeout: 10_000 });
      const worker = sessions.find((session) => session.role === "worker")!;
      expect((await service.getWorkItem(workspace.workspaceId, item.workItemId)).run.sessionId).toBe(worker.sessionId);
      const stewardRun = (await service.listRuns(workspace.workspaceId)).find((run) => run.role === "steward")!;
      expect(stewardRun.sessionId).toBe(steward.sessionId);
      for (const session of [steward, worker]) {
        expect(session.messages[0]).toContain(`管家 sessionId: ${stewardRun.sessionId}`);
        if (sourceSessionId) {
          expect(session.messages[0]).toContain(`设计伙伴 sessionId: ${sourceSessionId}（revision: ${mission.revisions[0]!.commit}）`);
        } else {
          expect(session.messages[0]).not.toContain("设计伙伴 sessionId:");
          expect(session.messages[0]).not.toContain("来源会话:");
          expect(session.messages[0]).not.toContain("sessionId: undefined");
        }
      }
    } finally {
      orchestrator.dispose();
      service.dispose();
      await delay(100);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  20_000
);
