import { describe, expect, it } from "vitest";
import {
  resolveComposerStatus,
  resolveRecoveryNotice,
  resolveComposerStatusModel
} from "../src/ui/chat-shell/composer-status.js";

describe("resolveRecoveryNotice", () => {
  it("preserves unrelated notices and clears only the recovered session's failure", () => {
    const failure = { status: "failed", message: "offline" };
    const notice = resolveRecoveryNotice(undefined, "a", failure, undefined)!;
    expect(notice.message).toBe("Session reconnect failed: offline. Use Resume to retry.");
    expect(resolveRecoveryNotice(notice, "b", { status: "ready" }, undefined)).toBe(notice);
    expect(resolveRecoveryNotice(notice, "a", { status: "ready" }, undefined)).toBeUndefined();
    const unrelated = { source: "send", message: "send failed" } as const;
    expect(resolveRecoveryNotice(unrelated, "a", failure, failure)).toBe(unrelated);
  });

  it("keeps tree refresh failures visible when execution recovers", () => {
    const ready = { status: "ready" };
    const notice = resolveRecoveryNotice(undefined, "a", ready, { status: "failed", message: "missing" });
    expect(notice?.message).toBe("Chat tree refresh failed: missing");
    expect(resolveRecoveryNotice(notice, "a", ready, undefined)).toBe(notice);
    expect(resolveRecoveryNotice(notice, "a", ready, ready)).toBeUndefined();
  });
});

describe("resolveComposerStatus", () => {
  it("prefers pending approval state over generic session readiness", () => {
    const status = resolveComposerStatusModel({
      selectedEngineId: "codex",
      activeSession: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        status: "awaiting_approval",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z"
      },
      approvals: [
        {
          requestId: "0",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalKind: "command",
          status: "pending",
          title: "Approve command execution",
          requestedAt: "2026-04-18T00:00:00.000Z"
        }
      ]
    });

    expect(status).toEqual({
      kind: "awaiting_approval",
      label: "Awaiting approval",
      detail: "Approval requested for 0"
    });
    expect(resolveComposerStatus({
      selectedEngineId: "codex",
      activeSession: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        status: "awaiting_approval",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z"
      },
      approvals: [
        {
          requestId: "0",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalKind: "command",
          status: "pending",
          title: "Approve command execution",
          requestedAt: "2026-04-18T00:00:00.000Z"
        }
      ]
    })).toBe("Awaiting approval: Approval requested for 0");
  });

  it("falls back to active-session readiness after approval is resolved", () => {
    expect(
      resolveComposerStatus({
          selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        approvals: [
          {
            requestId: "0",
            sessionId: "session-1",
            turnId: "turn-1",
            approvalKind: "command",
            status: "approved",
            title: "Approve command execution",
            requestedAt: "2026-04-18T00:00:00.000Z",
            resolvedAt: "2026-04-18T00:00:05.000Z"
          }
        ]
      })
    ).toBe("Ready: In session-1");
  });

  it("keeps explicit notices separate from the derived baseline", () => {
    expect(
      resolveComposerStatus({
          selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "running",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        notice: {
          message: "Message sent.",
          source: "send"
        },
        supportsSteer: true
      })
    ).toBe("Running: Steer supported");
  });

  it("surfaces queued follow-ups when the session is otherwise idle", () => {
    expect(
      resolveComposerStatusModel({
          selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        queuedCount: 2
      })
    ).toEqual({
      kind: "queue_pending",
      label: "2 queued",
      detail: "Will auto-send when idle"
    });
  });

  it("describes steer capability while a session is running", () => {
    expect(
      resolveComposerStatusModel({
          selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "running",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        supportsSteer: true
      })
    ).toEqual({
      kind: "running",
      label: "Running",
      detail: "Steer supported"
    });
  });
});
