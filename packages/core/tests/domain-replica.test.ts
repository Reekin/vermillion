import { describe, expect, it } from "vitest";
import { DomainReplica } from "../src/domain-replica.js";

const now = "2026-04-21T00:00:00.000Z";

describe("DomainReplica", () => {
  it("applies runtime events and exposes read selectors", () => {
    const replica = new DomainReplica({
      now: () => now
    });

    replica.apply({
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-a",
      engineId: "agent-a",
      status: "idle"
    });

    expect(replica.getRevision()).toBe(1);
    expect(replica.readModel.getRevision()).toBe(1);
    expect(replica.readModel.getSession("session-a")).toMatchObject({
      sessionId: "session-a",
      conversationId: "conversation-a",
      engineId: "agent-a"
    });
    expect(replica.readModel.getConversationSnapshot("conversation-a")).toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId: "conversation-a"
        })
      ],
      sessions: [
        expect.objectContaining({
          sessionId: "session-a"
        })
      ],
      participants: [
        expect.objectContaining({
          engineId: "agent-a",
          activeSessionIds: ["session-a"]
        })
      ]
    });
    expect("apply" in replica.readModel).toBe(false);
    expect("replaceSnapshot" in replica.readModel).toBe(false);
  });

  it("applies envelopes with their occurrence time", () => {
    const replica = new DomainReplica();

    replica.applyEnvelope({
      occurredAt: "2026-04-21T00:02:00.000Z",
      event: {
        type: "turn.started",
        sessionId: "session-a",
        turnId: "turn-a"
      }
    });

    expect(replica.readModel.getTurn("turn-a")).toMatchObject({
      turnId: "turn-a",
      startedAt: "2026-04-21T00:02:00.000Z"
    });
  });

  it("rejects an invalid batch before projecting any earlier event", () => {
    const replica = new DomainReplica({ now: () => now });

    expect(() =>
      replica.applyBatch([
        {
          event: {
            type: "session.created",
            conversationId: "conversation-a",
            sessionId: "session-a",
            engineId: "agent-a",
            status: "idle"
          }
        },
        {
          event: {
            type: "session.created",
            conversationId: "conversation-a",
            sessionId: "session-b",
            engineId: "agent-a",
            status: "idle",
            relation: {
              relationId: "relation-cycle",
              parentSessionId: "session-b",
              childSessionId: "session-b",
              relationType: "subagent",
              createdAt: now
            }
          }
        }
      ])
    ).toThrow(/cycle/);

    expect(replica.getRevision()).toBe(0);
    expect(replica.readModel.listSessions({ includeArchived: true })).toEqual([]);
  });

  it("replaces and merges snapshots through the same read model", () => {
    const replica = new DomainReplica();

    replica.replaceSnapshot({
      conversations: [
        {
          conversationId: "conversation-a",
          participantEngineIds: ["agent-a"],
          sessionIds: ["session-a"],
          createdAt: now,
          updatedAt: now
        }
      ],
      sessions: [
        {
          sessionId: "session-a",
          conversationId: "conversation-a",
          engineId: "agent-a",
          status: "idle",
          createdAt: now,
          updatedAt: now
        }
      ],
      turns: [],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    });

    replica.mergeSnapshot(
      {
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            sessionIds: ["session-b"],
            createdAt: now,
            updatedAt: now
          }
        ],
        sessions: [
          {
            sessionId: "session-b",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "idle",
            createdAt: now,
            updatedAt: now
          }
        ],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        runtimeInteractions: [],
        participants: [],
        threadGoals: [],
        sessionRelations: []
      },
      { scope: { conversationId: "conversation-a" } }
    );

    expect(replica.getRevision()).toBe(2);
    expect(
      replica.readModel
        .listSessions({ includeArchived: true })
        .map((session) => session.sessionId)
        .sort()
    ).toEqual(["session-a", "session-b"]);
    expect(replica.readModel.resolveConversationIdBySessionId("session-b")).toBe(
      "conversation-a"
    );
  });

  it("replaces several session windows in one replica update", () => {
    const replica = new DomainReplica();
    const snapshot = (
      turns: Array<{ turnId: string; sessionId: string }>,
      sessionIds = ["session-a"],
      status: "completed" | "streaming" = "completed"
    ) => ({
      conversations: [{
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        sessionIds: ["session-a", "session-b"],
        createdAt: now,
        updatedAt: now
      }],
      sessions: sessionIds.map((sessionId) => ({
        sessionId,
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "idle" as const,
        createdAt: now,
        updatedAt: now
      })),
      turns: turns.map(({ turnId, sessionId }) => ({
        turnId,
        sessionId,
        status,
        startedAt: now,
        messageIds: [],
        toolCallIds: [],
        terminalIds: [],
        approvalRequestIds: [],
        interactionRequestIds: []
      })),
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    });

    replica.replaceSnapshot(snapshot([
      { turnId: "turn-a-old", sessionId: "session-a" },
      { turnId: "turn-b-old", sessionId: "session-b" }
    ], ["session-a", "session-b"]));
    const before = replica.getRevision();

    replica.replaceSessionWindowSnapshots([
      {
        sessionId: "session-a",
        snapshot: snapshot([{ turnId: "turn-a-old", sessionId: "session-a" }], ["session-a"], "streaming")
      },
      {
        sessionId: "session-b",
        snapshot: snapshot([{ turnId: "turn-b-old", sessionId: "session-b" }], ["session-b"], "streaming")
      }
    ]);

    expect(replica.getRevision()).toBe(before + 1);
    expect(replica.readModel.getTurn("turn-a-old")?.status).toBe("streaming");
    expect(replica.readModel.getTurn("turn-b-old")?.status).toBe("streaming");
  });

  it("does not partially apply a failed multi-window replacement", () => {
    const replica = new DomainReplica();
    const snapshot = (status: "completed" | "streaming") => ({
      conversations: [{
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        sessionIds: ["session-a"],
        createdAt: now,
        updatedAt: now
      }],
      sessions: [{
        sessionId: "session-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "idle" as const,
        createdAt: now,
        updatedAt: now
      }],
      turns: [{
        turnId: "turn-a",
        sessionId: "session-a",
        status,
        startedAt: now,
        messageIds: [],
        toolCallIds: [],
        terminalIds: [],
        approvalRequestIds: [],
        interactionRequestIds: []
      }],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    });

    replica.replaceSnapshot(snapshot("completed"));
    const before = replica.getRevision();

    expect(() => replica.replaceSessionWindowSnapshots([
      { sessionId: "session-a", snapshot: snapshot("streaming") },
      { sessionId: "session-b", snapshot: snapshot("streaming") }
    ])).toThrow(/outside merge scope/);

    expect(replica.getRevision()).toBe(before);
    expect(replica.readModel.getTurn("turn-a")?.status).toBe("completed");
  });

  it("clears read state on dispose and rejects later mutations", () => {
    const replica = new DomainReplica();

    replica.apply({
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-a",
      engineId: "agent-a",
      status: "idle"
    });
    replica.dispose();

    expect(replica.isDisposed()).toBe(true);
    expect(replica.readModel.isDisposed()).toBe(true);
    expect(replica.readModel.getSnapshot().sessions).toEqual([]);
    expect(replica.getRevision()).toBe(2);
    expect(() =>
      replica.apply({
        type: "session.updated",
        conversationId: "conversation-a",
        sessionId: "session-a",
        status: "running"
      })
    ).toThrow("DomainReplica has been disposed");
  });
});
