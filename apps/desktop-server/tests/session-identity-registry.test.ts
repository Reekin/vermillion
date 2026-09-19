import { describe, expect, it, vi } from "vitest";
import { SessionIdentityRegistry } from "../src/session-identity-registry.js";
import type { SessionRuntimeService } from "../src/runtime-service.js";

describe("SessionIdentityRegistry", () => {
  it("prefers runtime provider handles and falls back to indexed identity", () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        {
          sessionId: "session-runtime",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          title: "Runtime session",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z"
        }
      ]),
      resolveProviderSessionHandle: vi.fn((sessionId: string) =>
        sessionId === "session-runtime"
          ? {
              providerKind: "codex-thread",
              providerSessionId: "thread-runtime"
            }
          : undefined
      )
    } as unknown as SessionRuntimeService;
    const registry = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn((sessionId: string) =>
          sessionId === "session-indexed"
            ? {
                sessionId,
                workspaceId: "workspace-1",
                conversationId: "conversation-1",
                engineId: "codex",
                providerKind: "codex-thread",
                providerSessionId: "thread-indexed",
                createdAt: "2026-04-20T00:00:00.000Z",
                updatedAt: "2026-04-20T00:00:00.000Z",
                source: "reconciled"
              }
            : undefined
        ),
        listEntries: vi.fn().mockReturnValue([
          {
            sessionId: "session-indexed",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            engineId: "codex",
            providerKind: "codex-thread",
            providerSessionId: "thread-indexed",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            source: "reconciled"
          }
        ])
      } as never
    });

    expect(registry.getProviderHandle("session-runtime")).toEqual({
      providerKind: "codex-thread",
      providerSessionId: "thread-runtime"
    });
    expect(registry.getProviderHandle("session-indexed")).toEqual({
      providerKind: "codex-thread",
      providerSessionId: "thread-indexed"
    });
  });

  it("resolves workbench aliases by provider handle across indexed and runtime sessions", () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        {
          sessionId: "session-runtime",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          title: "Runtime session",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          metadata: {
            providerKind: "codex-thread",
            providerSessionId: "thread-shared"
          }
        }
      ])
    } as unknown as SessionRuntimeService;
    const registry = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined),
        listEntries: vi.fn().mockReturnValue([
          {
            sessionId: "codex-thread:thread-shared",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            engineId: "codex",
            providerKind: "codex-thread",
            providerSessionId: "thread-shared",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:02.000Z",
            source: "reconciled"
          },
          {
            sessionId: "session-indexed",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            engineId: "codex",
            providerKind: "codex-thread",
            providerSessionId: "thread-shared",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            source: "reconciled"
          }
        ])
      } as never
    });

    expect(
      registry.listSessionIdsByProviderHandle({
        providerKind: "codex-thread",
        providerSessionId: "thread-shared"
      })
    ).toEqual([
      "codex-thread:thread-shared",
      "session-indexed",
      "session-runtime"
    ]);
    expect(
      registry.resolveWorkbenchSessionId({
        providerKind: "codex-thread",
        providerSessionId: "thread-shared"
      })
    ).toBe("session-runtime");
  });

  it("resolves an identifier given as a workbench id or as an engine session id", () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        {
          sessionId: "codex-thread:thread-subagent",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          metadata: {
            providerKind: "codex-thread",
            providerSessionId: "thread-subagent"
          }
        }
      ])
    } as unknown as SessionRuntimeService;
    const registry = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn((sessionId: string) =>
          sessionId === "session-pi"
            ? {
                sessionId,
                workspaceId: "workspace-1",
                conversationId: "conversation-2",
                engineId: "pi",
                providerKind: "pi-session",
                providerSessionId: "pi-subagent",
                createdAt: "2026-04-20T00:00:00.000Z",
                updatedAt: "2026-04-20T00:00:00.000Z",
                source: "reconciled"
              }
            : undefined
        ),
        listEntries: vi.fn().mockReturnValue([
          {
            sessionId: "session-pi",
            workspaceId: "workspace-1",
            conversationId: "conversation-2",
            engineId: "pi",
            providerKind: "pi-session",
            providerSessionId: "pi-subagent",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            source: "reconciled"
          }
        ])
      } as never
    });

    expect(registry.resolveSessionIdentifier("session-pi")).toBe("session-pi");
    expect(registry.resolveSessionIdentifier("codex-thread:thread-subagent")).toBe(
      "codex-thread:thread-subagent"
    );
    expect(registry.resolveSessionIdentifier("thread-subagent")).toBe(
      "codex-thread:thread-subagent"
    );
    expect(registry.resolveSessionIdentifier("pi-subagent")).toBe("session-pi");
    expect(registry.resolveSessionIdentifier("thread-unknown")).toBeUndefined();
  });
});
