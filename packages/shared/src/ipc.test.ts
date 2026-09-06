import { describe, expect, it } from "vitest";
import { parseSessionRpcRequest, safeParseSessionRpcResponse } from "./ipc.js";

describe("IPC schemas", () => {
  it("parses bounded session browser pages without transcript metadata", () => {
    const request = parseSessionRpcRequest({
      id: "req-roots",
      method: "sessionBrowser.list",
      params: { workspaceId: "workspace-1" }
    });
    expect(request.params).toMatchObject({ limit: 20 });

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
        }],
        hasMore: false,
        totalCount: 1
      }
    });
    expect(parsed.success).toBe(true);
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
