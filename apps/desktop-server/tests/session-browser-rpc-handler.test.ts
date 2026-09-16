import { describe, expect, it, vi } from "vitest";
import { createWorkbenchRpcHandler } from "../src/session-rpc-handler.js";
import type { SessionShellService } from "../src/session-shell-service.js";

const createShell = (overrides: Record<string, unknown> = {}): SessionShellService => ({
  listWorkspaces: vi.fn(),
  listBrowserSessions: vi.fn(async () => ({
    workspaceId: "workspace-1",
    revision: "revision-1",
    items: []
  })),
  changesBrowserSessions: vi.fn(async () => ({
    status: "changed",
    workspaceId: "workspace-1",
    revision: "revision-2",
    items: [],
    removedSessionIds: []
  })),
  ...overrides
} as unknown as SessionShellService);

describe("session browser workbench RPC handler", () => {
  it("routes the full session list request", async () => {
    const shell = createShell();

    const snapshot = await createWorkbenchRpcHandler(shell).handleRequest({
      id: "req-list",
      method: "sessionBrowser.list",
      params: { workspaceId: "workspace-1" }
    });

    expect(snapshot).toMatchObject({ ok: true, method: "sessionBrowser.list" });
    expect(shell.listBrowserSessions).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
  });

  it("routes the changed-row request", async () => {
    const shell = createShell();

    const changes = await createWorkbenchRpcHandler(shell).handleRequest({
      id: "req-changes",
      method: "sessionBrowser.changes",
      params: { workspaceId: "workspace-1", revision: "revision-1" }
    });

    expect(changes).toMatchObject({ ok: true, method: "sessionBrowser.changes" });
    expect(shell.changesBrowserSessions).toHaveBeenCalledWith({ workspaceId: "workspace-1", revision: "revision-1" });
  });

  it("routes session renames to the shell service", async () => {
    const shell = createShell({
      renameSession: vi.fn(async () => ({
        sessionId: "session-1",
        title: "Renamed session"
      }))
    });

    const response = await createWorkbenchRpcHandler(shell).handleRequest({
      id: "req-rename",
      method: "sessionBrowser.rename",
      params: {
        sessionId: "session-1",
        title: "Renamed session"
      }
    });

    expect(response).toMatchObject({
      ok: true,
      method: "sessionBrowser.rename",
      result: {
        sessionId: "session-1",
        title: "Renamed session"
      }
    });
    expect(shell.renameSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "Renamed session"
    });
  });
});
