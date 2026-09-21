import { describe, expect, it } from "vitest";
import { parseSessionRpcRequest, safeParseSessionRpcResponse } from "./ipc.js";
import { parseCommandEnvelope } from "./commands.js";

describe("IPC schemas", () => {
  it("preserves a steer-only admission grant through command validation", () => {
    const input = parseCommandEnvelope({ commandId: "append", command: {
      type: "steerTurn", sessionId: "worker", turnId: "old", messageId: "input", content: "continue", allowStart: false
    } });
    expect(input.command).toMatchObject({ type: "steerTurn", allowStart: false });
  });

  it("preserves pending delivery without reporting engine acceptance", () => {
    const response = safeParseSessionRpcResponse({
      id: "request-send", method: "runtime.command", ok: true,
      result: {
        commandId: "command-send", commandType: "sendUserMessage", sessionId: "worker", accepted: false,
        queued: { messageId: "message-pending", reason: "等待前置工单", workItemId: "work-item" }
      }
    });
    expect(response.success).toBe(true);
    if (response.success) expect(response.data).toMatchObject({
      result: { accepted: false, queued: { messageId: "message-pending", reason: "等待前置工单" } }
    });
  });

  it("parses session browser snapshots without transcript metadata", () => {
    const request = parseSessionRpcRequest({
      id: "req-roots",
      method: "sessionBrowser.list",
      params: { workspaceId: "workspace-1" }
    });
    expect(request.params).toMatchObject({ workspaceId: "workspace-1" });

    const parsed = safeParseSessionRpcResponse({
      id: "req-roots",
      method: "sessionBrowser.list",
      ok: true,
      result: {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [{
          sessionId: "session-1",
          engineId: "codex",
          title: "Session",
          statusDot: "none",
          isActive: true,
          isPinned: false
        }]
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("parses session browser changes and the full snapshot request", () => {
    expect(parseSessionRpcRequest({
      id: "req-changes",
      method: "sessionBrowser.changes",
      params: { workspaceId: "workspace-1", revision: "revision-1" }
    }).params).toEqual({ workspaceId: "workspace-1", revision: "revision-1" });

    expect(safeParseSessionRpcResponse({
      id: "req-changes",
      method: "sessionBrowser.changes",
      ok: true,
      result: {
        status: "changed",
        workspaceId: "workspace-1",
        revision: "revision-2",
        items: [],
        removedSessionIds: ["session-2"]
      }
    }).success).toBe(true);

    expect(safeParseSessionRpcResponse({
      id: "req-changes",
      method: "sessionBrowser.changes",
      ok: true,
      result: { status: "full-required", workspaceId: "workspace-1" }
    }).success).toBe(true);
  });

  it("requires an explicit non-empty workspace batch for repair", () => {
    expect(
      parseSessionRpcRequest({
        id: "req-repair",
        method: "sessionBrowser.repair",
        params: { workspaceIds: ["workspace-1", "workspace-2"] }
      }).params
    ).toEqual({ workspaceIds: ["workspace-1", "workspace-2"] });

    expect(() =>
      parseSessionRpcRequest({
        id: "req-repair-missing",
        method: "sessionBrowser.repair",
        params: {}
      })
    ).toThrow();
    expect(() =>
      parseSessionRpcRequest({
        id: "req-repair-empty",
        method: "sessionBrowser.repair",
        params: { workspaceIds: [] }
      })
    ).toThrow();
    expect(() =>
      parseSessionRpcRequest({
        id: "req-repair-legacy",
        method: "sessionBrowser.repair",
        params: { workspaceId: "workspace-1" }
      })
    ).toThrow();
    expect(() =>
      parseSessionRpcRequest({
        id: "req-reconcile-removed",
        method: "sessionBrowser.reconcile",
        params: { workspaceIds: ["workspace-1"] }
      })
    ).toThrow();
  });
});
