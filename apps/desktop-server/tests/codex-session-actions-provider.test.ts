import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimePort } from "../src/engines/codex/runtime-port.js";
import { CodexSessionActionsProvider } from "../src/engines/codex/session-actions-provider.js";

const codexProviderHandle = (providerSessionId = "thread-1") => ({
  providerKind: "codex-thread",
  providerSessionId
});

describe("CodexSessionActionsProvider", () => {
  it("reconnects background execution without interrupting, unsubscribing or reinjecting the same role", async () => {
    const port = { resumeThread: vi.fn().mockResolvedValue({ id: "thread-1", turns: [{ id: "active", status: "inProgress" }] }),
      interruptThread: vi.fn(), unsubscribeThread: vi.fn(), attachThreadToSession: vi.fn(), trackResumedTurn: vi.fn(), injectDeveloperInstructions: vi.fn() };
    const provider = new CodexSessionActionsProvider({ codexRuntimePort: port as unknown as CodexAppServerRuntimePort });
    await provider.runAction({ sessionId: "worker", action: "resume", preserveExecution: true,
      providerHandle: codexProviderHandle(), session: { metadata: { developerInstructions: "WORKER" } } as never,
      sessionIndexStore: {} as never, runtimeService: { resolveSessionRoleInstructions: async () => "WORKER" } as never });
    expect(port.interruptThread).not.toHaveBeenCalled();
    expect(port.unsubscribeThread).not.toHaveBeenCalled();
    expect(port.injectDeveloperInstructions).not.toHaveBeenCalled();
    expect(port.trackResumedTurn).toHaveBeenCalledWith("worker", expect.objectContaining({ id: "thread-1" }));
  });
  it("resolves the current role for resume without injecting or persisting role text", async () => {
    const session = { metadata: { cwd: "I:/workspace", developerInstructions: "PREPARATION_ROLE" } };
    const resumeThread = vi.fn().mockResolvedValue({ id: "thread-worker" });
    const injectDeveloperInstructions = vi.fn();
    const updateSessionMetadata = vi.fn(async (_id, metadata) => { Object.assign(session.metadata, metadata); });
    const resolveSessionRoleInstructions = vi.fn().mockResolvedValue("WORKER_ROLE");
    const provider = new CodexSessionActionsProvider({ codexRuntimePort: {
      resumeThread, injectDeveloperInstructions, interruptThread: vi.fn(), unsubscribeThread: vi.fn(), attachThreadToSession: vi.fn()
    } as unknown as CodexAppServerRuntimePort });
    const input = { sessionId: "worker", action: "resume" as const,
      providerHandle: codexProviderHandle("thread-worker"), session: session as never,
      sessionIndexStore: {} as never, runtimeService: { updateSessionMetadata, resolveSessionRoleInstructions } as never };
    await provider.runAction({ ...input, metadata: { role: "worker" } });
    expect(resolveSessionRoleInstructions).toHaveBeenLastCalledWith("worker", { role: "worker" });
    expect(resumeThread).toHaveBeenLastCalledWith("thread-worker", "I:/workspace", "WORKER_ROLE");
    expect(injectDeveloperInstructions).not.toHaveBeenCalled();
    expect(updateSessionMetadata).toHaveBeenLastCalledWith("worker", { role: "worker" });
    await provider.runAction(input);
    await provider.runAction(input);
    expect(injectDeveloperInstructions).not.toHaveBeenCalled();
    expect(resumeThread).toHaveBeenLastCalledWith("thread-worker", "I:/workspace", "WORKER_ROLE");
  });

  it("resumes a Worker in its allocated worktree and persists the cwd and work binding", async () => {
    const resumeThread = vi.fn().mockResolvedValue({ id: "thread-worker" });
    const updateSessionMetadata = vi.fn();
    const provider = new CodexSessionActionsProvider({ codexRuntimePort: {
      resumeThread, interruptThread: vi.fn(), unsubscribeThread: vi.fn(), attachThreadToSession: vi.fn()
    } as unknown as CodexAppServerRuntimePort });
    await provider.runAction({ sessionId: "worker", action: "resume", cwd: "I:/worktree",
      metadata: { workItemId: "item" }, providerHandle: codexProviderHandle("thread-worker"),
      session: { metadata: { cwd: "I:/workspace", developerInstructions: "WORKER_ROLE" } } as never,
      sessionIndexStore: {} as never,
      runtimeService: { updateSessionMetadata, resolveSessionRoleInstructions: async () => "WORKER_ROLE" } as never });
    expect(resumeThread).toHaveBeenCalledWith("thread-worker", "I:/worktree", "WORKER_ROLE");
    expect(updateSessionMetadata).toHaveBeenCalledWith("worker", { cwd: "I:/worktree", workItemId: "item" });
  });

  it("registers a background fork without overwriting the user's active selection", async () => {
    const setLastActiveSelection = vi.fn();
    const upsertSession = vi.fn();
    const upsertRelation = vi.fn();
    const provider = new CodexSessionActionsProvider({ codexRuntimePort: {
      forkThread: vi.fn().mockResolvedValue({ id: "child", createdAt: 1_776_470_402,
        updatedAt: 1_776_470_403, turns: [], cwd: "I:/project", preview: "" }),
      attachThreadToSession: vi.fn()
    } as unknown as CodexAppServerRuntimePort });
    const result = await provider.runAction({
      sessionId: "root", engineId: "codex", action: "fork", fromTurnId: "turn-a", activateFork: false,
      providerHandle: codexProviderHandle(),
      indexEntry: { sessionId: "root", workspaceId: "workspace", conversationId: "conversation" } as never,
      sessionIndexStore: { upsertSession, upsertRelation } as never,
      runtimeService: { getWorkspaceRegistry: () => ({ setLastActiveSelection }) } as never
    });
    expect(result).toMatchObject({ action: "fork", status: "forked", forkedSessionId: "codex-thread:child" });
    expect(upsertSession).toHaveBeenCalledOnce();
    expect(upsertRelation).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: "root",
      childSessionId: "codex-thread:child", sourceTurnId: "turn-a" }));
    expect(setLastActiveSelection).not.toHaveBeenCalled();
  });

  it("copies the canonical provider session id from the registry handle", () => {
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {} as unknown as CodexAppServerRuntimePort
    });

    expect(
      provider.resolveDisplayedSessionId({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle("thread-handle"),
        indexEntry: {
          sessionId: "session-1",
          providerSessionId: "thread-indexed"
        } as never
      })
    ).toBe("thread-handle");
  });

  it("uses canonical provider handles without reading raw index identity", () => {
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {} as unknown as CodexAppServerRuntimePort
    });

    expect(
      provider.resolveDisplayedSessionId({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle("thread-handle")
      })
    ).toBe("thread-handle");

    expect(
      provider.resolveDisplayedSessionId({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        indexEntry: {
          sessionId: "session-1",
          providerSessionId: "thread-indexed"
        } as never
      })
    ).toBeUndefined();
  });

  it("exposes Codex-only action availability based on thread identity", async () => {
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {} as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.listAdditionalActions({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual([
      {
        action: "fork",
        label: "Fork",
        disabled: true,
        reason: "Fork is not available until the Codex thread is created."
      },
      {
        action: "open_rollout",
        label: "Open rollout",
        disabled: true,
        reason: "Rollout is not available until the thread is created."
      }
    ]);
  });

  it("archives the underlying Codex thread before the generic archive flow continues", async () => {
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        archiveThread
      } as unknown as CodexAppServerRuntimePort
    });

    await provider.prepareArchive({
      sessionId: "session-1",
      engineId: "codex",
      runtimeService: {} as never,
      sessionIndexStore: {} as never,
      providerHandle: codexProviderHandle()
    });

    expect(archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("treats a missing rollout as an already archived Codex thread", async () => {
    const archiveThread = vi
      .fn()
      .mockRejectedValue(new Error("no rollout found for thread id thread-1"));
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        archiveThread
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.prepareArchive({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle()
      })
    ).resolves.toBeUndefined();
  });

  it("keeps unrelated Codex archive failures visible", async () => {
    const archiveThread = vi.fn().mockRejectedValue(new Error("archive transport failed"));
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        archiveThread
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.prepareArchive({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle()
      })
    ).rejects.toThrow("archive transport failed");
  });

  it("refreshes Codex user config, MCP servers, and skill discovery", async () => {
    const reloadUserConfig = vi.fn().mockResolvedValue(undefined);
    const reloadMcpServers = vi.fn().mockResolvedValue(undefined);
    const listSkills = vi.fn().mockResolvedValue([]);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        reloadUserConfig,
        reloadMcpServers,
        listSkills
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "refresh",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual({
      action: "refresh",
      refreshed: true,
      details: "Reloaded user config, refreshed skills, and queued MCP server reloads for loaded Codex threads."
    });

    expect(reloadUserConfig).toHaveBeenCalledTimes(1);
    expect(reloadMcpServers).toHaveBeenCalledTimes(1);
    expect(listSkills).toHaveBeenCalledWith({
      forceReload: true
    });
  });

  it("interrupts, unsubscribes, and resumes the underlying Codex thread before reattaching it", async () => {
    const interruptThread = vi.fn().mockResolvedValue(undefined);
    const unsubscribeThread = vi.fn().mockResolvedValue(undefined);
    const resumeThread = vi.fn().mockResolvedValue({
      id: "thread-2"
    });
    const attachThreadToSession = vi.fn();
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        interruptThread,
        unsubscribeThread,
        resumeThread,
        attachThreadToSession
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "resume",
        runtimeService: { resolveSessionRoleInstructions: async () => undefined } as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle()
      })
    ).resolves.toEqual({
      action: "resume",
      resumed: true
    });

    expect(interruptThread).toHaveBeenCalledWith("thread-1", {
      bestEffort: true
    });
    expect(unsubscribeThread).toHaveBeenCalledWith("thread-1");
    expect(resumeThread).toHaveBeenCalledWith("thread-1", undefined, undefined);
    expect(attachThreadToSession).toHaveBeenCalledWith("session-1", "thread-2");
  });

  it("forks the underlying Codex thread and registers the child session", async () => {
    const forkThread = vi.fn().mockResolvedValue({
      id: "thread-child",
      preview: "Forked preview",
      name: null,
      createdAt: 1_776_470_402,
      updatedAt: 1_776_470_403,
      path: "I:\\project\\rollout-child.jsonl",
      cwd: "I:\\project",
      turns: [{ id: "turn-child" }]
    });
    const attachThreadToSession = vi.fn();
    const upsertSession = vi.fn().mockResolvedValue(undefined);
    const upsertRelation = vi.fn().mockResolvedValue(undefined);
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        forkThread,
        attachThreadToSession
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "fork",
        runtimeService: {
          getSnapshot: vi.fn().mockReturnValue({
            conversations: [
              {
                conversationId: "conversation-1",
                workspaceId: "workspace-1"
              }
            ]
          }),
          getWorkspaceRegistry: vi.fn().mockReturnValue({
            setLastActiveSelection
          })
        } as never,
        sessionIndexStore: {
          upsertSession,
          upsertRelation,
          listRelations: vi.fn().mockReturnValue([])
        } as never,
        providerHandle: codexProviderHandle(),
        session: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:01Z",
          metadata: {
            cwd: "I:\\project",
            providerKind: "codex-thread",
            providerSessionId: "thread-1"
          }
        }
      })
    ).resolves.toEqual({
      action: "fork",
      status: "forked",
      forkedSessionId: "codex-thread:thread-child",
      providerSessionId: "thread-child"
    });

    expect(forkThread).toHaveBeenCalledWith("thread-1", undefined);
    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-child",
      "thread-child"
    );
    expect(upsertSession).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      session: {
        sessionId: "codex-thread:thread-child",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Forked preview",
        createdAt: "2026-04-18T00:00:02.000Z",
        updatedAt: "2026-04-18T00:00:03.000Z",
        lastTurnId: "turn-child",
        metadata: {
          cwd: "I:\\project",
          providerKind: "codex-thread",
          providerSessionId: "thread-child",
          rolloutPath: "I:\\project\\rollout-child.jsonl"
        }
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-child",
      summaryText: "Forked preview",
      source: "discovery"
    });
    expect(upsertRelation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      parentSessionId: "session-1",
      childSessionId: "codex-thread:thread-child",
      relationType: "fork",
      sourceTurnId: "turn-child",
      createdAt: "2026-04-18T00:00:02.000Z"
    });
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-child"
    });
  });

  it.each([false, true])("inherits semantic context and applies only explicit fork ownership (scheduler=%s)", async (scheduler) => {
    const forkThread = vi.fn().mockResolvedValue({
      id: "thread-child", createdAt: 1_776_470_402, updatedAt: 1_776_470_403,
      path: "child.jsonl", turns: []
    });
    const upsertSession = vi.fn().mockResolvedValue(undefined);
    const upsertRelation = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexSessionActionsProvider({ codexRuntimePort: {
      forkThread, attachThreadToSession: vi.fn()
    } as unknown as CodexAppServerRuntimePort });
    const context = { role: "work-preparation", sessionProfile: { engineId: "codex", modelId: "model" },
      cwd: "I:/project", developerInstructions: "Discuss the project" };
    const ownership = { requestId: "old-request", workItemId: "old-item", actionId: "old-action",
      sourceSessionId: "old-source", sourceTurnId: "old-turn", treeId: "old-tree" };
    const explicit = { requestId: "new-request", workItemId: "new-item", actionId: "new-action",
      sourceSessionId: "parent", sourceTurnId: "source-turn", role: "worker" };
    await provider.runAction({
      sessionId: "parent", engineId: "codex", action: "fork", fromTurnId: "source-turn", activateFork: false,
      metadata: scheduler ? explicit : undefined,
      runtimeService: {} as never,
      sessionIndexStore: { upsertSession, upsertRelation, listRelations: () => [] } as never,
      providerHandle: codexProviderHandle("thread-parent"),
      indexEntry: { sessionId: "parent", workspaceId: "workspace", conversationId: "conversation",
        metadata: { ...context, ...ownership, rolloutPath: "parent.jsonl", arbitraryOwnership: "not inherited" }
      } as never
    });
    expect(upsertSession.mock.calls[0]![0].session.metadata).toEqual({
      role: context.role, sessionProfile: context.sessionProfile, cwd: context.cwd,
      developerInstructions: context.developerInstructions,
      providerKind: "codex-thread", providerSessionId: "thread-child", rolloutPath: "child.jsonl",
      ...(scheduler ? explicit : {})
    });
    expect(forkThread).toHaveBeenCalledWith("thread-parent", "source-turn");
    expect(upsertRelation).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "parent", childSessionId: "codex-thread:thread-child", sourceTurnId: "source-turn"
    }));
  });

  it("forks index-only Codex sessions without requiring a loaded runtime parent", async () => {
    const forkThread = vi.fn().mockResolvedValue({
      id: "thread-child",
      preview: "",
      name: "Forked Thread",
      createdAt: 1_776_470_402,
      updatedAt: 1_776_470_403,
      path: null,
      cwd: "I:\\project",
      turns: []
    });
    const upsertSession = vi.fn().mockResolvedValue(undefined);
    const upsertRelation = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        forkThread,
        attachThreadToSession: vi.fn()
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "codex-thread:thread-parent",
        engineId: "codex",
        action: "fork",
        runtimeService: {
          getWorkspaceRegistry: vi.fn().mockReturnValue(undefined)
        } as never,
        sessionIndexStore: {
          upsertSession,
          upsertRelation,
          listRelations: vi.fn().mockReturnValue([])
        } as never,
        providerHandle: codexProviderHandle("thread-parent"),
        indexEntry: {
          sessionId: "codex-thread:thread-parent",
          workspaceId: "workspace-1",
          engineId: "codex",
          providerKind: "codex-thread",
          providerSessionId: "thread-parent"
        } as never
      })
    ).resolves.toEqual({
      action: "fork",
      status: "forked",
      forkedSessionId: "codex-thread:thread-child",
      providerSessionId: "thread-child"
    });

    expect(forkThread).toHaveBeenCalledWith("thread-parent", undefined);
    expect(upsertRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "codex-thread:thread-parent",
        childSessionId: "codex-thread:thread-child",
        relationType: "fork"
      })
    );
  });

  it("keeps forked children in the parent session's conversation", async () => {
    const forkThread = vi.fn().mockResolvedValue({
      id: "thread-child",
      preview: "Nested fork",
      name: null,
      createdAt: 1_776_470_402,
      updatedAt: 1_776_470_403,
      path: null,
      cwd: "I:\\project",
      turns: []
    });
    const upsertSession = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        forkThread,
        attachThreadToSession: vi.fn()
      } as unknown as CodexAppServerRuntimePort
    });

    await provider.runAction({
      sessionId: "session-parent",
      engineId: "codex",
      action: "fork",
      runtimeService: {
        getSnapshot: vi.fn().mockReturnValue({
          conversations: [
            {
              conversationId: "conversation-parent",
              workspaceId: "workspace-1"
            }
          ]
        }),
        getWorkspaceRegistry: vi.fn().mockReturnValue(undefined)
      } as never,
      sessionIndexStore: {
        upsertSession,
        upsertRelation: vi.fn().mockResolvedValue(undefined),
        listRelations: vi.fn().mockReturnValue([
          {
            workspaceId: "workspace-1",
            parentSessionId: "session-root",
            childSessionId: "session-parent",
            relationType: "fork",
            createdAt: "2026-04-18T00:00:01.000Z"
          }
        ])
      } as never,
      providerHandle: codexProviderHandle("thread-parent"),
      session: {
        sessionId: "session-parent",
        conversationId: "conversation-parent",
        engineId: "codex",
        status: "idle",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      }
    });

    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          conversationId: "conversation-parent"
        })
      })
    );
  });

  it("does not fork externally when workspace context is missing", async () => {
    const forkThread = vi.fn();
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        forkThread
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "fork",
        runtimeService: {
          getSnapshot: vi.fn().mockReturnValue({
            conversations: []
          })
        } as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle(),
        session: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:01Z"
        }
      })
    ).rejects.toThrow("Fork is unavailable without a workspace context.");
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("opens rollout paths through the Codex thread reader", async () => {
    const readThread = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        path: "\\\\?\\I:\\rollouts\\thread-1.md"
      });
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        readThread
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "open_rollout",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle()
      })
    ).rejects.toThrow("Codex thread does not expose a rollout path.");

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "open_rollout",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: codexProviderHandle()
      })
    ).resolves.toEqual({
      action: "open_rollout",
      rolloutPath: "\\\\?\\I:\\rollouts\\thread-1.md",
      rolloutDisplayPath: "I:\\rollouts\\thread-1.md",
      rolloutFileUrl: "file:///I:/rollouts/thread-1.md"
    });
  });
});
