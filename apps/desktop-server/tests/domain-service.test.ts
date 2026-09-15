import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@vermillion/shared";
import { DomainService } from "../src/domain-service.js";

describe("DomainService", () => {
  it("creates sessions and projects participant, session, and conversation state", () => {
    const publishedEvents: RuntimeEvent[] = [];
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:00:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat", "terminal"],
      publishRuntimeEvent: (event) => {
        publishedEvents.push(event);
      }
    });

    const session = service.createSession({
      conversationId: "conversation-1",
      engineId: "codex",
      workspaceId: "workspace-1",
      metadata: {
        source: "test"
      }
    });

    expect(session).toMatchObject({
      sessionId: "session-1",
      conversationId: "conversation-1",
      engineId: "codex",
      metadata: {
        source: "test"
      }
    });
    expect(service.getSnapshot()).toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          activeSessionId: "session-1"
        })
      ],
      sessions: [
        expect.objectContaining({
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex"
        })
      ],
      participants: [
        expect.objectContaining({
          conversationId: "conversation-1",
          engineId: "codex",
          activeSessionIds: ["session-1"]
        })
      ]
    });
    expect(publishedEvents.map((event) => event.type)).toEqual([
      "participant.updated",
      "session.created",
      "conversation.updated"
    ]);
  });

  it("uses the domain replica for session list/get/archive/resume/dispose state", () => {
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:03:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-domain-owner",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {}
    });

    const created = service.createSession({
      conversationId: "conversation-domain-owner",
      engineId: "codex",
      metadata: {
        cwd: "I:/workspace/project"
      }
    });

    expect(service.getSession(created.sessionId)).toMatchObject({
      sessionId: "session-domain-owner",
      metadata: {
        cwd: "I:/workspace/project"
      }
    });
    expect(service.listSessions()).toHaveLength(1);

    const archived = service.archiveSession(created.sessionId);
    expect(archived.archivedAt).toBeDefined();
    expect(service.listSessions()).toEqual([]);
    expect(service.listSessions({ includeArchived: true })).toHaveLength(1);

    const resumed = service.resumeSession(created.sessionId);
    expect(resumed.archivedAt).toBeUndefined();
    expect(service.listSessions()).toEqual([
      expect.objectContaining({
        sessionId: created.sessionId
      })
    ]);

    expect(service.disposeSession(created.sessionId)).toBe(true);
    expect(service.getSession(created.sessionId)).toBeUndefined();
    expect(service.listSessions({ includeArchived: true })).toEqual([]);
  });

  it("hydrates discovered sessions into the same canonical session store", () => {
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:04:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-hydrated",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat", "terminal"],
      publishRuntimeEvent: () => {}
    });
    service.createSession({
      conversationId: "conversation-hydrated",
      engineId: "codex",
      workspaceId: "workspace-hydrated"
    });
    service.commitAcceptedUserMessage(
      {
        type: "sendUserMessage",
        sessionId: "session-hydrated",
        messageId: "local-user-message",
        content: "hello",
        attachments: []
      },
      "turn-hydrated"
    );

    const hydrated = service.hydrateDiscoveredSession({
      workspaceId: "workspace-hydrated",
      conversation: {
        conversationId: "conversation-hydrated",
        workspaceId: "workspace-hydrated",
        participantEngineIds: ["codex"],
        activeSessionId: "session-hydrated",
        sessionIds: ["session-hydrated"],
        createdAt: "2026-04-19T00:00:00Z",
        updatedAt: "2026-04-19T00:01:00Z"
      },
      session: {
        sessionId: "session-hydrated",
        conversationId: "conversation-hydrated",
        engineId: "codex",
        status: "idle",
        title: "Hydrated session",
        createdAt: "2026-04-19T00:00:00Z",
        updatedAt: "2026-04-19T00:01:00Z",
        metadata: {
          providerSessionId: "thread-hydrated"
        }
      },
      turns: [
        {
          turnId: "turn-hydrated",
          sessionId: "session-hydrated",
          status: "completed",
          finishReason: "completed",
          startedAt: "2026-04-19T00:00:10Z",
          completedAt: "2026-04-19T00:00:20Z",
          messageIds: ["session-hydrated:local-user-message"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: []
        }
      ],
      messageBlocks: [
        {
          blockId: "session-hydrated:local-user-message:md",
          messageId: "session-hydrated:local-user-message",
          sessionId: "session-hydrated",
          turnId: "turn-hydrated",
          role: "user",
          kind: "markdown",
          text: "hello",
          startedAt: "2026-04-19T00:00:10Z",
          completedAt: "2026-04-19T00:00:10Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: []
    });

    expect(hydrated.sessionId).toBe("session-hydrated");
    expect(service.getSession("session-hydrated")).toMatchObject({
      title: "Hydrated session",
      metadata: {
        providerSessionId: "thread-hydrated"
      }
    });
    expect(service.listSessions({ conversationId: "conversation-hydrated" })).toEqual([
      expect.objectContaining({
        sessionId: "session-hydrated"
      })
    ]);
    const snapshot = service.getSnapshot();
    expect(snapshot.turns[0]?.messageIds).toEqual([
      "session-hydrated:local-user-message"
    ]);
    expect(snapshot.messageBlocks.filter((block) => block.role === "user")).toEqual([
      expect.objectContaining({
        messageId: "session-hydrated:local-user-message",
        text: "hello"
      })
    ]);
  });

  it("merges a hydrated user message into its local echo and keeps the local turn order", () => {
    const service = new DomainService({
      now: () => "2026-04-20T00:04:00Z",
      createSessionId: () => "session-hydrated-order",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {}
    });
    service.createSession({
      conversationId: "conversation-hydrated-order",
      engineId: "codex",
      workspaceId: "workspace-hydrated-order"
    });
    service.commitAcceptedUserMessage(
      {
        type: "sendUserMessage",
        sessionId: "session-hydrated-order",
        messageId: "local-user-message",
        content: "hello",
        attachments: []
      },
      "turn-hydrated-order"
    );
    service.ingestRuntimeEvent(
      {
        type: "message.started",
        sessionId: "session-hydrated-order",
        turnId: "turn-hydrated-order",
        messageId: "assistant-live-message",
        role: "assistant"
      },
      "2026-04-20T00:04:01Z"
    );
    service.ingestRuntimeEvent(
      {
        type: "message.completed",
        sessionId: "session-hydrated-order",
        turnId: "turn-hydrated-order",
        messageId: "assistant-live-message",
        role: "assistant",
        finalText: "answer",
        isFinalForTurn: true
      },
      "2026-04-20T00:04:02Z"
    );

    service.hydrateDiscoveredSession({
      workspaceId: "workspace-hydrated-order",
      conversation: {
        conversationId: "conversation-hydrated-order",
        workspaceId: "workspace-hydrated-order",
        participantEngineIds: ["codex"],
        activeSessionId: "session-hydrated-order",
        sessionIds: ["session-hydrated-order"],
        createdAt: "2026-04-20T00:04:00Z",
        updatedAt: "2026-04-20T00:04:03Z"
      },
      session: {
        sessionId: "session-hydrated-order",
        conversationId: "conversation-hydrated-order",
        engineId: "codex",
        status: "idle",
        createdAt: "2026-04-20T00:04:00Z",
        updatedAt: "2026-04-20T00:04:03Z",
        metadata: {
          providerSessionId: "thread-hydrated-order"
        }
      },
      turns: [
        {
          turnId: "turn-hydrated-order",
          sessionId: "session-hydrated-order",
          status: "completed",
          finishReason: "completed",
          startedAt: "2026-04-20T00:04:00Z",
          completedAt: "2026-04-20T00:04:03Z",
          finalMessageId: "hydrated-assistant-message",
          messageIds: [
            "session-hydrated-order:local-user-message",
            "hydrated-assistant-message"
          ],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: []
        }
      ],
      messageBlocks: [
        {
          blockId: "session-hydrated-order:local-user-message:md",
          messageId: "session-hydrated-order:local-user-message",
          sessionId: "session-hydrated-order",
          turnId: "turn-hydrated-order",
          role: "user",
          kind: "markdown",
          text: "hello",
          startedAt: "2026-04-20T00:04:00Z",
          completedAt: "2026-04-20T00:04:00Z"
        },
        {
          blockId: "hydrated-assistant-message:md",
          messageId: "hydrated-assistant-message",
          sessionId: "session-hydrated-order",
          turnId: "turn-hydrated-order",
          role: "assistant",
          kind: "markdown",
          text: "answer",
          startedAt: "2026-04-20T00:04:02Z",
          completedAt: "2026-04-20T00:04:02Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: []
    });

    expect(service.getSnapshot().turns[0]?.messageIds).toEqual([
      "session-hydrated-order:local-user-message",
      "assistant-live-message",
      "hydrated-assistant-message"
    ]);
  });

  it("keeps one entity per engine item when an active session merges its own hydrated turn", () => {
    const sessionId = "session-live-merge";
    const turnId = "turn-live-merge";
    const service = new DomainService({
      now: () => "2026-04-20T00:05:00Z",
      createSessionId: () => sessionId,
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat", "terminal"],
      publishRuntimeEvent: () => {}
    });
    service.createSession({
      conversationId: "conversation-live-merge",
      engineId: "codex",
      workspaceId: "workspace-live-merge"
    });
    service.commitAcceptedUserMessage(
      {
        type: "sendUserMessage",
        sessionId,
        messageId: "client-message",
        content: "hello",
        attachments: []
      },
      turnId
    );
    service.ingestRuntimeEvent(
      {
        type: "message.completed",
        sessionId,
        turnId,
        messageId: `${sessionId}:msg-assistant`,
        role: "assistant",
        finalText: "answer",
        isFinalForTurn: true,
        engineId: "codex"
      },
      "2026-04-20T00:05:01Z"
    );
    service.ingestRuntimeEvent(
      {
        type: "tool.completed",
        sessionId,
        turnId,
        toolCallId: `${sessionId}:cmd-1`,
        status: "completed",
        outputSummary: "ok",
        engineId: "codex"
      },
      "2026-04-20T00:05:02Z"
    );
    service.ingestRuntimeEvent(
      {
        type: "terminal.completed",
        sessionId,
        turnId,
        terminalId: `${sessionId}:cmd-1`,
        exitCode: 0,
        engineId: "codex"
      },
      "2026-04-20T00:05:02Z"
    );

    service.hydrateDiscoveredSession({
      workspaceId: "workspace-live-merge",
      conversation: {
        conversationId: "conversation-live-merge",
        workspaceId: "workspace-live-merge",
        participantEngineIds: ["codex"],
        activeSessionId: sessionId,
        sessionIds: [sessionId],
        createdAt: "2026-04-20T00:05:00Z",
        updatedAt: "2026-04-20T00:05:03Z"
      },
      session: {
        sessionId,
        conversationId: "conversation-live-merge",
        engineId: "codex",
        status: "running",
        createdAt: "2026-04-20T00:05:00Z",
        updatedAt: "2026-04-20T00:05:03Z",
        metadata: {
          providerSessionId: "thread-live-merge"
        }
      },
      turns: [
        {
          turnId,
          sessionId,
          status: "completed",
          finishReason: "completed",
          startedAt: "2026-04-20T00:05:00Z",
          completedAt: "2026-04-20T00:05:03Z",
          finalMessageId: `${sessionId}:msg-assistant`,
          messageIds: [
            `${sessionId}:client-message`,
            `${sessionId}:msg-assistant`
          ],
          toolCallIds: [`${sessionId}:cmd-1`],
          terminalIds: [`${sessionId}:cmd-1`],
          approvalRequestIds: [],
          interactionRequestIds: []
        }
      ],
      messageBlocks: [
        {
          blockId: `${sessionId}:client-message:md`,
          messageId: `${sessionId}:client-message`,
          sessionId,
          turnId,
          role: "user",
          kind: "markdown",
          text: "hello",
          startedAt: "2026-04-20T00:05:00Z",
          completedAt: "2026-04-20T00:05:00Z"
        },
        {
          blockId: `${sessionId}:msg-assistant:md`,
          messageId: `${sessionId}:msg-assistant`,
          sessionId,
          turnId,
          role: "assistant",
          kind: "markdown",
          text: "answer",
          startedAt: "2026-04-20T00:05:01Z",
          completedAt: "2026-04-20T00:05:01Z"
        }
      ],
      toolCalls: [
        {
          toolCallId: `${sessionId}:cmd-1`,
          sessionId,
          turnId,
          toolName: "commandExecution",
          status: "completed",
          inputSummary: "pnpm test",
          outputSummary: "ok",
          startedAt: "2026-04-20T00:05:02Z",
          completedAt: "2026-04-20T00:05:02Z"
        }
      ],
      terminalStreams: [
        {
          terminalId: `${sessionId}:cmd-1`,
          sessionId,
          turnId,
          toolCallId: `${sessionId}:cmd-1`,
          status: "completed",
          outputText: "ok\n",
          exitCode: 0,
          startedAt: "2026-04-20T00:05:02Z",
          completedAt: "2026-04-20T00:05:02Z"
        }
      ],
      sessionRelations: []
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.messageIds).toEqual([
      `${sessionId}:client-message`,
      `${sessionId}:msg-assistant`
    ]);
    expect(snapshot.messageBlocks.map((block) => block.messageId)).toEqual([
      `${sessionId}:client-message`,
      `${sessionId}:msg-assistant`
    ]);
    expect(snapshot.toolCalls.map((toolCall) => toolCall.toolCallId)).toEqual([
      `${sessionId}:cmd-1`
    ]);
    expect(snapshot.terminalStreams.map((stream) => stream.terminalId)).toEqual([
      `${sessionId}:cmd-1`
    ]);
  });

  it("marks unread completed when a turn finishes", () => {
    const markSessionUnreadCompleted = vi.fn();
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:01:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {},
      markSessionUnreadCompleted
    });

    service.createSession({
      conversationId: "conversation-1",
      engineId: "codex"
    });
    service.ingestRuntimeEvent({
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    });
    service.ingestRuntimeEvent({
      type: "turn.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      finishReason: "completed"
    });

    expect(markSessionUnreadCompleted).toHaveBeenCalledWith("session-1");
    expect(service.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        status: "idle",
        lastTurnId: "turn-1"
      })
    ]);
  });

  it("appends steer messages to the active turn without creating a new turn", () => {
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:02:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {}
    });

    service.createSession({
      conversationId: "conversation-1",
      engineId: "codex"
    });
    service.ingestRuntimeEvent({
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    });

    service.commitSteerUserMessage({
      type: "steerTurn",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-steer-1",
      content: "Please focus on the diagnostics failure.",
      attachments: []
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        messageIds: ["session-1:message-steer-1"]
      })
    ]);
    expect(snapshot.messageBlocks).toEqual([
      expect.objectContaining({
        messageId: "session-1:message-steer-1",
        text: "Please focus on the diagnostics failure."
      })
    ]);
  });
});
