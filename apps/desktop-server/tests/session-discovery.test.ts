import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../src/codex-app-server-generated/v2/Thread.js";
import { createCodexAppServerRuntimePort } from "../src/engines/codex/runtime-port.js";
import {
  SessionReconciliationService
} from "../src/session-discovery.js";
import { CodexSessionDiscoveryProvider } from "../src/engines/codex/session-discovery.js";
import {
  clearCodexTurnChangesStore,
  getRecordedCodexTurnChanges
} from "../src/engines/codex/extensions/turn-changes-store.js";
import { SessionIndexStore } from "../src/session-index.js";
import { SessionRuntimeService } from "../src/runtime-service.js";
import { WrapperChatTreeService } from "../src/wrapper-chat-tree.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";
import {
  consumeCodexRolloutTimestampForItem,
  readCodexRolloutTimestampGroups
} from "../src/engines/codex/extensions/rollout-timestamps.js";

vi.mock("../src/engines/codex/extensions/rollout-timestamps.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/engines/codex/extensions/rollout-timestamps.js")
  >();
  return {
    ...actual,
    readCodexRolloutTimestampGroups: vi.fn(actual.readCodexRolloutTimestampGroups)
  };
});

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-discovery-"));
  tempDirs.push(dir);
  return dir;
};

const createThread = (input: {
  id: string;
  forkedFromId?: string | null;
  source?: Thread["source"];
  name?: string | null;
  preview?: string;
  cwd?: string;
}): Thread => ({
  id: input.id,
  sessionId: `session-tree-${input.id}`,
  forkedFromId: input.forkedFromId ?? null,
  preview: input.preview ?? `Preview ${input.id}`,
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1_776_420_000,
  updatedAt: 1_776_420_120,
  status: {
    type: "idle"
  },
  path: `I:/rollouts/${input.id}.md`,
  cwd: input.cwd ?? "I:/workspace-alpha",
  cliVersion: "1.0.0",
  source: input.source ?? "appServer",
  threadSource: "user",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: input.name ?? null,
  turns: []
});

const buildHydratedWindow = (sessionId = "session-1") => ({
  workspaceId: "workspace-1",
  conversation: {
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    participantEngineIds: ["codex"],
    activeSessionId: sessionId,
    sessionIds: [sessionId],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  },
  session: {
    sessionId,
    conversationId: "conversation-1",
    engineId: "codex",
    status: "idle",
    title: "Session",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  },
  turns: [
    {
      turnId: "turn-1",
      sessionId,
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-04-19T00:00:00.000Z",
      completedAt: "2026-04-19T00:00:01.000Z",
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: []
    }
  ],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  sessionRelations: [],
  hasOlder: true,
  hasNewer: false,
  olderCursor: "older-cursor",
  runtimeBinding: {
    providerKind: "codex-thread",
    providerSessionId: "thread-1"
  }
});

afterEach(async () => {
  clearCodexTurnChangesStore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("cold history hydration", () => {
  const setupHistory = async (
    mode: "full" | "page",
    loaded = false,
    options: {
      metadata?: Record<string, unknown>;
      resumeProfile?: Record<string, unknown>;
      preview?: string;
      name?: string;
    } = {}
  ) => {
    const root = await createTempDir();
    const thread = createThread({ id: "thread-history", cwd: join(root, "removed-worktree"),
      preview: options.preview, name: options.name });
    thread.turns = [{
      id: "turn-history", status: "completed", error: null, itemsView: "full",
      startedAt: null, completedAt: null, durationMs: null,
      items: [{ type: "agentMessage", id: "answer", text: "Saved worker answer", phase: "final_answer", memoryCitation: null }]
    }];
    const entry = {
      workspaceId: "workspace-history", sessionId: "worker-history", conversationId: "conversation-history",
      engineId: "codex", providerKind: "codex-thread", providerSessionId: thread.id,
      createdAt: "2026-04-19T00:00:00.000Z", updatedAt: "2026-04-19T00:00:01.000Z",
      ...(options.metadata ? { metadata: options.metadata } : {})
    };
    const port = createCodexAppServerRuntimePort({ commandPath: process.execPath, commandArgs: [] });
    vi.spyOn(port, "start").mockResolvedValue();
    let finishResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { finishResume = resolve; });
    const internals = port as unknown as {
      rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const rpc = vi.spyOn(internals, "rpc").mockImplementation(async (method, params) => {
      switch (method) {
        case "thread/read":
          return { thread: params.includeTurns ? thread : { ...thread, status: { type: loaded ? "idle" : "notLoaded" }, turns: [] } };
        case "thread/resume":
          await resumeGate;
          return { thread: { ...thread, cwd: root }, ...(options.resumeProfile ?? {}) };
        case "thread/turns/list":
          return { data: thread.turns, nextCursor: "older", backwardsCursor: null };
        case "thread/goal/get": return { goal: null };
        case "thread/unsubscribe": return { status: "unsubscribed" };
        default: throw new Error(`Unexpected history RPC: ${method}`);
      }
    });
    const resolveHistoryCwd = vi.fn().mockReturnValue(root);
    const provider = new CodexSessionDiscoveryProvider({ codexRuntimePort: port, resolveHistoryCwd });
    const hydrate = (signal?: AbortSignal) => mode === "full"
      ? provider.hydrateSession(entry, { signal })
      : provider.hydrateSessionWindow(entry, { limit: 1, cursor: "page-cursor", signal });
    return { root, port, rpc, hydrate, finishResume, resolveHistoryCwd };
  };

  it.each(["full", "page"] as const)("keeps unnamed %s history untitled and preserves engine names", async (mode) => {
    for (const options of [{ preview: "" }, { preview: "First message preview" }, { name: "Engine title" }]) {
      const { hydrate, finishResume } = await setupHistory(mode, false, options);
      finishResume();
      expect((await hydrate())?.session.title).toBe(options.name);
    }
  });

  it.each(["full", "page"] as const)("loads cold %s history at the workspace root before reading and unsubscribes without starting a turn", async (mode) => {
    const { root, port, rpc, hydrate, finishResume, resolveHistoryCwd } = await setupHistory(mode);
    const pending = hydrate();
    await vi.waitFor(() => expect(rpc.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/resume"]));
    expect(rpc.mock.calls[0]?.[1]).toEqual({ threadId: "thread-history", includeTurns: false });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ threadId: "thread-history", cwd: root });
    expect(resolveHistoryCwd).toHaveBeenCalledExactlyOnceWith("workspace-history");
    finishResume();

    const result = await pending;
    expect(result?.messageBlocks).toContainEqual(expect.objectContaining({ role: "assistant", text: "Saved worker answer" }));
    expect(result?.turns[0]?.turnId).toBe("turn-history");
    expect(result?.session.title).toBeUndefined();
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      "thread/read", "thread/resume", ...(mode === "page" ? ["thread/turns/list"] : []), "thread/goal/get", "thread/unsubscribe"
    ]);
    if (mode === "page") {
      expect(rpc).toHaveBeenCalledWith("thread/turns/list", {
        threadId: "thread-history", cursor: "page-cursor", limit: 1, sortDirection: "desc", itemsView: "full"
      }, { timeoutMs: 120_000 });
    }
    expect(port.isThreadExecutionReleased("thread-history")).toBe(true);
  });

  it.each(["full", "page"] as const)("hydrates a missing session profile from the resumed thread configuration (%s)", async (mode) => {
    const { rpc, hydrate, finishResume } = await setupHistory(mode, false, {
      resumeProfile: {
        model: "deepseek-flash",
        reasoningEffort: "high",
        serviceTier: "standard"
      }
    });
    const pending = hydrate();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("thread/resume", expect.anything(), expect.anything()));
    finishResume();

    const result = await pending;
    expect(result?.session.metadata?.sessionProfile).toEqual({
      engineId: "codex",
      modelId: "deepseek-flash",
      reasoningOptionId: "high",
      serviceTierId: "standard"
    });
  });

  it.each(["full", "page"] as const)("preserves an existing session profile when the thread reports another configuration (%s)", async (mode) => {
    const { rpc, hydrate, finishResume } = await setupHistory(mode, false, {
      metadata: {
        sessionProfile: {
          engineId: "codex",
          modelId: "fable-5",
          reasoningOptionId: "high",
          serviceTierId: "priority"
        }
      },
      resumeProfile: {
        model: "deepseek-flash",
        reasoningEffort: "high",
        serviceTier: "standard"
      }
    });
    const pending = hydrate();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("thread/resume", expect.anything(), expect.anything()));
    finishResume();

    const result = await pending;
    expect(result?.session.metadata?.sessionProfile).toEqual({
      engineId: "codex",
      modelId: "fable-5",
      reasoningOptionId: "high",
      serviceTierId: "priority"
    });
  });

  it.each(["full", "page"] as const)("leaves already loaded %s history subscribed", async (mode) => {
    const { rpc, hydrate, resolveHistoryCwd } = await setupHistory(mode, true);
    expect((await hydrate())?.messageBlocks).toContainEqual(expect.objectContaining({ text: "Saved worker answer" }));
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      "thread/read", mode === "full" ? "thread/read" : "thread/turns/list", "thread/goal/get"
    ]);
    expect(resolveHistoryCwd).not.toHaveBeenCalled();
  });

  it.each(["full", "page"] as const)("unsubscribes cold %s history when cancelled during loading", async (mode) => {
    const { port, rpc, hydrate, finishResume } = await setupHistory(mode);
    const controller = new AbortController();
    const pending = hydrate(controller.signal);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "thread/resume",
      expect.anything(),
      expect.objectContaining({ timeoutMs: 120_000 })
    ));
    controller.abort();
    finishResume();
    await expect(pending).resolves.toBeUndefined();
    expect(rpc).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId: "thread-history" });
    expect(port.getThreadIdForSession("worker-history")).toBeUndefined();
  });

  it.each(["full", "page"] as const)("unsubscribes cold %s history when transcript hydration fails", async (mode) => {
    const { rpc, hydrate, finishResume } = await setupHistory(mode);
    vi.mocked(readCodexRolloutTimestampGroups).mockRejectedValueOnce(new Error("Unreadable rollout"));
    finishResume();
    await expect(hydrate()).rejects.toThrow("Unreadable rollout");
    expect(rpc).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId: "thread-history" });
  });
});

describe("Session discovery and reconciliation", () => {
  it("keeps an already-bound main session executable without resuming its running thread", async () => {
    const resumeThread = vi.fn();
    const attachThreadToSession = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        getThreadIdForSession: vi.fn().mockReturnValue("thread-main"),
        resumeThread,
        attachThreadToSession
      } as never
    });

    await expect(provider.ensureSessionExecutable({
      sessionId: "codex-thread:thread-main",
      providerSessionId: "thread-main"
    } as never)).resolves.toBe(true);

    expect(resumeThread).not.toHaveBeenCalled();
    expect(attachThreadToSession).not.toHaveBeenCalled();
  });

  it.each(["unbound", "released"])("resumes a %s session at its workspace root", async (state) => {
    const resumeThread = vi.fn().mockResolvedValue(createThread({ id: "thread-main", cwd: "I:/workspace-alpha/removed-worktree" }));
    const attachThreadToSession = vi.fn();
    const resolveHistoryCwd = vi.fn().mockReturnValue("I:/workspace-alpha");
    const provider = new CodexSessionDiscoveryProvider({
      resolveHistoryCwd,
      codexRuntimePort: {
        isThreadExecutionReleased: () => state === "released",
        getThreadIdForSession: vi.fn().mockReturnValue(state === "released" ? "thread-main" : undefined),
        resumeThread,
        attachThreadToSession
      } as never
    });

    await expect(provider.ensureSessionExecutable({
      sessionId: "codex-thread:thread-main",
      workspaceId: "workspace-1",
      providerSessionId: "thread-main"
    } as never)).resolves.toBe(true);

    expect(resolveHistoryCwd).toHaveBeenCalledExactlyOnceWith("workspace-1");
    expect(resumeThread).toHaveBeenCalledExactlyOnceWith("thread-main", "I:/workspace-alpha", undefined, { signal: undefined });
    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-main",
      "thread-main"
    );
  });

  it("matches codex thread cwd values that include the windows device prefix", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [
            createThread({
              id: "thread-root",
              cwd: "\\\\?\\I:\\workspace-alpha"
            }),
            createThread({
              id: "thread-child",
              cwd: "\\\\?\\I:\\workspace-alpha\\apps\\desktop"
            }),
            createThread({
              id: "thread-other",
              cwd: "\\\\?\\I:\\other-workspace"
            })
          ],
          nextCursor: null
        })
      } as never
    });

    const discovered = await provider.discoverWorkspaces([{
        workspaceId: "workspace-1",
        absolutePath: "I:/workspace-alpha",
        label: "Alpha"
      }]);
    expect(discovered.get("workspace-1")).toEqual({
      sessions: [
        expect.objectContaining({ sessionId: "codex-thread:thread-root" }),
        expect.objectContaining({ sessionId: "codex-thread:thread-child" })
      ],
      relations: []
    });
  });

  it("discovers codex fork relations from thread fork parents", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [
            createThread({
              id: "thread-root"
            }),
            createThread({
              id: "thread-fork",
              forkedFromId: "thread-root"
            })
          ],
          nextCursor: null
        })
      } as never
    });

    const discovered = await provider.discoverWorkspaces([{
        workspaceId: "workspace-1",
        absolutePath: "I:/workspace-alpha",
        label: "Alpha"
      }]);
    expect(discovered.get("workspace-1")).toEqual({
      sessions: [
        expect.objectContaining({ sessionId: "codex-thread:thread-root" }),
        expect.objectContaining({ sessionId: "codex-thread:thread-fork" })
      ],
      relations: [
        expect.objectContaining({
          parentSessionId: "codex-thread:thread-root",
          childSessionId: "codex-thread:thread-fork",
          relationType: "fork"
        })
      ]
    });
  });

  it("prefers the subagent relation when codex also reports the same fork parent", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [
            createThread({
              id: "thread-root"
            }),
            createThread({
              id: "thread-child",
              forkedFromId: "thread-root",
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: "thread-root",
                    depth: 1,
                    agent_nickname: "child",
                    agent_role: "worker"
                  }
                }
              }
            })
          ],
          nextCursor: null
        })
      } as never
    });

    const discovered = await provider.discoverWorkspaces([{
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    }]);

    expect(discovered.get("workspace-1")?.relations).toEqual([
      expect.objectContaining({
        parentSessionId: "codex-thread:thread-root",
        childSessionId: "codex-thread:thread-child",
        relationType: "subagent"
      })
    ]);
  });

  it("discovers listed thread metadata without hydrating transcript content", async () => {
    const listedThread = createThread({
      id: "thread-recent",
      cwd: "I:/workspace-alpha",
      name: "Metadata only"
    });
    const readThread = vi.fn();
    const readRollout = vi.mocked(readCodexRolloutTimestampGroups);
    readRollout.mockClear();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [listedThread],
          nextCursor: null
        }),
        readThread
      } as never
    });

    const discoveredByWorkspaceId = await provider.discoverWorkspaces([{
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    }]);

    expect(readThread).not.toHaveBeenCalled();
    expect(readRollout).not.toHaveBeenCalled();
    expect(discoveredByWorkspaceId.get("workspace-1")?.sessions[0]).toMatchObject({
      sessionId: "codex-thread:thread-recent",
      providerSessionId: "thread-recent",
      title: "Metadata only"
    });
  });

  it("uses rollout modification time when state DB activity is stale", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-stale-state-db.jsonl");
    await writeFile(rolloutPath, "{}\n", "utf8");
    await utimes(
      rolloutPath,
      new Date("2026-07-03T18:44:14.486Z"),
      new Date("2026-07-03T18:44:14.486Z")
    );
    const listedThread = {
      ...createThread({
        id: "thread-stale-state-db",
        cwd: "I:/workspace-alpha"
      }),
      updatedAt: 1_778_198_400,
      path: rolloutPath
    };
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [listedThread],
          nextCursor: null
        })
      } as never
    });

    const discoveredByWorkspaceId = await provider.discoverWorkspaces([{
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    }]);

    expect(discoveredByWorkspaceId.get("workspace-1")?.sessions[0]?.updatedAt).toBe(
      "2026-07-03T18:44:14.486Z"
    );
  });

  it("shares one paged metadata scan across overlapping workspaces", async () => {
    const sharedThread = createThread({
      id: "thread-shared",
      cwd: "I:/workspace/root/nested"
    });
    const rootThread = createThread({ id: "thread-root", cwd: "I:/workspace/root" });
    const otherThread = createThread({ id: "thread-other", cwd: "I:/workspace/other" });
    const listThreads = vi
      .fn()
      .mockResolvedValueOnce({ data: [sharedThread, rootThread], nextCursor: "page-2" })
      .mockResolvedValueOnce({ data: [sharedThread, otherThread], nextCursor: null });
    const readThread = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false, listThreads, readThread } as never
    });

    const discovered = await provider.discoverWorkspaces([
      { workspaceId: "root", absolutePath: "I:/workspace/root", label: "Root" },
      { workspaceId: "nested", absolutePath: "I:/workspace/root/nested", label: "Nested" }
    ]);

    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(listThreads.mock.calls[0]?.[0]).toMatchObject({
      cursor: undefined,
      useStateDbOnly: true
    });
    expect(listThreads.mock.calls[1]?.[0]).toMatchObject({
      cursor: "page-2",
      useStateDbOnly: true
    });
    expect(readThread).not.toHaveBeenCalled();
    expect(discovered.get("root")?.sessions.map((session) => session.providerSessionId)).toEqual([
      "thread-shared",
      "thread-root"
    ]);
    expect(discovered.get("nested")?.sessions.map((session) => session.providerSessionId)).toEqual([
      "thread-shared"
    ]);
  });

  it("keeps large discovery scans metadata-only", async () => {
    const threads = Array.from({ length: 10_000 }, (_, index) =>
      createThread({ id: "thread-" + index, cwd: "I:/workspace-alpha" })
    );
    const readThread = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({ data: threads, nextCursor: null }),
        readThread
      } as never
    });

    const discovered = await provider.discoverWorkspaces([
      { workspaceId: "workspace-1", absolutePath: "I:/workspace-alpha", label: "Alpha" }
    ]);

    expect(readThread).not.toHaveBeenCalled();
    expect(discovered.get("workspace-1")?.sessions).toHaveLength(10_000);
  });

  it("hydrates loaded session windows from paged codex turns without resuming", async () => {
    const readThread = vi.fn().mockResolvedValue(createThread({ id: "thread-page" }));
    const listThreadTurns = vi.fn().mockResolvedValue({
      data: [
        {
          id: "turn-page",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "msg-user-page",
              content: [
                {
                  type: "text",
                  text: "Open just this page.",
                  text_elements: []
                }
              ]
            }
          ]
        }
      ],
      nextCursor: "older-cursor",
      backwardsCursor: "newer-cursor"
    });
    const resumeThread = vi.fn();
    const attachThreadToSession = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread,
        listThreadTurns,
        resumeThread,
        attachThreadToSession
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: "codex-thread:thread-page",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-page",
        title: "Thread page",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:01:00.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      {
        limit: 1,
        cursor: "cursor-1"
      }
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        hasOlder: true,
        hasNewer: true,
        olderCursor: "older-cursor",
        newerCursor: "newer-cursor",
        turns: [
          expect.objectContaining({
            turnId: "turn-page",
            sessionId: "codex-thread:thread-page"
          })
        ]
      })
    );
    expect(readThread).toHaveBeenCalledWith("thread-page", false, { signal: undefined });
    expect(listThreadTurns).toHaveBeenCalledWith({
      threadId: "thread-page",
      cursor: "cursor-1",
      limit: 1,
      sortDirection: "desc",
      itemsView: "full"
    }, { signal: undefined });
    expect(resumeThread).not.toHaveBeenCalled();
    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-page",
      "thread-page",
      false
    );
  });

  it("repairs completed user-only pages from the authoritative thread history", async () => {
    const readThread = vi.fn().mockImplementation(
      (_threadId: string, includeTurns: boolean) => ({
        ...createThread({ id: "thread-page" }),
        turns: includeTurns
          ? [
              {
                id: "turn-page",
                status: "completed",
                error: null,
                itemsView: "full",
                items: [
                  {
                    type: "userMessage",
                    id: "msg-user-page",
                    content: [
                      {
                        type: "text",
                        text: "Keep the answer visible.",
                        text_elements: []
                      }
                    ]
                  },
                  {
                    type: "agentMessage",
                    id: "msg-agent-page",
                    text: "Completed answer",
                    phase: null,
                    memoryCitation: null
                  }
                ]
              }
            ]
          : []
      })
    );
    const listThreadTurns = vi.fn().mockResolvedValue({
      data: [
        {
          id: "turn-page",
          status: "completed",
          error: null,
          itemsView: "full",
          items: [
            {
              type: "userMessage",
              id: "msg-user-page",
              content: [
                {
                  type: "text",
                  text: "Keep the answer visible.",
                  text_elements: []
                }
              ]
            }
          ]
        }
      ],
      nextCursor: null,
      backwardsCursor: null
    });
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread,
        listThreadTurns,
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: "codex-thread:thread-page",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-page",
        title: "Thread page",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:01:00.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      {
        limit: 1,
        anchorTurnId: "turn-page"
      }
    );

    expect(readThread).toHaveBeenNthCalledWith(1, "thread-page", false, { signal: undefined });
    expect(readThread).toHaveBeenNthCalledWith(2, "thread-page", true, { signal: undefined });
    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "Completed answer"
        })
      ])
    );
  });

  it("anchors lightweight Codex window hydration to the selected chat tree turn", async () => {
    const readThread = vi.fn().mockResolvedValue(createThread({ id: "thread-page" }));
    const listThreadTurns = vi.fn().mockResolvedValue({
      data: [
        {
          id: "turn-selected",
          status: "completed",
          error: null,
          items: [],
          startedAt: 1_776_420_060,
          completedAt: 1_776_420_061,
          itemsView: "full"
        }
      ],
      nextCursor: null,
      backwardsCursor: null
    });
    const attachThreadToSession = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread,
        listThreadTurns,
        attachThreadToSession
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: "codex-thread:thread-page",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-page",
        title: "Thread page",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:01:00.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      {
        limit: 8,
        anchorTurnId: "turn-selected"
      }
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        hasNewer: false,
        turns: [
          expect.objectContaining({
            turnId: "turn-selected"
          })
        ]
      })
    );
    expect(listThreadTurns).toHaveBeenCalledWith({
      threadId: "thread-page",
      cursor: JSON.stringify({
        turnId: "turn-selected",
        includeAnchor: true
      }),
      limit: 8,
      sortDirection: "desc",
      itemsView: "full"
    }, { signal: undefined });
  });

  it("uses turn-level rollout timestamps for paged turns that start with compaction", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-paged-compaction.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-10T19:10:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-older"
          }
        },
        {
          timestamp: "2026-05-10T19:10:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "older" }]
          }
        },
        {
          timestamp: "2026-05-10T19:11:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Older done." }]
          }
        },
        {
          timestamp: "2026-05-10T19:11:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-older"
          }
        },
        {
          timestamp: "2026-05-10T19:22:38.814Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-latest"
          }
        },
        {
          timestamp: "2026-05-10T19:22:38.815Z",
          type: "compacted",
          payload: {
            type: "compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:22:38.816Z",
          type: "event_msg",
          payload: {
            type: "context_compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:24:00.000Z",
          type: "compacted",
          payload: {
            type: "compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:24:00.001Z",
          type: "event_msg",
          payload: {
            type: "context_compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:23:28.232Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "修2/4/5/6" }]
          }
        },
        {
          timestamp: "2026-05-10T19:27:08.508Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "已按 review 修完。" }]
          }
        },
        {
          timestamp: "2026-05-10T19:27:08.629Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-latest"
          }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8"
    );
    const readThread = vi.fn().mockResolvedValue({
      ...createThread({ id: "thread-paged-compaction" }),
      createdAt: 1_776_420_000,
      path: rolloutPath
    });
    const listThreadTurns = vi.fn().mockResolvedValue({
      data: [
        {
          id: "turn-latest",
          status: "completed",
          error: null,
          items: [
            {
              type: "contextCompaction",
              id: "compact-latest-1"
            },
            {
              type: "contextCompaction",
              id: "compact-latest-2"
            },
            {
              type: "userMessage",
              id: "user-latest",
              content: [
                {
                  type: "text",
                  text: "修2/4/5/6",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "agent-latest",
              text: "已按 review 修完。",
              phase: "final_answer",
              memoryCitation: null
            }
          ]
        },
        {
          id: "turn-older",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "user-older",
              content: [
                {
                  type: "text",
                  text: "older",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "agent-older",
              text: "Older done.",
              phase: "final_answer",
              memoryCitation: null
            }
          ]
        }
      ],
      nextCursor: null,
      backwardsCursor: null
    });
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread,
        listThreadTurns,
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: "codex-thread:thread-paged-compaction",
        workspaceId: "workspace-1",
        conversationId: "conversation-paged-compaction",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-paged-compaction",
        createdAt: "2026-05-10T07:07:20.000Z",
        updatedAt: "2026-05-10T19:27:08.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      {
        limit: 8
      }
    );

    expect(hydrated?.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-latest",
        startedAt: "2026-05-10T19:22:38.815Z",
        completedAt: "2026-05-10T19:27:08.629Z",
        finalMessageId:
          "codex-thread:thread-paged-compaction:agent-latest"
      }),
      expect.objectContaining({
        turnId: "turn-older",
        startedAt: "2026-05-10T19:10:02.000Z",
        completedAt: "2026-05-10T19:11:01.000Z"
      })
    ]);
    expect(hydrated?.turns[0]).toMatchObject({
      turnId: "turn-latest",
      startedAt: "2026-05-10T19:22:38.815Z",
      completedAt: "2026-05-10T19:27:08.629Z",
      finalMessageId:
        "codex-thread:thread-paged-compaction:agent-latest"
    });
    expect(hydrated?.toolCalls[0]).toMatchObject({
      toolCallId:
        "codex-thread:thread-paged-compaction:compact-latest-1",
      startedAt: "2026-05-10T19:22:38.815Z"
    });
    expect(hydrated?.toolCalls[1]).toMatchObject({
      toolCallId:
        "codex-thread:thread-paged-compaction:compact-latest-2",
      startedAt: "2026-05-10T19:24:00.000Z"
    });
  });

  it("shares window hydration without letting a cancelled caller cancel an active caller", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    const runtimeService = new SessionRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Session",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-1"
    });

    let sharedSignal: AbortSignal | undefined;
    let resolveHydration:
      | ((value: ReturnType<typeof buildHydratedWindow>) => void)
      | undefined;
    const hydrateSessionWindow = vi.fn((_entry, input) => {
      sharedSignal = input.signal;
      return new Promise<ReturnType<typeof buildHydratedWindow>>((resolve) => {
        resolveHydration = resolve;
      });
    });
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [
        {
          engineId: "codex",
          discoverWorkspaces: vi.fn(),
          hydrateSession: vi.fn(),
          hydrateSessionWindow
        }
      ] as never
    });

    const activeController = new AbortController();
    const activeOpen = reconciliation.hydrateSessionWindow("session-1", {
      limit: 2,
      signal: activeController.signal
    });
    await vi.waitFor(() => {
      expect(hydrateSessionWindow).toHaveBeenCalledTimes(1);
    });
    // A caller that cancels after joining cannot cancel the read the active caller is waiting for.
    const cancelledController = new AbortController();
    const cancelledOpen = reconciliation.hydrateSessionWindow("session-1", {
      limit: 2,
      signal: cancelledController.signal
    });
    cancelledController.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(hydrateSessionWindow).toHaveBeenCalledTimes(1);
    expect(sharedSignal?.aborted).toBe(false);
    resolveHydration?.(buildHydratedWindow());

    await expect(cancelledOpen).resolves.toBeUndefined();
    await expect(activeOpen).resolves.toEqual(
      expect.objectContaining({
        olderCursor: "older-cursor"
      })
    );
    expect(runtimeService.listSessions({ includeArchived: true })).toEqual([
      expect.objectContaining({
        sessionId: "session-1"
      })
    ]);
  });

  it("keeps a title renamed while the session was still hydrating", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const sessionIndexStore = new SessionIndexStore({ baseDir });
    const runtimeService = new SessionRuntimeService({
      engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }]
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1", absolutePath: "I:/workspace-alpha", label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1", conversationId: "conversation-1", engineId: "codex",
        title: "Session", createdAt: "2026-04-19T00:00:00.000Z", updatedAt: "2026-04-19T00:00:00.000Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-1"
    });
    let resolveHydration: ((value: ReturnType<typeof buildHydratedWindow>) => void) | undefined;
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [{
        engineId: "codex",
        discoverWorkspaces: vi.fn(),
        hydrateSession: vi.fn(() => new Promise<ReturnType<typeof buildHydratedWindow>>((resolve) => {
          resolveHydration = resolve;
        }))
      }] as never
    });

    const loading = reconciliation.ensureSessionLoaded("session-1");
    await vi.waitFor(() => { expect(resolveHydration).toBeDefined(); });
    await sessionIndexStore.renameSession("session-1", "Renamed while loading");
    resolveHydration?.(buildHydratedWindow());

    await expect(loading).resolves.toBe(true);
    expect(sessionIndexStore.getEntry("session-1")?.title).toBe("Renamed while loading");
    expect(runtimeService.getSession("session-1")?.title).toBe("Renamed while loading");
  });

  it("starts a fresh window hydration after every consumer of a shared read cancelled", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const sessionIndexStore = new SessionIndexStore({ baseDir });
    const runtimeService = new SessionRuntimeService({
      engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }]
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1", absolutePath: "I:/workspace-alpha", label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1", conversationId: "conversation-1", engineId: "codex",
        title: "Session", createdAt: "2026-04-19T00:00:00.000Z", updatedAt: "2026-04-19T00:00:00.000Z"
      },
      providerKind: "codex-thread", providerSessionId: "thread-1"
    });

    const gates: (() => void)[] = [];
    const hydrateSessionWindow = vi.fn((_entry, input) => {
      const aborted = input.signal.aborted;
      return new Promise<ReturnType<typeof buildHydratedWindow>>((resolve) => {
        gates.push(() => (aborted ? resolve(undefined as never) : resolve(buildHydratedWindow())));
      });
    });
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry, sessionIndexStore, runtimeService,
      providers: [{ engineId: "codex", discoverWorkspaces: vi.fn(), hydrateSession: vi.fn(), hydrateSessionWindow }] as never
    });

    const controller = new AbortController();
    const cancelledOpen = reconciliation.hydrateSessionWindow("session-1", {
      limit: 2, signal: controller.signal
    });
    await vi.waitFor(() => expect(hydrateSessionWindow).toHaveBeenCalledTimes(1));
    controller.abort();

    // The cancelled read is still gated, but a new caller starts a usable read instead of joining it.
    const retry = reconciliation.hydrateSessionWindow("session-1", { limit: 2 });
    await vi.waitFor(() => expect(hydrateSessionWindow).toHaveBeenCalledTimes(2));

    // Draining the cancelled task must not clear the registry entry of the new read.
    gates.shift()?.();
    await expect(cancelledOpen).resolves.toBeUndefined();
    const joined = reconciliation.hydrateSessionWindow("session-1", { limit: 2 });
    await vi.waitFor(() => expect(hydrateSessionWindow).toHaveBeenCalledTimes(2));
    gates.shift()?.();
    await expect(retry).resolves.toEqual(
      expect.objectContaining({ olderCursor: "older-cursor" })
    );
    await expect(joined).resolves.toEqual(
      expect.objectContaining({ olderCursor: "older-cursor" })
    );
    expect(hydrateSessionWindow).toHaveBeenCalledTimes(2);
  });

  it("discovers codex threads, derives subagent relations, and hydrates discovered sessions", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });

    const rootThread = createThread({
      id: "thread-root",
      name: "Root Thread",
      preview: "Root preview"
    });
    const childThread = createThread({
      id: "thread-child",
      name: "Child Thread",
      preview: "Child preview",
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "thread-root",
            depth: 1,
            agent_nickname: "child",
            agent_role: "reviewer"
          }
        }
      }
    });

    const attachThreadToSession = vi.fn();
    const rootHydratedThread = {
      ...rootThread,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "msg-user-1",
              content: [
                {
                  type: "text",
                  text: "Reply with exactly hi.",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "msg-1",
              text: "Hydrated root response",
              phase: null,
              memoryCitation: null
            },
            {
              type: "fileChange",
              id: "file-change-1",
              status: "completed",
              changes: [
                {
                  path: "src/foo.ts",
                  kind: {
                    type: "update",
                    move_path: null
                  },
                  diff: `@@ -1 +1 @@
-old
+new`
                }
              ]
            },
            {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "thread-root",
              receiverThreadIds: ["thread-child"],
              prompt: "Review this change",
              model: "gpt-5",
              reasoningEffort: "high",
              agentsStates: {
                "thread-child": {
                  status: "completed",
                  message: "Reviewed successfully"
                }
              }
            }
          ]
        },
        {
          id: "turn-2",
          status: "failed",
          error: {
            message: "Boom",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: "Try again later."
          },
          items: []
        }
      ]
    };
    const childHydratedThread = {
      ...childThread,
      turns: [
        {
          id: "child-turn-1",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "child-user-1",
              content: [
                {
                  type: "text",
                  text: "Review this change",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "child-agent-1",
              text: "Reviewed successfully",
              phase: "final_answer",
              memoryCitation: null
            }
          ]
        }
      ]
    };
    const resumeThread = vi.fn().mockImplementation((threadId: string) =>
      Promise.resolve(threadId === "thread-child" ? childHydratedThread : rootHydratedThread)
    );
    const listThreads = vi.fn().mockResolvedValue({
      data: [rootThread, childThread],
      nextCursor: null
    });
    const refreshThreadGoalForSession = vi.fn().mockResolvedValue(null);

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads,
        readThread: resumeThread,
        attachThreadToSession,
        refreshThreadGoalForSession
      } as never
    });

    const runtimeService = new SessionRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await expect(reconciliation.repairWorkspaces(["workspace-1"])).resolves.toEqual({
      workspaces: 1,
      sessions: 2,
      relations: 1
    });
    expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKinds: expect.arrayContaining([
          "appServer",
          "subAgent",
          "subAgentThreadSpawn"
        ])
      })
    );

    expect(sessionIndexStore.getEntry("codex-thread:thread-root")).toMatchObject({
      providerKind: "codex-thread",
      providerSessionId: "thread-root",
      conversationId: "conversation-discovered:codex-thread:thread-root",
      source: "reconciled"
    });
    expect(sessionIndexStore.getEntry("codex-thread:thread-child")).toMatchObject({
      providerSessionId: "thread-child",
      conversationId: "conversation-discovered:codex-thread:thread-root"
    });
    expect(sessionIndexStore.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "codex-thread:thread-root",
        childSessionId: "codex-thread:thread-child",
        relationType: "subagent"
      })
    ]);

    await expect(
      reconciliation.ensureSessionLoaded("codex-thread:thread-root")
    ).resolves.toBe(true);

    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-root",
      "thread-root",
      false
    );
    expect(refreshThreadGoalForSession).toHaveBeenCalledWith(
      "codex-thread:thread-root"
    );
    expect(runtimeService.listSessions({ includeArchived: true })).toEqual([
      expect.objectContaining({
        sessionId: "codex-thread:thread-root",
        conversationId: "conversation-discovered:codex-thread:thread-root"
      })
    ]);
    expect(sessionIndexStore.getEntry("codex-thread:thread-root")).toMatchObject({
      lastCompletedTurnAt: "2026-04-17T10:01:01.000Z"
    });
    expect(runtimeService.getSnapshot().messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          role: "user",
          text: "Reply with exactly hi."
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          role: "assistant",
          text: "Hydrated root response"
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          turnId: "turn-2",
          role: "system",
          text: "Runtime error (usageLimitExceeded): Boom\n\nTry again later."
        })
      ])
    );
    expect(runtimeService.getSnapshot().messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "codex-thread:thread-root:msg-user-1:md",
          messageId: "codex-thread:thread-root:msg-user-1"
        }),
        expect.objectContaining({
          blockId: "codex-thread:thread-root:msg-1:md",
          messageId: "codex-thread:thread-root:msg-1"
        })
      ])
    );
    expect(runtimeService.getSnapshot().toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          turnId: "turn-1",
          toolName: "subagent.spawn",
          inputSummary: expect.stringContaining("Review this change"),
          outputSummary: expect.stringContaining("thread-child: completed")
        })
      ])
    );
    expect(runtimeService.getSnapshot().turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn-1"
        }),
        expect.objectContaining({
          turnId: "turn-2",
          status: "completed",
          finishReason: "failed"
        })
      ])
    );
    expect(
      getRecordedCodexTurnChanges("codex-thread:thread-root", "turn-1")
    ).toMatchObject({
      changes: [
        expect.objectContaining({
          path: "src/foo.ts",
          changeKind: "update"
        })
      ]
    });

    await expect(
      reconciliation.ensureSessionLoaded("codex-thread:thread-child")
    ).resolves.toBe(true);
    expect(runtimeService.getSnapshot().messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "codex-thread:thread-child",
          role: "user",
          text: "Review this change"
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-child",
          role: "assistant",
          text: "Reviewed successfully"
        })
      ])
    );
  });

  it("aliases discovered subagent relations onto an existing local parent session by provider session id", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    const runtimeService = new SessionRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-root-local",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Local Root",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-root"
    });

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [
            createThread({
              id: "thread-root",
              name: "Root Thread"
            }),
            createThread({
              id: "thread-child",
              name: "Child Thread",
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: "thread-root",
                    depth: 1,
                    agent_nickname: "child",
                    agent_role: "reviewer"
                  }
                }
              }
            })
          ],
          nextCursor: null
        })
      } as never
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await reconciliation.repairWorkspaces(["workspace-1"]);

    expect(sessionIndexStore.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "session-root-local",
        childSessionId: "codex-thread:thread-child",
        relationType: "subagent"
      })
    ]);
    expect(sessionIndexStore.getEntry("codex-thread:thread-child")).toMatchObject({
      conversationId: "conversation-discovered:session-root-local",
      providerSessionId: "thread-child"
    });
  });

  it.each([false, true])("cold-loads hidden ancestors with original ownership (earlier inherited refork: %s)", async (earlierRefork) => {
    const baseDir = await createTempDir();
    const index = new SessionIndexStore({ baseDir });
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const runtimeService = new SessionRuntimeService({
      engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }]
    });
    const histories: Record<string, string[]> = {
      root: ["r"], A: ["r", "a1", "a2", "a-tail"],
      B: ["r", "a1", "b1", "b-tail"], C: ["r", "a1", "b1", "c"], D: ["r", "a1", "a2", "d"]
    };
    if (earlierRefork) {
      histories.B = ["r", "a1", "a2", "b1", "b-tail"];
      histories.C = ["r", "a1", "c"];
      delete histories.D;
    }
    for (const id of Object.keys(histories)) {
      await index.upsertSession({ workspaceId: "workspace-1", session: {
        ...buildHydratedWindow(id).session
      }, providerKind: "codex-thread", providerSessionId: `thread-${id}` });
      // 隐藏的分支仍是普通会话，只是它独有的尾部不再出现在会话树上。
      if (["A", "B"].includes(id)) await index.hideSession(id, "2026-09-10T00:00:00Z");
    }
    const forkRelations: [string, string, string][] = [
      ["root", "A", "r"], ["A", "B", earlierRefork ? "a2" : "a1"],
      ["B", "C", earlierRefork ? "a1" : "b1"], ...(!earlierRefork ? [["A", "D", "a2"]] : [])
    ];
    for (const [parentSessionId, childSessionId, sourceTurnId] of forkRelations) {
      await index.upsertRelation({ workspaceId: "workspace-1", parentSessionId,
        childSessionId, sourceTurnId, relationType: "fork" });
    }
    // A fork thread carries its inherited prefix in its own rollout, so thread creation time
    // separates inherited turns from the turns the session actually owns.
    const firstTurnStartedAt = 1_747_110_000;
    const historyThread = (threadId: string): Thread => {
      const sessionId = threadId.slice(7);
      const history = histories[sessionId]!;
      const fork = forkRelations.find(([, childSessionId]) => childSessionId === sessionId);
      const startedAt = (turnId: string): number =>
        firstTurnStartedAt + history.indexOf(turnId) * 6;
      return {
        ...createThread({
          id: threadId,
          forkedFromId: fork ? `thread-${fork[0]}` : null
        }),
        createdAt: fork ? startedAt(fork[2]) + 1 : startedAt(history[0]!),
        turns: history.map((id) => ({
          id, status: "completed" as const, error: null,
          startedAt: startedAt(id), completedAt: startedAt(id) + 1,
          items: [{ id: `question-${id}`, type: "userMessage", content: [{ type: "text", text: id, text_elements: [] }] }]
        }))
      };
    };
    const readThread = vi.fn(async (threadId: string, includeTurns: boolean) => {
      const thread = historyThread(threadId);
      return includeTurns
        ? thread
        : { ...thread, turns: [], status: { type: "notLoaded" as const } };
    });
    const resumeThread = vi.fn(async (threadId: string) => historyThread(threadId));
    const provider = new CodexSessionDiscoveryProvider({ codexRuntimePort: {
      readThread, resumeThread, releaseHistoryRead: vi.fn(), attachThreadToSession: vi.fn()
    } as never });
    const reconciliation = new SessionReconciliationService({ workspaceRegistry, sessionIndexStore: index,
      runtimeService, providers: [provider] });
    const treeService = new WrapperChatTreeService({ runtimeService, sessionIndexStore: index,
      reconciliation, fork: vi.fn() });
    try {
      const tree = await treeService.get("C");
      expect(tree.visibleTurnIds).toEqual(earlierRefork ? ["r", "a1", "c"] : ["r", "a1", "b1", "c"]);
      expect(Object.fromEntries(tree.nodes.map((node) => [node.nodeId, node.sessionId]))).toEqual(earlierRefork ? {
        r: "root", a1: "A", c: "C"
      } : {
        r: "root", a1: "A", a2: "A", b1: "B", c: "C", d: "D"
      });
      const snapshot = runtimeService.getSnapshot();
      expect(snapshot.messageBlocks.filter((block) => block.turnId === "a1")).toEqual([
        expect.objectContaining({ sessionId: "A", text: "a1" })
      ]);
      expect(index.getEntry("A")).toMatchObject({ hiddenAt: "2026-09-10T00:00:00Z", providerSessionId: "thread-A" });
      expect(index.getEntry("B")).toMatchObject({ hiddenAt: "2026-09-10T00:00:00Z", providerSessionId: "thread-B" });
      expect(index.getEntry("A")?.archivedAt).toBeUndefined();
      expect(index.getEntry("B")?.archivedAt).toBeUndefined();
      if (!earlierRefork) {
        await treeService.jump("C", "d");
        expect((await treeService.get("C")).visibleTurnIds).toEqual(["r", "a1", "a2", "d"]);
      }
    } finally {
      treeService.dispose();
    }
  });

  it("commits a fork child without waiting for its ancestor to finish loading", async () => {
    const baseDir = await createTempDir();
    const index = new SessionIndexStore({ baseDir });
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const runtimeService = new SessionRuntimeService({
      engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }]
    });
    const workspaceId = "workspace-1";
    const time = "2026-04-19T00:00:00.000Z";
    const makeSession = (sessionId: string, status: "idle" | "running") => ({
      sessionId,
      conversationId: "conversation-1",
      engineId: "codex",
      status,
      title: sessionId,
      createdAt: time,
      updatedAt: time
    });
    const makeTurn = (
      sessionId: string,
      turnId: string,
      offset: number,
      status: "completed" | "streaming" = "completed"
    ) => ({
      turnId,
      sessionId,
      status,
      ...(status === "completed" ? { finishReason: "completed" as const } : {}),
      startedAt: `2026-04-19T00:00:0${offset}.000Z`,
      ...(status === "completed"
        ? { completedAt: `2026-04-19T00:00:0${offset + 1}.000Z` }
        : {}),
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: []
    });
    const makeHydrated = (
      sessionId: string,
      turns: ReturnType<typeof makeTurn>[],
      status: "idle" | "running" = "idle"
    ) => ({
      workspaceId,
      conversation: {
        conversationId: "conversation-1",
        workspaceId,
        participantEngineIds: ["codex"],
        activeSessionId: sessionId,
        sessionIds: ["parent", "child"],
        createdAt: time,
        updatedAt: time
      },
      session: makeSession(sessionId, status),
      turns,
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      runtimeBinding: {
        providerKind: "codex-thread",
        providerSessionId: `thread-${sessionId}`
      }
    });

    for (const [sessionId, status] of [["parent", "running"], ["child", "idle"]] as const) {
      await index.upsertSession({
        workspaceId,
        session: makeSession(sessionId, status),
        providerKind: "codex-thread",
        providerSessionId: `thread-${sessionId}`
      });
    }
    await index.upsertRelation({
      workspaceId,
      parentSessionId: "parent",
      childSessionId: "child",
      relationType: "fork",
      sourceTurnId: "parent-2"
    });

    runtimeService.hydrateDiscoveredSession(makeHydrated("parent", [
      makeTurn("parent", "parent-1", 0),
      makeTurn("parent", "parent-2", 2, "streaming"),
      makeTurn("parent", "parent-live", 6, "streaming")
    ], "running"));
    let releaseParent!: () => void;
    let parentHydrationStarted!: () => void;
    let childHydrationReturned = false;
    const parentHydration = new Promise<void>((resolve) => { parentHydrationStarted = resolve; });
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const hydrateSession = vi.fn(async (entry: { sessionId: string }) => {
      if (entry.sessionId === "parent") {
        parentHydrationStarted();
        await parentGate;
        return makeHydrated("parent", [
          makeTurn("parent", "parent-1", 0),
          makeTurn("parent", "parent-2", 2, "streaming")
        ]);
      }
      childHydrationReturned = true;
      // 引擎适配层只交出子会话自有轮次，对账层不再依赖祖先的加载状态判定归属。
      return makeHydrated("child", [makeTurn("child", "child-1", 4)]);
    });
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore: index,
      runtimeService,
      providers: [{ engineId: "codex", hydrateSession }] as never
    });
    const treeService = new WrapperChatTreeService({
      runtimeService,
      sessionIndexStore: index,
      reconciliation,
      fork: vi.fn()
    });

    try {
      const treePromise = treeService.get("child");
      await parentHydration;
      runtimeService.applyRuntimeEvent({
        type: "turn.completed",
        sessionId: "parent",
        turnId: "parent-2",
        finishReason: "completed"
      });
      runtimeService.applyRuntimeEvent({
        type: "turn.started",
        sessionId: "parent",
        turnId: "parent-live"
      });
      await vi.waitFor(() => expect(childHydrationReturned).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtimeService.getSnapshot().turns.some((turn) => turn.turnId === "child-1")).toBe(true);
      expect(hydrateSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "child" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      releaseParent();
      const tree = await treePromise;

      expect(tree.nodes.map(({ nodeId, parentNodeId, sessionId }) => ({
        nodeId,
        parentNodeId,
        sessionId
      }))).toEqual([
        { nodeId: "parent-1", parentNodeId: undefined, sessionId: "parent" },
        { nodeId: "parent-2", parentNodeId: "parent-1", sessionId: "parent" },
        { nodeId: "parent-live", parentNodeId: "parent-2", sessionId: "parent" },
        { nodeId: "child-1", parentNodeId: "parent-2", sessionId: "child" }
      ]);
      expect(tree.nodes.find((node) => node.nodeId === "parent-2")?.status).toBe("completed");
      expect(runtimeService.getSession("parent")?.status).toBe("running");
    } finally {
      treeService.dispose();
    }
  });

  it("uses index-backed fork parent aliases when hydrating provider relations", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    const runtimeService = new SessionRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-root-local",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Local Root",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-root"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "codex-thread:thread-child",
        conversationId: "conversation-discovered:session-root-local",
        engineId: "codex",
        title: "Forked Child",
        createdAt: "2026-04-18T00:00:03Z",
        updatedAt: "2026-04-18T00:00:04Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-child"
    });
    await sessionIndexStore.upsertRelation({
      workspaceId: "workspace-1",
      parentSessionId: "session-root-local",
      childSessionId: "codex-thread:thread-child",
      relationType: "fork",
      createdAt: "2026-04-18T00:00:05Z"
    });

    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      ...buildHydratedWindow("codex-thread:thread-child"),
      runtimeBinding: {
        providerKind: "codex-thread",
        providerSessionId: "thread-child"
      },
      sessionRelations: [
        {
          relationId:
            "relation-discovered:codex-thread:thread-other-parent:codex-thread:thread-child:subagent",
          parentSessionId: "codex-thread:thread-other-parent",
          childSessionId: "codex-thread:thread-child",
          relationType: "subagent",
          createdAt: "2026-04-18T00:00:05Z"
        }
      ]
    });
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [
        {
          engineId: "codex",
          discoverWorkspaces: vi.fn(),
          hydrateSession: vi.fn(),
          hydrateSessionWindow
        }
      ] as never
    });

    await reconciliation.hydrateSessionWindow("codex-thread:thread-child", {
      limit: 20
    });

    expect(runtimeService.getSnapshot().sessionRelations).toEqual([
      expect.objectContaining({
        parentSessionId: "session-root-local",
        childSessionId: "codex-thread:thread-child",
        relationType: "fork"
      })
    ]);
  });

  it("reads a released Worker without recreating its execution environment", async () => {
    const readThread = vi.fn().mockResolvedValue(createThread({ id: "thread-released" }));
    const resumeThread = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({ codexRuntimePort: {
      isThreadExecutionReleased: () => true,
      readThread, resumeThread, attachThreadToSession: vi.fn()
    } as never });
    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1", sessionId: "worker", conversationId: "conversation-1",
      engineId: "codex", providerKind: "codex-thread", providerSessionId: "thread-released",
      createdAt: "2026-04-19T00:00:00.000Z", updatedAt: "2026-04-19T00:00:01.000Z"
    });
    expect(hydrated?.session.sessionId).toBe("worker");
    expect(readThread.mock.calls).toEqual([
      ["thread-released", false, { signal: undefined }],
      ["thread-released", true, { signal: undefined }]
    ]);
    expect(resumeThread).not.toHaveBeenCalled();
  });

  it("keeps hydrated message blocks distinct when different sessions reuse item ids", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi
          .fn()
          .mockImplementation(async (threadId: string) => ({
            ...createThread({
              id: threadId,
              name: `Thread ${threadId}`,
              preview: `Preview ${threadId}`
            }),
            turns: [
              {
                id: `${threadId}-turn-1`,
                status: "completed",
                error: null,
                items: [
                  {
                    type: "userMessage",
                    id: "item-1",
                    content: [
                      {
                        type: "text",
                        text: `Prompt ${threadId}`,
                        text_elements: []
                      }
                    ]
                  },
                  {
                    type: "agentMessage",
                    id: "item-2",
                    text: `Answer ${threadId}`,
                    phase: null,
                    memoryCitation: null
                  }
                ]
              }
            ]
          })),
        attachThreadToSession: vi.fn()
      } as never
    });

    const first = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-a",
      conversationId: "conversation-a",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-a",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });
    const second = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-b",
      conversationId: "conversation-b",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-b",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(first?.turns[0]?.messageIds).toEqual([
      "codex-thread:thread-a:item-1",
      "codex-thread:thread-a:item-2"
    ]);
    expect(second?.turns[0]?.messageIds).toEqual([
      "codex-thread:thread-b:item-1",
      "codex-thread:thread-b:item-2"
    ]);
    expect(first?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "codex-thread:thread-a:item-1:md",
          text: "Prompt thread-a"
        }),
        expect.objectContaining({
          blockId: "codex-thread:thread-a:item-2:md",
          text: "Answer thread-a"
        })
      ])
    );
    expect(second?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "codex-thread:thread-b:item-1:md",
          text: "Prompt thread-b"
        }),
        expect.objectContaining({
          blockId: "codex-thread:thread-b:item-2:md",
          text: "Answer thread-b"
        })
      ])
    );
  });

  it("uses rollout timestamps when hydrating restored codex messages", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-02T02:48:38.930Z",
          type: "event_msg",
          payload: {
            type: "task_started"
          }
        },
        {
          timestamp: "2026-05-02T02:48:39.123Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Please summarize."
          }
        },
        {
          timestamp: "2026-05-02T02:48:51.597Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Done."
              }
            ]
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-rollout-time",
            name: "Thread rollout time",
            preview: "Preview rollout time"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-rollout-time",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-1",
                  content: [
                    {
                      type: "text",
                      text: "Please summarize.",
                      text_elements: []
                    }
                  ]
                },
                {
                  type: "agentMessage",
                  id: "agent-1",
                  text: "Done.",
                  phase: "final_answer",
                  memoryCitation: null
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-rollout-time",
      conversationId: "conversation-rollout-time",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-rollout-time",
      createdAt: "2026-05-01T01:20:36.847Z",
      updatedAt: "2026-05-02T02:48:53.187Z"
    });

    expect(hydrated?.turns[0]).toMatchObject({
      startedAt: "2026-05-02T02:48:39.123Z",
      completedAt: "2026-05-02T02:48:51.597Z"
    });
    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "codex-thread:thread-rollout-time:user-1",
          startedAt: "2026-05-02T02:48:39.123Z"
        }),
        expect.objectContaining({
          messageId: "codex-thread:thread-rollout-time:agent-1",
          startedAt: "2026-05-02T02:48:51.597Z",
          completedAt: "2026-05-02T02:48:51.597Z"
        })
      ])
    );
  });

  it("keeps inherited Codex turns out of a fork session", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-fork.jsonl");
    const threadId = "0196d8ea-4d00-7000-8000-000000000000";
    const ownTurnId = "0196d8ea-50e8-7000-8000-000000000000";
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2025-05-13T04:26:41.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: ownTurnId }
        },
        {
          timestamp: "2025-05-13T04:26:42.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: ownTurnId }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );
    const thread = {
      ...createThread({ id: threadId, forkedFromId: "parent-thread" }),
      createdAt: 1_747_110_400,
      path: rolloutPath,
      turns: [
        {
          id: "0196d8d0-f600-7000-8000-000000000000",
          status: "completed" as const,
          error: null,
          itemsView: "full" as const,
          startedAt: 1_747_110_400,
          completedAt: 1_747_110_400,
          durationMs: 1_000,
          items: []
        },
        {
          id: ownTurnId,
          status: "completed" as const,
          error: null,
          itemsView: "full" as const,
          startedAt: 1_747_110_401,
          completedAt: 1_747_110_402,
          durationMs: 1_000,
          items: []
        }
      ]
    };
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue(thread),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: `codex-thread:${threadId}`,
      conversationId: "conversation-1",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: threadId,
      createdAt: "2025-05-13T04:26:40.000Z",
      updatedAt: "2025-05-13T04:26:42.000Z"
    });

    expect(hydrated?.turns).toEqual([
      expect.objectContaining({
        turnId: ownTurnId,
        startedAt: "2025-05-13T04:26:41.000Z",
        completedAt: "2025-05-13T04:26:42.000Z"
      })
    ]);
    expect(hydrated?.sessionRelations).toEqual([
      expect.objectContaining({
        parentSessionId: "codex-thread:parent-thread",
        childSessionId: `codex-thread:${threadId}`,
        sourceTurnId: "0196d8d0-f600-7000-8000-000000000000"
      })
    ]);

    const index = new SessionIndexStore({ baseDir });
    const runtimeService = new SessionRuntimeService({
      engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }]
    });
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const parentSessionId = "codex-thread:parent-thread";
    const childSessionId = `codex-thread:${threadId}`;
    const parentSession = {
      ...hydrated!.session,
      sessionId: parentSessionId,
      title: "Parent"
    };
    const parentHydrated = {
      ...hydrated!,
      conversation: {
        ...hydrated!.conversation,
        activeSessionId: childSessionId,
        sessionIds: [parentSessionId, childSessionId]
      },
      session: parentSession,
      turns: [{
        ...hydrated!.turns[0]!,
        turnId: "0196d8d0-f600-7000-8000-000000000000",
        sessionId: parentSessionId,
        startedAt: "2025-05-13T04:10:00.000Z",
        completedAt: "2025-05-13T04:10:01.000Z"
      }],
      sessionRelations: []
    };
    for (const [session, providerSessionId] of [
      [parentSession, "parent-thread"],
      [hydrated!.session, threadId]
    ] as const) {
      await index.upsertSession({
        workspaceId: "workspace-1",
        session,
        providerKind: "codex-thread",
        providerSessionId
      });
    }
    await index.upsertRelation({
      workspaceId: "workspace-1",
      parentSessionId,
      childSessionId,
      relationType: "fork",
      createdAt: "2025-05-13T04:26:40.000Z"
    });
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore: index,
      runtimeService,
      providers: [{
        engineId: "codex",
        hydrateSession: vi.fn(async (entry: { sessionId: string }) =>
          entry.sessionId === parentSessionId ? parentHydrated : hydrated
        )
      }] as never
    });
    const treeService = new WrapperChatTreeService({
      runtimeService,
      sessionIndexStore: index,
      reconciliation,
      fork: vi.fn()
    });

    try {
      await reconciliation.ensureSessionLoaded(childSessionId);
      const tree = await treeService.get(childSessionId);
      expect(tree.nodes.map((node) => ({
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId,
        sessionId: node.sessionId
      }))).toEqual([
        {
          nodeId: "0196d8d0-f600-7000-8000-000000000000",
          parentNodeId: undefined,
          sessionId: parentSessionId
        },
        {
          nodeId: ownTurnId,
          parentNodeId: "0196d8d0-f600-7000-8000-000000000000",
          sessionId: childSessionId
        }
      ]);
      expect(index.listRelations("workspace-1")).toEqual([
        expect.objectContaining({
          childSessionId,
          sourceTurnId: "0196d8d0-f600-7000-8000-000000000000"
        })
      ]);
    } finally {
      treeService.dispose();
    }
  });

  it("filters inherited turns from a newest-first fork window", async () => {
    const threadId = "0196d8ea-4d00-7000-8000-000000000000";
    const inheritedTurn = {
      id: "0196d8d0-f600-7000-8000-000000000000",
      status: "completed" as const,
      error: null,
      itemsView: "full" as const,
      startedAt: 1_747_110_400,
      completedAt: 1_747_110_400,
      durationMs: 1_000,
      items: []
    };
    const ownTurn = {
      id: "0196d8ea-50e8-7000-8000-000000000000",
      status: "completed" as const,
      error: null,
      itemsView: "full" as const,
      startedAt: 1_747_110_401,
      completedAt: 1_747_110_402,
      durationMs: 1_000,
      items: []
    };
    const thread = {
      ...createThread({ id: threadId, forkedFromId: "parent-thread" }),
      createdAt: 1_747_110_400,
      turns: []
    };
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue(thread),
        listThreadTurns: vi.fn().mockResolvedValue({
          data: [ownTurn, inheritedTurn],
          nextCursor: "older",
          backwardsCursor: null
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: `codex-thread:${threadId}`,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: threadId,
        createdAt: "2025-05-13T04:26:40.000Z",
        updatedAt: "2025-05-13T04:26:42.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      { limit: 20 }
    );

    expect(hydrated?.turns.map((turn) => turn.turnId)).toEqual([ownTurn.id]);
  });

  it("matches duplicate rollout message records by content", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-duplicate-message-records.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-07-03T18:34:28.055Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" }
        },
        {
          timestamp: "2026-07-03T18:40:05.080Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Earlier message." }
        },
        {
          timestamp: "2026-07-03T18:40:05.090Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Earlier message." }]
          }
        },
        {
          timestamp: "2026-07-03T18:44:14.486Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Target message." }
        },
        {
          timestamp: "2026-07-03T18:44:14.496Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Target message." }]
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const timestamps = [...(await readCodexRolloutTimestampGroups(rolloutPath))[0]!.items];

    expect(
      consumeCodexRolloutTimestampForItem(timestamps, {
        type: "agentMessage",
        id: "target",
        text: "Target message.",
        phase: "commentary",
        memoryCitation: null
      })
    ).toBe("2026-07-03T18:44:14.486Z");
  });

  it("matches rollout timestamps by turn id without hydrating rollout-only messages", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-repeated-prompt.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-03T17:25:32.164Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-old"
          }
        },
        {
          timestamp: "2026-05-03T17:25:32.165Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "build个exe" }]
          }
        },
        {
          timestamp: "2026-05-03T17:25:37.793Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Old build answer." }],
            phase: "final_answer"
          }
        },
        {
          timestamp: "2026-05-03T17:50:32.030Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-new"
          }
        },
        {
          timestamp: "2026-05-03T17:50:32.031Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "build个exe" }]
          }
        },
        {
          timestamp: "2026-05-03T17:53:20.979Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "New build answer." }],
            phase: "final_answer"
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-repeated-prompt",
            name: "Thread repeated prompt",
            preview: "Preview repeated prompt"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-new",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-new",
                  content: [
                    {
                      type: "text",
                      text: "build个exe",
                      text_elements: []
                    }
                  ]
                },
                {
                  type: "agentMessage",
                  id: "agent-new",
                  text: "New build answer.",
                  phase: "final_answer",
                  memoryCitation: null
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-repeated-prompt",
      conversationId: "conversation-repeated-prompt",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-repeated-prompt",
      createdAt: "2026-05-01T01:20:36.847Z",
      updatedAt: "2026-05-03T17:53:21.097Z"
    });

    expect(hydrated?.turns[0]).toMatchObject({
      startedAt: "2026-05-03T17:50:32.031Z",
      completedAt: "2026-05-03T17:53:20.979Z",
      finalMessageId: "codex-thread:thread-repeated-prompt:agent-new"
    });
    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "codex-thread:thread-repeated-prompt:user-new",
          startedAt: "2026-05-03T17:50:32.031Z",
          text: "build个exe"
        }),
        expect.objectContaining({
          messageId: "codex-thread:thread-repeated-prompt:agent-new",
          role: "assistant",
          startedAt: "2026-05-03T17:53:20.979Z",
          text: "New build answer."
        })
      ])
    );
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Old build answer."
        })
      ])
    );
  });

  it("does not hydrate codex injected user context as a user prompt", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-injected-user-context.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-injected-context"
          }
        },
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for I:\\gpt-projects\\tqqq-tracker\n\n<INSTRUCTIONS>\n## Shell\nUse bash.\n</INSTRUCTIONS>"
              },
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>I:\\gpt-projects\\tqqq-tracker</cwd>\n</environment_context>"
              }
            ]
          }
        },
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "review当前目录下的量化交易方案" }]
          }
        },
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "review当前目录下的量化交易方案"
          }
        },
        {
          timestamp: "2026-05-02T04:40:18.672Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "我会先快速梳理项目结构。" }],
            phase: "commentary"
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-injected-context",
            name: "Thread injected context",
            preview: "Preview injected context"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-injected-context",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-injected-context",
                  content: [
                    {
                      type: "text",
                      text: "review当前目录下的量化交易方案",
                      text_elements: []
                    }
                  ]
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-injected-context",
      conversationId: "conversation-injected-context",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-injected-context",
      createdAt: "2026-05-02T04:40:11.866Z",
      updatedAt: "2026-05-02T04:40:18.672Z"
    });

    const userMessages = hydrated?.messageBlocks.filter((block) => block.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages?.[0]).toMatchObject({
      text: "review当前目录下的量化交易方案"
    });
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("AGENTS.md instructions")
        }),
        expect.objectContaining({
          text: expect.stringContaining("<environment_context>")
        })
      ])
    );
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "我会先快速梳理项目结构。"
        })
      ])
    );
  });

  it("does not hydrate rollout-only assistant messages after compaction", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-compacted-turn.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-03T18:28:10.013Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-compacted"
          }
        },
        {
          timestamp: "2026-05-03T18:28:10.013Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "我已关闭卡巴斯基，继续完成开发" }]
          }
        },
        {
          timestamp: "2026-05-03T18:28:14.963Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "恢复刚才被杀软中断后的验证状态。" }],
            phase: "commentary"
          }
        },
        {
          timestamp: "2026-05-03T18:44:57.330Z",
          type: "compacted",
          payload: {
            type: "compacted"
          }
        },
        {
          timestamp: "2026-05-03T18:44:57.330Z",
          type: "event_msg",
          payload: {
            type: "context_compacted"
          }
        },
        {
          timestamp: "2026-05-03T18:45:03.557Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "继续定位当前 app-server 测试栈溢出的原因。",
            phase: "commentary"
          }
        },
        {
          timestamp: "2026-05-04T04:01:02.174Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-compacted",
            last_agent_message: ""
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-compacted",
            name: "Thread compacted",
            preview: "Preview compacted"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-compacted",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-compacted",
                  content: [
                    {
                      type: "text",
                      text: "我已关闭卡巴斯基，继续完成开发",
                      text_elements: []
                    }
                  ]
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-compacted",
      conversationId: "conversation-compacted",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-compacted",
      createdAt: "2026-05-01T01:20:36.847Z",
      updatedAt: "2026-05-04T04:01:02.174Z"
    });

    expect(hydrated?.turns[0]?.messageIds).toEqual([
      "codex-thread:thread-compacted:user-compacted"
    ]);
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "恢复刚才被杀软中断后的验证状态。"
        }),
        expect.objectContaining({
          role: "assistant",
          text: "继续定位当前 app-server 测试栈溢出的原因。"
        })
      ])
    );
  });

  it("hydrates reasoning and web search items as generic tool calls", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-process",
            name: "Process thread",
            preview: "Process thread"
          }),
          turns: [
            {
              id: "turn-process",
              status: "completed",
              error: null,
              items: [
                {
                  type: "reasoning",
                  id: "reason-1",
                  summary: ["Checked official CPU specs"],
                  content: ["Compared low-power options"]
                },
                {
                  type: "reasoning",
                  id: "reason-empty",
                  summary: [],
                  content: []
                },
                {
                  type: "webSearch",
                  id: "search-1",
                  query: "Intel N150 official specs",
                  action: {
                    type: "search",
                    query: "Intel N150 official specs",
                    queries: ["Intel N150 Processor Base Power"]
                  }
                },
                {
                  type: "contextCompaction",
                  id: "compact-1"
                },
                {
                  type: "agentMessage",
                  id: "msg-1",
                  text: "Done",
                  phase: "final_answer",
                  memoryCitation: null
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-process",
      conversationId: "conversation-process",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-process",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(hydrated?.turns[0]?.toolCallIds).toEqual([
      "codex-thread:thread-process:reason-1",
      "codex-thread:thread-process:search-1",
      "codex-thread:thread-process:compact-1"
    ]);
    const reasoningTool = hydrated?.toolCalls.find(
      (toolCall) =>
        toolCall.toolCallId === "codex-thread:thread-process:reason-1"
    );
    const webSearchTool = hydrated?.toolCalls.find(
      (toolCall) =>
        toolCall.toolCallId === "codex-thread:thread-process:search-1"
    );
    const compactionTool = hydrated?.toolCalls.find(
      (toolCall) =>
        toolCall.toolCallId === "codex-thread:thread-process:compact-1"
    );
    expect(reasoningTool).toMatchObject({
      toolName: "reasoning",
      outputSummary: expect.stringContaining("Checked official CPU specs")
    });
    expect(webSearchTool).toMatchObject({
      toolName: "webSearch",
      inputSummary: expect.stringContaining("Intel N150 official specs")
    });
    expect(webSearchTool?.outputSummary).toBeUndefined();
    expect(compactionTool).toMatchObject({
      toolName: "contextCompaction",
      inputSummary: "compacting...",
      outputSummary: "compaction finished"
    });
  });

  it("recovers the explicit final answer or falls back to the last agent message", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-final-answer",
            name: "Thread final answer",
            preview: "Preview final answer"
          }),
          turns: [
            {
              id: "turn-final",
              status: "completed",
              error: null,
              items: [
                {
                  type: "agentMessage",
                  id: "msg-commentary",
                  text: "Thinking...",
                  phase: "commentary",
                  memoryCitation: null
                },
                {
                  type: "agentMessage",
                  id: "msg-final",
                  text: "Ship it.",
                  phase: "final_answer",
                  memoryCitation: null
                }
              ]
            },
            {
              id: "turn-legacy",
              status: "completed",
              error: null,
              items: [
                {
                  type: "agentMessage",
                  id: "msg-legacy-progress",
                  text: "Still working...",
                  phase: null,
                  memoryCitation: null
                },
                {
                  type: "agentMessage",
                  id: "msg-legacy-final",
                  text: "Legacy answer",
                  phase: null,
                  memoryCitation: null
                }
              ]
            },
            {
              id: "turn-running",
              status: "inProgress",
              error: null,
              items: [
                {
                  type: "agentMessage",
                  id: "msg-running",
                  text: "Still streaming...",
                  phase: null,
                  memoryCitation: null
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-final-answer",
      conversationId: "conversation-final-answer",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-final-answer",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(hydrated?.turns[0]).toMatchObject({
      turnId: "turn-final",
      finalMessageId: "codex-thread:thread-final-answer:msg-final",
      messageIds: [
        "codex-thread:thread-final-answer:msg-commentary",
        "codex-thread:thread-final-answer:msg-final"
      ]
    });
    expect(hydrated?.turns[1]).toMatchObject({
      turnId: "turn-legacy",
      finalMessageId:
        "codex-thread:thread-final-answer:msg-legacy-final",
      messageIds: [
        "codex-thread:thread-final-answer:msg-legacy-progress",
        "codex-thread:thread-final-answer:msg-legacy-final"
      ]
    });
    expect(hydrated?.turns[2]).toMatchObject({
      turnId: "turn-running",
      messageIds: ["codex-thread:thread-final-answer:msg-running"]
    });
    expect(hydrated?.turns[2]).not.toHaveProperty("finalMessageId");
  });

  it("serializes local image inputs as markdown images with file URLs", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        readThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-images",
            name: "Images",
            preview: "Images"
          }),
          turns: [
            {
              id: "turn-image",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "msg-image",
                  content: [
                    {
                      type: "text",
                      text: "Look at this",
                      text_elements: []
                    },
                    {
                      type: "localImage",
                      path: "C:\\\\Users\\\\TestUser\\\\Pictures\\\\cat.png"
                    }
                  ]
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-images",
      conversationId: "conversation-images",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-images",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text:
            "Look at this\n\n![image](file:///C:/Users/TestUser/Pictures/cat.png)"
        })
      ])
    );
  });

  it("deduplicates requested workspaces and leaves non-target entries untouched", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const sessionIndexStore = new SessionIndexStore({ baseDir });
    const workspaces = [
      { workspaceId: "workspace-a", absolutePath: "I:/workspace/a", label: "A" },
      { workspaceId: "workspace-b", absolutePath: "I:/workspace/b", label: "B" },
      { workspaceId: "workspace-c", absolutePath: "I:/workspace/c", label: "C" }
    ];
    for (const workspace of workspaces) {
      await workspaceRegistry.registerWorkspace(workspace);
    }
    for (const workspace of [workspaces[0]!, workspaces[2]!]) {
      await sessionIndexStore.upsertSession({
        workspaceId: workspace.workspaceId,
        session: {
          sessionId: `stale-${workspace.workspaceId}`,
          conversationId: `conversation-${workspace.workspaceId}`,
          engineId: "codex",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:01Z"
        },
        providerKind: "codex-thread",
        providerSessionId: `thread-stale-${workspace.workspaceId}`,
        source: "reconciled"
      });
    }
    const discoverWorkspaces = vi.fn(
      async (targets: readonly (typeof workspaces)[number][]) =>
        new Map(
          targets.map((workspace) => [
            workspace.workspaceId,
            {
              sessions: [{
                sessionId: `codex-thread:thread-${workspace.workspaceId}`,
                engineId: "codex",
                providerKind: "codex-thread",
                providerSessionId: `thread-${workspace.workspaceId}`,
                createdAt: "2026-04-19T00:00:00.000Z",
                updatedAt: "2026-04-19T00:01:00.000Z"
              }],
              relations: []
            }
          ])
        )
    );
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService: new SessionRuntimeService({
        engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }]
      }),
      providers: [{ engineId: "codex", discoverWorkspaces }] as never
    });

    await expect(
      reconciliation.repairWorkspaces([
        "workspace-a",
        "workspace-a",
        "missing-workspace",
        "workspace-b"
      ])
    ).resolves.toEqual({ workspaces: 2, sessions: 2, relations: 0 });

    expect(discoverWorkspaces).toHaveBeenCalledTimes(1);
    expect(discoverWorkspaces.mock.calls[0]?.[0].map((workspace) => workspace.workspaceId)).toEqual([
      "workspace-a",
      "workspace-b"
    ]);
    expect(sessionIndexStore.getEntry("codex-thread:thread-workspace-a")).toBeDefined();
    expect(sessionIndexStore.getEntry("codex-thread:thread-workspace-b")).toBeDefined();
    expect(sessionIndexStore.getEntry("stale-workspace-a")?.archivedAt).toBeDefined();
    expect(sessionIndexStore.getEntry("stale-workspace-c")?.archivedAt).toBeUndefined();
  });

  it("archives stale reconciled Codex entries that disappear from discovery", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "codex-thread:thread-stale",
        conversationId: "conversation-stale",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-stale",
      source: "reconciled"
    });

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false,
        listThreads: vi.fn().mockResolvedValue({
          data: [createThread({ id: "thread-fresh" })],
          nextCursor: null
        })
      } as never
    });
    const runtimeService = new SessionRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await reconciliation.repairWorkspaces(["workspace-1"]);

    expect(sessionIndexStore.getEntry("codex-thread:thread-stale")?.archivedAt).toBeDefined();
    expect(sessionIndexStore.getEntry("codex-thread:thread-fresh")).toMatchObject({
      providerSessionId: "thread-fresh",
      archivedAt: undefined
    });
  });

  it("omits guardian review threads from workspace discovery", async () => {
    const listThreads = vi.fn().mockResolvedValue({
      data: [
        createThread({ id: "thread-main" }),
        createThread({
          id: "thread-guardian",
          source: { subAgent: { other: "guardian" } }
        })
      ],
      nextCursor: null
    });
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        isThreadExecutionReleased: () => false, listThreads } as never
    });

    const discovered = await provider.discoverWorkspaces([{
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    }]);

    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(discovered.get("workspace-1")?.sessions.map((session) => session.sessionId))
      .toEqual(["codex-thread:thread-main"]);
  });
});
