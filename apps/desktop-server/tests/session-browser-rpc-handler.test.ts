import { describe, expect, it, vi } from "vitest";
import { createWorkbenchRpcHandler } from "../src/session-rpc-handler.js";
import { SessionBrowserCursorStaleError } from "../src/session-browser-read-model.js";
import type { SessionShellService } from "../src/session-shell-service.js";

const createShell = (overrides: Record<string, unknown> = {}): SessionShellService => ({
  listWorkspaces: vi.fn(),
  listBrowserSessions: vi.fn(async () => ({
    workspaceId: "workspace-1",
    revision: "revision-1",
    items: [],
    hasMore: false,
    totalCount: 0
  })),
  ...overrides
} as unknown as SessionShellService);

describe("session browser workbench RPC handler", () => {
  it("routes bounded session list requests", async () => {
    const shell = createShell();
    const handler = createWorkbenchRpcHandler(shell);

    const page = await handler.handleRequest({
      id: "req-list",
      method: "sessionBrowser.list",
      params: { workspaceId: "workspace-1", limit: 20 }
    });

    expect(page).toMatchObject({ ok: true, method: "sessionBrowser.list" });
    expect(shell.listBrowserSessions).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 20 });
  });

  it("maps revision mismatch to CURSOR_STALE", async () => {
    const shell = createShell({
      listBrowserSessions: vi.fn(async () => {
        throw new SessionBrowserCursorStaleError();
      })
    });
    const response = await createWorkbenchRpcHandler(shell).handleRequest({
      id: "req-stale",
      method: "sessionBrowser.list",
      params: {
        workspaceId: "workspace-1",
        expectedRevision: "old-revision",
        limit: 20
      }
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "CURSOR_STALE" }
    });
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
