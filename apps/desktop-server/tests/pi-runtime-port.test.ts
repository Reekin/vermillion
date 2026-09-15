import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PiRuntimeEvent } from "@vermillion/adapters";
import { PiRuntimePort } from "../src/engines/pi/runtime-port.js";
import { PiSessionDiscoveryProvider } from "../src/engines/pi/session-discovery.js";
import { PiSessionActionsProvider } from "../src/engines/pi/session-actions-provider.js";
import { piSessionIdForSession } from "../src/engines/pi/session-identity.js";
import { piProgram } from "../src/engines/pi/program.js";
import { resolveEngineProgramCommand } from "../src/engine-program-resolution.js";
import { SessionIndexStore, type SessionIndexEntry } from "../src/session-index.js";
import type { SessionActionProviderContext } from "../src/session-actions.js";
import type { SessionRuntimeService } from "../src/runtime-service.js";
import { createPiEngineIntegration } from "../src/engines/pi/index.js";
import { engineIntegrations } from "../src/engines/index.js";
import type { EngineIntegrationHost } from "../src/engine-control/engine-integration.js";

// Drives a real pi process against the configured provider, so it stays opt-in.
const enabled = process.env.VERMILLION_PI_E2E === "1";
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const extensionPath = join(
  repoRoot,
  "apps/desktop-server/resources/pi-extension/index.mjs"
);

const waitFor = async <T>(
  predicate: () => T | undefined,
  timeoutMs = 60_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the expected pi event.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
};

describe("pi engine integration", () => {
  const host = {
    persistenceBaseDir: "I:/gpt-projects/_accept/pi-integration-test",
    piExtensionPath: "I:/gpt-projects/vermillion/apps/desktop-server/resources/pi-extension/index.mjs",
    now: () => "2026-01-01T00:00:00.000Z",
    writeDiagnostic: () => undefined
  } as unknown as EngineIntegrationHost;

  it("is registered and declares only the capabilities pi implements", () => {
    expect(engineIntegrations).toContain(createPiEngineIntegration);
    const integration = createPiEngineIntegration(host);
    expect(integration.engineId).toBe("pi");
    expect(integration.definition.transportKind).toBe("pi-rpc");
    expect(integration.binding.providerKind).toBe("pi-session");
    expect(integration.binding.resolveProviderSessionId?.("pi-session:abc")).toBe("abc");
    expect(integration.surface.sharedCapabilities).toEqual(
      expect.arrayContaining(["chat", "turnConfiguration", "steer", "tool", "terminal"])
    );
    for (const unsupported of [
      "approval",
      "delegation",
      "checkpoint",
      "worktree",
      "goal"
    ]) {
      expect(integration.surface.sharedCapabilities).not.toContain(unsupported);
    }
    expect(Object.keys(integration.capabilities)).toEqual(
      expect.arrayContaining(["sessionActions", "sessionDiscovery", "sessionRuntime"])
    );
    expect(integration.capabilities.delegation).toBeUndefined();
    expect(integration.capabilities.worktree).toBeUndefined();
    expect(integration.capabilities.checkpoint).toBeUndefined();
  });
});

describe.skipIf(!enabled)("pi runtime port", () => {
  let dataDir: string | undefined;
  let port: PiRuntimePort | undefined;

  afterEach(async () => {
    await port?.stop();
    port = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it("streams a turn and rebuilds the same entity ids from the session file", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vermillion-pi-port-"));
    const events: PiRuntimeEvent[] = [];
    port = new PiRuntimePort({
      engineId: "pi",
      resolveCommand: async () => {
        const command = resolveEngineProgramCommand("pi", { program: piProgram });
        return {
          commandPath: command.resolvedPath ?? command.path,
          commandArgs: command.args,
          found: command.found
        };
      },
      resolveSessionDirectory: (sessionId) =>
        join(dataDir!, "pi-sessions", piSessionIdForSession(sessionId)),
      resolvePiSessionId: piSessionIdForSession,
      resolveSessionCwd: async () => dataDir!,
      resolveExtensionPath: () => extensionPath
    });
    port.subscribe((event) => {
      events.push(event);
    });
    await port.start();

    const sessionId = "session-pi-e2e-0001";
    const messageId = "message-pi-e2e-0001";
    const response = await port.request({
      id: "send-1",
      method: "sendUserMessage",
      params: {
        sessionId,
        messageId,
        content: "Reply with exactly PI_PORT_OK and nothing else.",
        attachments: [],
        developerInstructions: "You are a Vermillion test session.",
        deliveredDeveloperInstructions: ""
      }
    });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    const turnId = response.result?.turnId as string;
    expect(turnId.length).toBeGreaterThan(0);

    await waitFor(() =>
      events.find(
        (event) =>
          event.method === "turn.completed" && event.params.turnId === turnId
      )
    );
    const texts = events
      .filter(
        (event) =>
          event.method === "message.delta" && event.params.turnId === turnId
      )
      .map((event) => String(event.params.delta))
      .join("");
    expect(texts).toContain("PI_PORT_OK");
    expect(
      events.some(
        (event) =>
          event.method === "turn.started" && event.params.turnId === turnId
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.method === "message.completed" && event.params.turnId === turnId
      )
    ).toBe(true);

    const provider = new PiSessionDiscoveryProvider({ runtimePort: port });
    const entry: SessionIndexEntry = {
      workspaceId: "workspace-pi-e2e",
      sessionId,
      conversationId: "conversation-pi-e2e",
      engineId: "pi",
      providerKind: "pi-session",
      providerSessionId: piSessionIdForSession(sessionId),
      title: "pi runtime port e2e",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      unreadState: "read",
      source: "registry",
      metadata: { cwd: dataDir }
    };
    const snapshot = await provider.hydrateSession(entry);
    expect(snapshot?.turns.map((turn) => turn.turnId)).toContain(turnId);
    const userMessageId = `${sessionId}:${messageId}`;
    expect(
      snapshot?.messageBlocks.filter((block) => block.role === "user").map((block) => block.messageId)
    ).toContain(userMessageId);
    expect(
      snapshot?.messageBlocks.filter((block) => block.role === "assistant").length
    ).toBeGreaterThan(0);
  }, 180_000);

  it("streams tool and terminal output, then forks the session at a turn", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vermillion-pi-fork-"));
    const events: PiRuntimeEvent[] = [];
    port = new PiRuntimePort({
      engineId: "pi",
      resolveCommand: async () => {
        const command = resolveEngineProgramCommand("pi", { program: piProgram });
        return {
          commandPath: command.resolvedPath ?? command.path,
          commandArgs: command.args,
          found: command.found
        };
      },
      resolveSessionDirectory: (sessionId) =>
        join(dataDir!, "pi-sessions", piSessionIdForSession(sessionId)),
      resolvePiSessionId: piSessionIdForSession,
      resolveSessionCwd: async () => dataDir!,
      resolveExtensionPath: () => extensionPath
    });
    port.subscribe((event) => {
      events.push(event);
    });
    await port.start();

    const sessionId = "session-pi-fork-0001";
    const first = await port.request({
      id: "send-tool",
      method: "sendUserMessage",
      params: {
        sessionId,
        messageId: "message-pi-fork-0001",
        content:
          "Run the bash tool with command `echo PORT_TOOL_OK` and then reply with exactly DONE.",
        attachments: []
      }
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    const turnId = first.result?.turnId as string;
    await waitFor(() =>
      events.find(
        (event) =>
          event.method === "turn.completed" && event.params.turnId === turnId
      )
    );
    expect(
      events.some((event) => event.method === "tool.started")
    ).toBe(true);
    expect(
      events
        .filter((event) => event.method === "terminal.output")
        .map((event) => String(event.params.chunk))
        .join("")
    ).toContain("PORT_TOOL_OK");
    expect(
      events.some(
        (event) =>
          event.method === "tool.completed" &&
          event.params.status === "completed"
      )
    ).toBe(true);

    const indexStore = new SessionIndexStore({ baseDir: dataDir });
    const now = new Date().toISOString();
    const parentEntry: SessionIndexEntry = {
      workspaceId: "workspace-pi-fork",
      sessionId,
      conversationId: "conversation-pi-fork",
      engineId: "pi",
      providerKind: "pi-session",
      providerSessionId: piSessionIdForSession(sessionId),
      title: "pi fork parent",
      createdAt: now,
      updatedAt: now,
      unreadState: "read",
      source: "registry",
      metadata: { cwd: dataDir }
    };
    await indexStore.upsertSession({
      workspaceId: parentEntry.workspaceId,
      session: parentEntry,
      providerKind: parentEntry.providerKind,
      providerSessionId: parentEntry.providerSessionId
    });
    const actions = new PiSessionActionsProvider({ runtimePort: port });
    const result = await actions.runAction({
      sessionId,
      engineId: "pi",
      indexEntry: parentEntry,
      runtimeService: {} as unknown as SessionRuntimeService,
      sessionIndexStore: indexStore,
      sessionIdentity: {} as SessionActionProviderContext["sessionIdentity"],
      action: "fork",
      fromTurnId: turnId,
      activateFork: false
    });
    expect(result?.action === "fork" && result.status === "forked").toBe(true);
    if (!result || result.action !== "fork" || result.status !== "forked") {
      return;
    }
    expect(result.forkedSessionId).not.toBe(sessionId);
    const childEntry = indexStore.getEntry(result.forkedSessionId);
    expect(childEntry?.metadata?.forkSourceTurnId).toBe(turnId);

    const provider = new PiSessionDiscoveryProvider({ runtimePort: port });
    const parentSnapshot = await provider.hydrateSession(parentEntry);
    expect(parentSnapshot?.turns.map((turn) => turn.turnId)).toEqual([turnId]);
    const childSnapshot = await provider.hydrateSession(childEntry!);
    // The fork point belongs to the inherited prefix, so the child still owns no turn.
    expect(childSnapshot?.turns).toEqual([]);
    expect(childSnapshot?.sessionRelations[0]?.parentSessionId).toBe(sessionId);
    expect(childSnapshot?.sessionRelations[0]?.sourceTurnId).toBe(turnId);

    const childSend = await port.request({
      id: "send-child",
      method: "sendUserMessage",
      params: {
        sessionId: result.forkedSessionId,
        messageId: "message-pi-fork-child-1",
        content: "Reply with exactly CHILD_OK.",
        attachments: []
      }
    });
    expect(childSend.ok, JSON.stringify(childSend.error)).toBe(true);
    const childTurnId = childSend.result?.turnId as string;
    await waitFor(() =>
      events.find(
        (event) =>
          event.method === "turn.completed" && event.params.turnId === childTurnId
      )
    );
    const childAfter = await provider.hydrateSession(childEntry!);
    expect(childAfter?.turns.map((turn) => turn.turnId)).toEqual([childTurnId]);
    const parentAfter = await provider.hydrateSession(parentEntry);
    expect(parentAfter?.turns.map((turn) => turn.turnId)).toEqual([turnId]);
  }, 240_000);

  it("delivers a steering message inside the running turn and stops it", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vermillion-pi-steer-"));
    const events: PiRuntimeEvent[] = [];
    port = new PiRuntimePort({
      engineId: "pi",
      resolveCommand: async () => {
        const command = resolveEngineProgramCommand("pi", { program: piProgram });
        return {
          commandPath: command.resolvedPath ?? command.path,
          commandArgs: command.args,
          found: command.found
        };
      },
      resolveSessionDirectory: (sessionId) =>
        join(dataDir!, "pi-sessions", piSessionIdForSession(sessionId)),
      resolvePiSessionId: piSessionIdForSession,
      resolveSessionCwd: async () => dataDir!,
      resolveExtensionPath: () => extensionPath
    });
    port.subscribe((event) => {
      events.push(event);
    });
    await port.start();

    const sessionId = "session-pi-steer-0001";
    const started = await port.request({
      id: "send-long",
      method: "sendUserMessage",
      params: {
        sessionId,
        messageId: "message-pi-steer-0001",
        content:
          "Use the bash tool to run `sleep 20` and then reply with exactly LONG_DONE.",
        attachments: []
      }
    });
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    const turnId = started.result?.turnId as string;
    await waitFor(() =>
      events.find((event) => event.method === "tool.started") ? true : undefined
    );

    const steered = await port.request({
      id: "steer-1",
      method: "steerTurn",
      params: {
        sessionId,
        turnId,
        messageId: "message-pi-steer-0002",
        content: "Stop using tools and reply with exactly STEERED_OK.",
        attachments: []
      }
    });
    expect(steered.ok, JSON.stringify(steered.error)).toBe(true);
    expect(steered.result?.delivery).toBe("steered");
    expect(steered.result?.turnId).toBe(turnId);

    await waitFor(
      () =>
        events.find(
          (event) =>
            event.method === "turn.completed" && event.params.turnId === turnId
        ),
      60_000
    );

    const snapshot = await new PiSessionDiscoveryProvider({
      runtimePort: port
    }).hydrateSession({
      workspaceId: "workspace-pi-steer",
      sessionId,
      conversationId: "conversation-pi-steer",
      engineId: "pi",
      providerKind: "pi-session",
      providerSessionId: piSessionIdForSession(sessionId),
      title: "pi steer",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      unreadState: "read",
      source: "registry",
      metadata: { cwd: dataDir }
    });
    const userMessageIds = snapshot?.messageBlocks
      .filter((block) => block.role === "user")
      .map((block) => block.messageId);
    expect(userMessageIds).toEqual([
      `${sessionId}:message-pi-steer-0001`,
      `${sessionId}:message-pi-steer-0002`
    ]);
  }, 240_000);
});
