import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { DomainService } from "../src/domain-service.js";
import { RuntimeOrchestrator } from "../src/runtime-orchestrator.js";
import type { HydratedSessionSnapshot } from "../src/session-discovery.js";

const timestamp = (seconds: number) => new Date(Date.UTC(2026, 8, 12, 0, 0, seconds)).toISOString();

const history = (sessionId: string, count = 3): HydratedSessionSnapshot => ({
  workspaceId: "workspace-query",
  conversation: {
    conversationId: sessionId, workspaceId: "workspace-query",
    participantEngineIds: ["codex"], sessionIds: [sessionId],
    createdAt: timestamp(0), updatedAt: timestamp(count * 10)
  },
  session: {
    sessionId, conversationId: sessionId, engineId: "codex", status: "idle",
    createdAt: timestamp(0), updatedAt: timestamp(count * 10)
  },
  turns: Array.from({ length: count }, (_, i) => ({
    turnId: `${sessionId}-${i}`, sessionId,
    status: i === count - 1 ? "streaming" : "completed",
    startedAt: timestamp(i * 10),
    completedAt: i === count - 1 ? undefined : timestamp(i * 10 + 5),
    messageIds: [`${sessionId}-${i}-user`, `${sessionId}-${i}-assistant`],
    toolCallIds: [], terminalIds: [], approvalRequestIds: []
  })),
  messageBlocks: Array.from({ length: count }, (_, i) =>
    (["user", "assistant"] as const).map((role) => ({
      blockId: `${sessionId}-${i}-${role}`, messageId: `${sessionId}-${i}-${role}`,
      sessionId, turnId: `${sessionId}-${i}`, role, kind: "markdown" as const,
      text: "Loaded rollout content. ".repeat(100),
      startedAt: timestamp(i * 10 + (role === "assistant" ? 2 : 0))
    }))
  ).flat(),
  toolCalls: [], terminalStreams: [], sessionRelations: []
});

const harness = () => {
  const domainService = new DomainService({
    assertEngineRegistered: () => {}, resolveEngineCapabilities: () => ["chat"],
    publishRuntimeEvent: () => {}
  });
  const orchestrator = new RuntimeOrchestrator({
    domainService,
    sessionIndexSyncService: {} as never,
    workspaceSelectionService: {} as never,
    publishRuntimeEvent: () => {},
    agentBindings: [{
      descriptor: { engineId: "codex", displayName: "Codex", capabilities: ["chat"] },
      providerKind: "codex-thread",
      resolveProviderSessionId: (id) => id === "unbound" ? undefined : `thread-${id}`
    }]
  });
  return { domainService, orchestrator };
};

describe("session identity and activity queries", () => {
  it("resolves provider bindings without reading activity or a global snapshot", async () => {
    const { domainService, orchestrator } = harness();
    try {
      domainService.hydrateDiscoveredSession(history("wrapper"));
      domainService.hydrateDiscoveredSession(history("unbound"));
      vi.spyOn(domainService, "getSnapshot").mockImplementation(() => { throw new Error("global snapshot"); });
      const activity = vi.spyOn(domainService, "getSessionActivity").mockImplementation(() => { throw new Error("activity query"); });
      expect(orchestrator.resolveProviderSessionHandle("wrapper")).toEqual({
        providerKind: "codex-thread", providerSessionId: "thread-wrapper"
      });
      expect(orchestrator.resolveProviderSessionHandle("unbound")).toBeUndefined();
      expect(orchestrator.resolveProviderSessionHandle("missing")).toBeUndefined();
      expect(activity).not.toHaveBeenCalled();
    } finally {
      await orchestrator.dispose();
    }
  });

  it("reads target activity without global history and follows replaced rollout timestamps", async () => {
    const { domainService, orchestrator } = harness();
    try {
      domainService.hydrateDiscoveredSession(history("target"));
      domainService.hydrateDiscoveredSession(history("unrelated", 20));
      const snapshot = vi.spyOn(domainService, "getSnapshot").mockImplementation(() => { throw new Error("global snapshot"); });
      expect(orchestrator.resolveSessionIndexRecord("target")).toMatchObject({
        workspaceId: "workspace-query", providerKind: "codex-thread",
        providerSessionId: "thread-target",
        lastCompletedTurnAt: timestamp(15), lastUserMessageAt: timestamp(20)
      });
      // Completion ordering need not match turn start ordering; active turns do not count.
      const replacement = history("target");
      replacement.turns[0]!.completedAt = timestamp(40);
      replacement.turns[1]!.status = "streaming";
      replacement.turns[1]!.completedAt = timestamp(90);
      domainService.hydrateDiscoveredSession(replacement, { replaceSessionHistory: true });
      expect(orchestrator.resolveSessionIndexRecord("target")).toMatchObject({
        lastCompletedTurnAt: timestamp(40), lastUserMessageAt: timestamp(20)
      });
      domainService.hydrateDiscoveredSession(history("target", 0), { replaceSessionHistory: true });
      expect(domainService.getSessionActivity("target")).toEqual({
        lastCompletedTurnAt: undefined, lastUserMessageAt: undefined
      });
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      await orchestrator.dispose();
    }
  });

  it.skipIf(process.env.VM_SESSION_QUERY_BENCH !== "1")("measures loaded-history scaling against the former snapshot query", async () => {
    const { domainService, orchestrator } = harness();
    try {
      domainService.hydrateDiscoveredSession(history("target", 100));
      const measure = (query: () => unknown, iterations: number) => {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) query();
        return (performance.now() - start) / iterations;
      };
      const report = () => ({
        sessions: domainService.listSessions().length,
        identityMs: measure(() => orchestrator.resolveProviderSessionHandle("target"), 1000),
        activityMs: measure(() => orchestrator.resolveSessionIndexRecord("target"), 30),
        formerQueryMs: measure(() => {
          const completed = domainService.getSnapshot().turns.filter((turn) => turn.sessionId === "target" && turn.status === "completed");
          const messages = domainService.getSnapshot().messageBlocks.filter((block) => block.sessionId === "target" && block.role === "user");
          return [completed, messages];
        }, 5)
      });
      const small = report();
      for (let i = 0; i < 79; i++) domainService.hydrateDiscoveredSession(history(`unrelated-${i}`, 100));
      console.info(JSON.stringify({ sessionQueryScale: [small, report()], turnsPerSession: 100, blocksPerSession: 200 }));
    } finally {
      await orchestrator.dispose();
    }
  }, 120_000);
});
