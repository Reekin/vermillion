import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAppServerRuntimePort } from "../src/engines/codex/runtime-port.js";
import type { DomainSnapshot } from "@vermillion/shared";
import {
  clearCodexTurnChangesStore,
  getRecordedCodexTurnChanges
} from "../src/engines/codex/extensions/turn-changes-store.js";
import {
  clearCodexHookActivityStore,
  getRecordedCodexHookActivity
} from "../src/engines/codex/extensions/hook-activity-store.js";
import { HostToolRegistry } from "../src/host-tools.js";
import { createReadSessionHostTool } from "../src/read-session-host-tool.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)
);

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> => {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const readRequestLog = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const readSessionSnapshot: DomainSnapshot = {
  conversations: [
    {
      conversationId: "conversation-1",
      participantEngineIds: ["codex"],
      activeSessionId: "session-read-target",
      sessionIds: ["session-read-target"],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z"
    }
  ],
  sessions: [
    {
      sessionId: "session-read-target",
      conversationId: "conversation-1",
      engineId: "codex",
      status: "idle",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z"
    }
  ],
  turns: [
    {
      turnId: "turn-read-target",
      sessionId: "session-read-target",
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-06-06T00:00:10.000Z",
      completedAt: "2026-06-06T00:00:20.000Z",
      finalMessageId: "assistant-read-final",
      messageIds: ["user-read", "assistant-read-final"],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: [],
      interactionRequestIds: []
    }
  ],
  messageBlocks: [
    {
      blockId: "user-read-block",
      messageId: "user-read",
      sessionId: "session-read-target",
      turnId: "turn-read-target",
      role: "user",
      kind: "plain_text",
      text: "Read this target session.",
      startedAt: "2026-06-06T00:00:10.000Z"
    },
    {
      blockId: "assistant-read-final-block",
      messageId: "assistant-read-final",
      sessionId: "session-read-target",
      turnId: "turn-read-target",
      role: "assistant",
      kind: "markdown",
      phase: "final_answer",
      text: "Session final from dynamic read tool.",
      startedAt: "2026-06-06T00:00:20.000Z"
    }
  ],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  runtimeInteractions: [],
  participants: [],
  sessionRelations: []
};

describe("Codex app-server runtime port", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    clearCodexTurnChangesStore();
    clearCodexHookActivityStore();
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      if (dispose) {
        await dispose();
      }
    }
  });

  it("resolves the configured SQLite home instead of assuming CODEX_HOME", async () => {
    vi.stubEnv("CODEX_SQLITE_HOME", "");
    const port = createCodexAppServerRuntimePort({ commandPath: process.execPath, commandArgs: [fixturePath] });
    vi.spyOn(port, "start").mockResolvedValue();
    vi.spyOn(port, "getState").mockReturnValue("ready");
    const rpc = vi.spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockResolvedValue({ config: { sqlite_home: "file:///I:/isolated/codex-state" } });

    await expect(port.getCodexSqliteHome()).resolves.toBe(normalize("I:/isolated/codex-state"));
    expect(rpc).toHaveBeenCalledWith("config/read", { includeLayers: false, cwd: null });
  });

  it("forwards state-db-only thread listing to the app server", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockResolvedValue({ data: [], nextCursor: null });

    await port.listThreads({ cursor: "page-2", useStateDbOnly: true });

    expect(rpc).toHaveBeenCalledWith("thread/list",
      expect.objectContaining({
        cursor: "page-2",
        useStateDbOnly: true
      })
    );
  });

  it("forks without role parameters and appends configured instructions on resume", async () => {
    const port = createCodexAppServerRuntimePort({ commandPath: process.execPath,
      commandArgs: [fixturePath], resolveConversationIdBySessionId: () => "conversation-1" });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi.spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => method === "config/read"
        ? { config: { developer_instructions: "User configuration" } } : { thread: { id: "child" } });
    await port.forkThread("source", "completed-turn", { cwd: "I:/workspace" });
    expect(rpc).toHaveBeenCalledWith("thread/fork", { threadId: "source", lastTurnId: "completed-turn",
      cwd: "I:/workspace", threadSource: "user" });
    expect(rpc.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(false);
    rpc.mockClear();
    await port.resumeThread("child", "I:/workspace", "Execution role");
    expect(rpc).toHaveBeenCalledWith("thread/resume", expect.objectContaining({
      developerInstructions: "User configuration\n\nExecution role" }), { timeoutMs: 120_000 });
    expect(rpc.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(false);
    await port.injectDeveloperInstructions("child", "Execution role");
    expect(rpc).toHaveBeenCalledWith("thread/inject_items", expect.objectContaining({ threadId: "child" }));
  });

  it("uses current role instructions at first start and injects each later revision once", async () => {
    const rebuilt = vi.fn();
    const port = createCodexAppServerRuntimePort({ resolveConversationIdBySessionId: () => "conversation-1",
      recordRoleContextRebuilt: rebuilt });
    vi.spyOn(port, "start").mockResolvedValue();
    let turn = 0;
    const rpc = vi.spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => {
        if (method === "config/read") return { config: { developer_instructions: "User configuration" } };
        if (method === "thread/start") return { thread: { id: "thread-new" } };
        if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
        if (method === "thread/inject_items") return {};
        throw new Error(`Unexpected RPC method: ${String(method)}`);
      });
    const roleInjections = () => rpc.mock.calls.filter(([method, params]) =>
      method === "thread/inject_items" && JSON.stringify(params).includes("以下开发者指令定义当前角色"));

    await port.request({ id: "first", method: "turn/start", params: {
      sessionId: "new", content: "first", developerInstructions: "ROLE_V1"
    } });
    expect(rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      developerInstructions: "User configuration\n\nROLE_V1"
    }), {});
    expect(roleInjections()).toHaveLength(0);

    port.attachThreadToSession("existing", "thread-existing");
    await port.request({ id: "changed", method: "turn/start", params: {
      sessionId: "existing", content: "changed", developerInstructions: "ROLE_V2",
      deliveredDeveloperInstructions: "ROLE_V1"
    } });
    expect(roleInjections()).toHaveLength(1);
    expect(roleInjections()[0]?.[1]).toEqual(expect.objectContaining({ threadId: "thread-existing" }));

    await port.request({ id: "same", method: "turn/start", params: {
      sessionId: "existing", content: "same", developerInstructions: "ROLE_V2",
      deliveredDeveloperInstructions: "ROLE_V2"
    } });
    expect(roleInjections()).toHaveLength(1);

    const notify = (port as unknown as { handleNotification: (method: string, params: Record<string, unknown>) => void })
      .handleNotification.bind(port);
    const compacted = (threadId: string, turnId: string) => notify("item/completed", { threadId, turnId,
      item: { type: "contextCompaction", id: `${turnId}-item` } });
    // Compaction re-renders history from the role the thread was loaded with; the host records it as delivered.
    compacted("thread-existing", "turn-2");
    expect(rebuilt).toHaveBeenLastCalledWith("existing", "");
    compacted("thread-new", "turn-1");
    expect(rebuilt).toHaveBeenLastCalledWith("new", "ROLE_V1");
    await port.request({ id: "after-compact", method: "turn/start", params: {
      sessionId: "existing", content: "after compact", developerInstructions: "ROLE_V2",
      deliveredDeveloperInstructions: ""
    } });
    expect(roleInjections()).toHaveLength(2);
  });

  it("sends expected JSON-RPC payloads for resume and refresh helpers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-rpc-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });

      await port.interruptThread("thread-1");
      await port.unsubscribeThread("thread-1");
      await port.resumeThread("thread-1");
      await port.forkThread("thread-1");
      await port.reloadUserConfig();
      await port.reloadMcpServers();
      await port.listSkills({
        forceReload: true
      });

      const requests = readRequestLog(requestLogPath);
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "turn/interrupt",
            params: {
              threadId: "thread-1",
              turnId: ""
            }
          }),
          expect.objectContaining({
            method: "thread/unsubscribe",
            params: {
              threadId: "thread-1"
            }
          }),
          expect.objectContaining({
            method: "thread/resume",
            params: expect.objectContaining({
              threadId: "thread-1"
            })
          }),
          expect.objectContaining({
            method: "thread/fork",
            params: expect.objectContaining({
              threadId: "thread-1",
              threadSource: "user"
            })
          }),
          expect.objectContaining({
            method: "config/batchWrite",
            params: {
              edits: [],
              reloadUserConfig: true
            }
          }),
          expect.objectContaining({
            method: "skills/list",
            params: {
              forceReload: true
            }
          })
        ])
      );
      const mcpReloadRequest = requests.find(
        (request) => request.method === "config/mcpServer/reload"
      );
      expect(mcpReloadRequest).toEqual(
        expect.objectContaining({
          method: "config/mcpServer/reload"
        })
      );
      expect(mcpReloadRequest).not.toHaveProperty("params");
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("reports best-effort interrupt failures without rejecting resume callers", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());
    const runtimeErrors: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "runtime.error") {
        runtimeErrors.push(event.params);
      }
    });

    await port.start({
      env: {
        FAKE_CODEX_INTERRUPT_ERROR: "no active turn to interrupt"
      }
    });

    await expect(
      port.interruptThread("thread-1", {
        bestEffort: true
      })
    ).resolves.toBeUndefined();
    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        code: "CODEX_TURN_INTERRUPT_FAILED",
        message: "no active turn to interrupt",
        recoverable: true,
        details: {
          threadId: "thread-1"
        }
      })
    ]);
  });

  it("rejects unanswered JSON-RPC requests by deadline", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    await port.start({
      env: {
        FAKE_CODEX_HANG_METHOD: "turn/start"
      }
    });

    await expect(
      port.request(
        {
          id: "turn-timeout",
          method: "turn/start",
          params: {
            sessionId: "session-timeout",
            content: "this request will not receive a response"
          }
        },
        {
          timeoutMs: 25
        }
      )
    ).rejects.toMatchObject({
      code: "runtime_request_timeout",
      details: expect.objectContaining({
        method: "turn/start"
      })
    });
  });

  it("rejects pending JSON-RPC requests when the app-server exits mid-request", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    await port.start({
      env: {
        FAKE_CODEX_EXIT_ON_METHOD: "turn/start",
        FAKE_CODEX_EXIT_CODE: "23"
      }
    });

    await expect(
      port.request(
        {
          id: "turn-exit",
          method: "turn/start",
          params: {
            sessionId: "session-exit",
            content: "this request exits the process"
          }
        },
        {
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      code: "runtime_process_exited",
      details: expect.objectContaining({
        code: 23
      })
    });
    expect(port.getState()).toBe("failed");
    expect(port.getThreadIdForSession("session-exit")).toBeUndefined();
  });

  it("lists every visible model page with provider-native reasoning options", async () => {
    const port = createCodexAppServerRuntimePort({ engineId: "codex" });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockResolvedValueOnce({
        data: [
          {
            model: "gpt-visible",
            displayName: "GPT Visible",
            description: "Visible model",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "xhigh", description: "Deep reasoning" }
            ],
            defaultReasoningEffort: "xhigh",
            serviceTiers: [
              {
                id: "priority",
                name: "Fast",
                description: "1.5x speed, increased usage"
              },
              {
                id: "ultrafast",
                name: "Ultrafast",
                description: "5x speed, increased usage"
              }
            ],
            defaultServiceTier: null,
            isDefault: true
          },
          {
            model: "gpt-hidden",
            displayName: "GPT Hidden",
            description: "Hidden model",
            hidden: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false
          }
        ],
        nextCursor: "page-2"
      })
      .mockResolvedValueOnce({
        data: [
          {
            model: "gpt-next",
            displayName: "GPT Next",
            description: "",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Faster" }
            ],
            defaultReasoningEffort: "low",
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false
          }
        ],
        nextCursor: null
      });

    await expect(port.listModelCatalog()).resolves.toEqual({
      engineId: "codex",
      models: [
        {
          modelId: "gpt-visible",
          displayName: "GPT Visible",
          description: "Visible model",
          reasoningOptions: [
            {
              optionId: "xhigh",
              displayName: "Xhigh",
              description: "Deep reasoning"
            }
          ],
          defaultReasoningOptionId: "xhigh",
          serviceTiers: [
            {
              tierId: "priority",
              displayName: "Fast",
              description: "1.5x speed, increased usage"
            },
            {
              tierId: "ultrafast",
              displayName: "Ultrafast",
              description: "5x speed, increased usage"
            }
          ],
          isDefault: true
        },
        {
          modelId: "gpt-next",
          displayName: "GPT Next",
          reasoningOptions: [
            {
              optionId: "low",
              displayName: "Low",
              description: "Faster"
            }
          ],
          defaultReasoningOptionId: "low",
          serviceTiers: [],
          isDefault: false
        }
      ]
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "model/list", {
      cursor: null,
      includeHidden: false
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "model/list", {
      cursor: "page-2",
      includeHidden: false
    });
  });

  it("cleans up failed initialize attempts and can start a fresh process", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    await expect(
      port.start({
        env: {
          FAKE_CODEX_EXIT_ON_METHOD: "initialize",
          FAKE_CODEX_EXIT_CODE: "24"
        }
      })
    ).rejects.toMatchObject({
      code: "runtime_process_exited",
      details: expect.objectContaining({
        code: 24
      })
    });
    expect(port.getState()).toBe("failed");

    await port.start();
    expect(port.getState()).toBe("ready");
    await expect(
      port.request(
        {
          id: "turn-after-retry",
          method: "turn/start",
          params: {
            sessionId: "session-after-retry",
            content: "the retry path should use the fresh process"
          }
        },
        {
          timeoutMs: 1000
        }
      )
    ).resolves.toMatchObject({
      id: "turn-after-retry",
      ok: true
    });
  });

  it("refreshes persisted thread goals through thread/goal/get", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-goal-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());
    const goalEvents: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "thread.goal.updated") {
        goalEvents.push(event.params);
      }
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath,
          FAKE_CODEX_THREAD_GOAL_OBJECTIVE: "Resume the persisted goal"
        }
      });
      port.attachThreadToSession("session-goal", "thread-goal");

      await expect(
        port.refreshThreadGoalForSession("session-goal")
      ).resolves.toMatchObject({
        threadId: "thread-goal",
        objective: "Resume the persisted goal",
        status: "active"
      });

      expect(readRequestLog(requestLogPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "thread/goal/get",
            params: {
              threadId: "thread-goal"
            }
          })
        ])
      );
      expect(goalEvents).toEqual([
        expect.objectContaining({
          sessionId: "session-goal",
          threadId: "thread-goal",
          goal: expect.objectContaining({
            objective: "Resume the persisted goal"
          })
        })
      ]);
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("rejects clear goal requests before a session is attached to a thread", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    await port.start();

    await expect(
      port.request({
        id: "goal-clear-missing",
        method: "thread/goal/clear",
        params: {
          sessionId: "session-missing"
        }
      })
    ).rejects.toThrow("Cannot clear goal before session is attached");
  });

  it("rejects status-only goal updates without materializing a new thread", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-goal-status-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });

      await expect(
        port.request({
          id: "goal-pause-missing",
          method: "thread/goal/set",
          params: {
            sessionId: "session-missing",
            status: "paused"
          }
        })
      ).rejects.toThrow("Cannot update goal status before session is attached");

      expect(
        readRequestLog(requestLogPath).some(
          (request) => request.method === "thread/start"
        )
      ).toBe(false);
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it.each([
    { rejection: "no active turn to steer", expected: ["turn/steer", "turn/start"], delivery: "start_or_steer" },
    { rejection: "expected active turn id `old` but found `new`", expected: ["turn/steer", "turn/steer"], delivery: "steered" }
  ])("delivers shared steering after confirmed rejection: $rejection", async ({ rejection, expected, delivery }) => {
    const port = createCodexAppServerRuntimePort({ commandPath: process.execPath, commandArgs: [fixturePath] });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi.spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockResolvedValueOnce({ thread: { id: "thread" } })
      .mockResolvedValueOnce({ turn: { id: "old" } });
    await port.request({ id: "start", method: "turn/start", params: { sessionId: "worker", content: "initial" } });
    rpc.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error(rejection), {
      code: "runtime_protocol_error", details: { method: "turn/steer", jsonRpcCode: -32600 }
    })).mockResolvedValueOnce(delivery === "steered" ? { turnId: "new" } : { turn: { id: "new" } });
    const response = await port.request({ id: "update", method: "turn/steer", params: {
      sessionId: "worker", workspaceId: "workspace", turnId: "old", content: "update", attachments: []
    } });
    expect(response.result).toEqual({ accepted: true, sessionId: "worker", turnId: "new", delivery });
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(["thread/inject_items", ...expected]);
    expect(rpc.mock.calls[2]![1]).toEqual(expect.objectContaining({ threadId: "thread", input: [{ type: "text", text: "update", text_elements: [] }] }));
    if (delivery === "steered") expect(rpc.mock.calls[2]![1]).toHaveProperty("expectedTurnId", "new");
  });

  it.each([
    new Error("connection lost"),
    Object.assign(new Error("no active turn to steer"), { code: "runtime_request_timeout", details: { method: "turn/steer" } }),
    Object.assign(new Error("cannot steer a review turn"), { code: "runtime_protocol_error", details: { method: "turn/steer" } })
  ])("does not redeliver uncertain or unsupported steering rejection: %s", async (error) => {
    const port = createCodexAppServerRuntimePort({ commandPath: process.execPath, commandArgs: [fixturePath] });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi.spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockResolvedValueOnce({ thread: { id: "thread" } })
      .mockResolvedValueOnce({ turn: { id: "old" } });
    await port.request({ id: "start", method: "turn/start", params: { sessionId: "worker", content: "initial" } });
    rpc.mockReset().mockRejectedValue(error);
    await expect(port.request({ id: "update", method: "turn/steer", params: {
      sessionId: "worker", turnId: "old", content: "update"
    } })).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("bounds repeated turn mismatches without starting or duplicating input", async () => {
    const port = createCodexAppServerRuntimePort({ commandPath: process.execPath, commandArgs: [fixturePath] });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi.spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockResolvedValueOnce({ thread: { id: "thread" } })
      .mockResolvedValueOnce({ turn: { id: "old" } });
    await port.request({ id: "start", method: "turn/start", params: { sessionId: "worker", content: "initial" } });
    const rejection = (expected: string, actual: string) => Object.assign(
      new Error(`expected active turn id \`${expected}\` but found \`${actual}\``),
      { code: "runtime_protocol_error", details: { method: "turn/steer", jsonRpcCode: -32600 } }
    );
    const second = rejection("new", "newer");
    rpc.mockReset().mockRejectedValueOnce(rejection("old", "new")).mockRejectedValueOnce(second);
    await expect(port.request({ id: "update", method: "turn/steer", params: {
      sessionId: "worker", turnId: "old", content: "update"
    } })).rejects.toBe(second);
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(["turn/steer", "turn/steer"]);
  });

  it("resumes the provider thread before starting a turn when no runtime binding exists", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => {
        if (method === "thread/resume") {
          return {
            thread: {
              id: "provider-thread-1"
            }
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn-resumed-1"
            }
          };
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`);
      });

    await port.request({
      id: "resume-before-turn",
      method: "turn/start",
      params: {
        sessionId: "session-existing-1",
        providerSessionId: "provider-thread-1",
        content: "continue the existing thread"
      }
    });

    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start"
    ]);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "thread/resume",
      expect.objectContaining({
        threadId: "provider-thread-1"
      }),
      { timeoutMs: 120_000 }
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "turn/start",
      expect.objectContaining({
        threadId: "provider-thread-1"
      }),
      {}
    );
    expect(rpc).not.toHaveBeenCalledWith("thread/start", expect.anything());
  });

  it("reconciles a timed-out resume before retrying it", async () => {
    const port = createCodexAppServerRuntimePort({
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    const timeout = Object.assign(new Error("timed out"), {
      code: "runtime_request_timeout",
      details: { requestId: "resume-1" }
    });
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ data: ["provider-thread-timeout"], nextCursor: null })
      .mockResolvedValueOnce({
        thread: {
          id: "provider-thread-timeout",
          turns: [],
          status: { type: "idle" }
        }
      });

    await expect(port.resumeThread("provider-thread-timeout")).rejects.toMatchObject({
      code: "runtime_request_timeout",
      details: {
        method: "thread/resume",
        threadId: "provider-thread-timeout",
        stage: "execution-resume",
        timeoutMs: 120_000
      }
    });
    await expect(port.resumeThread("provider-thread-timeout")).resolves.toMatchObject({
      id: "provider-thread-timeout"
    });
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/loaded/list",
      "thread/read"
    ]);
  });

  it("passes per-turn model, speed, and reasoning overrides to turn/start", async () => {
    const port = createCodexAppServerRuntimePort({
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => {
        if (method === "thread/resume") {
          return { thread: { id: "provider-thread-options" } };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-options" } };
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`);
      });

    await port.request({
      id: "turn-options-request",
      method: "turn/start",
      params: {
        sessionId: "session-options",
        providerSessionId: "provider-thread-options",
        content: "use these options",
        execution: {
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "xhigh",
          serviceTierId: "ultrafast"
        }
      }
    });

    expect(rpc).toHaveBeenLastCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "provider-thread-options",
        model: "gpt-5.5-codex",
        effort: "xhigh",
        serviceTier: "ultrafast"
      }),
      {}
    );
  });

  it("associates confirmed settings with the canonical turn and tracks model reroutes", async () => {
    const port = createCodexAppServerRuntimePort({
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    let resolveTurnStart!: (value: unknown) => void;
    const turnStart = new Promise((resolve) => {
      resolveTurnStart = resolve;
    });
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => {
        if (method === "thread/resume") {
          return {
            thread: { id: "provider-thread-confirmed" },
            model: "bootstrap-model",
            serviceTier: "default",
            reasoningEffort: "low"
          };
        }
        if (method === "turn/start") {
          return turnStart;
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`);
      });
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => events.push(event));

    const request = port.request({
      id: "confirmed-settings-request",
      method: "turn/start",
      params: {
        sessionId: "session-confirmed",
        providerSessionId: "provider-thread-confirmed",
        content: "use the confirmed settings",
        execution: {
          modelId: "requested-model",
          reasoningOptionId: "high",
          serviceTierId: "priority"
        }
      }
    });
    await waitFor(() => rpc.mock.calls.some(([method]) => method === "turn/start"));

    const handleNotification = (
      method: string,
      params: Record<string, unknown>
    ) =>
      (
        port as unknown as {
          handleNotification: (
            method: string,
            params: Record<string, unknown>
          ) => void;
        }
      ).handleNotification.call(port, method, params);
    handleNotification("thread/settings/updated", {
      threadId: "provider-thread-confirmed",
      threadSettings: {
        model: "confirmed-model",
        effort: "high",
        serviceTier: "priority"
      }
    });
    resolveTurnStart({ turn: { id: "turn-confirmed" } });
    await expect(request).resolves.toMatchObject({
      result: {
        turnId: "turn-confirmed"
      }
    });

    expect(events).toContainEqual(expect.objectContaining({
      method: "turn.started",
      params: {
        sessionId: "session-confirmed",
        turnId: "turn-confirmed",
        executionProfile: {
          modelId: "confirmed-model",
          reasoningOptionId: "high",
          serviceTierId: "priority"
        }
      }
    }));

    handleNotification("model/rerouted", {
      threadId: "provider-thread-confirmed",
      turnId: "turn-confirmed",
      fromModel: "confirmed-model",
      toModel: "rerouted-model",
      reason: "model_not_available"
    });
    expect(events).toContainEqual(expect.objectContaining({
      method: "turn.execution.updated",
      params: {
        sessionId: "session-confirmed",
        turnId: "turn-confirmed",
        executionProfile: {
          modelId: "rerouted-model",
          reasoningOptionId: "high",
          serviceTierId: "priority"
        }
      }
    }));
  });

  it("passes an explicit null service tier to return a thread to standard speed", async () => {
    const port = createCodexAppServerRuntimePort({
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => {
        if (method === "thread/resume") {
          return { thread: { id: "provider-thread-standard" } };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-standard" } };
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`);
      });

    await port.request({
      id: "turn-standard-request",
      method: "turn/start",
      params: {
        sessionId: "session-standard",
        providerSessionId: "provider-thread-standard",
        content: "return to standard speed",
        execution: {
          modelId: "gpt-5.5-codex",
          serviceTierId: null
        }
      }
    });

    expect(rpc).toHaveBeenLastCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "provider-thread-standard",
        model: "gpt-5.5-codex",
        serviceTier: null
      }),
      {}
    );
  });

  it("resumes a stale provider binding and retries turn start exactly once", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    port.attachThreadToSession("session-stale-1", "provider-thread-stale-1");
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockImplementation(async (method) => {
        if (method === "thread/resume") {
          return {
            thread: {
              id: "provider-thread-stale-1"
            }
          };
        }
        if (method === "turn/start" && rpc.mock.calls.filter(([name]) => name === "turn/start").length === 1) {
          throw Object.assign(
            new Error("thread not found: provider-thread-stale-1"),
            {
              code: "runtime_protocol_error",
              details: {
                method: "turn/start"
              }
            }
          );
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn-retried-1"
            }
          };
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`);
      });

    await port.request({
      id: "retry-stale-turn",
      method: "turn/start",
      params: {
        sessionId: "session-stale-1",
        providerSessionId: "provider-thread-stale-1",
        content: "retry after resume"
      }
    });

    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/resume",
      "turn/start"
    ]);
    expect(
      rpc.mock.calls.filter(([method]) => method === "turn/start")
    ).toHaveLength(2);
    expect(
      rpc.mock.calls.filter(([method]) => method === "thread/resume")
    ).toHaveLength(1);
  });

  it("does not resume or retry turn start for non-thread-not-found failures", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    vi.spyOn(port, "start").mockResolvedValue();
    port.attachThreadToSession("session-failed-1", "provider-thread-failed-1");
    const rpc = vi
      .spyOn(port as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, "rpc")
      .mockRejectedValue(new Error("permission denied"));

    await expect(
      port.request({
        id: "do-not-retry-turn",
        method: "turn/start",
        params: {
          sessionId: "session-failed-1",
          providerSessionId: "provider-thread-failed-1",
          content: "do not retry this request"
        }
      })
    ).rejects.toThrow("permission denied");

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "provider-thread-failed-1"
      }),
      {}
    );
  });

  it("maps real app-server style notifications into message, tool, and terminal events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: string[] = [];
    const chunks: string[] = [];
    const commandOutputEvents: Array<{ method: string; text: string }> = [];
    const completedMessages: Array<Record<string, unknown>> = [];
    const contextUpdates: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      events.push(event.method);
      if (event.method === "message.delta") {
        chunks.push(String(event.params.delta));
      }
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
      if (event.method === "terminal.output") {
        chunks.push(String(event.params.chunk));
        commandOutputEvents.push({
          method: event.method,
          text: String(event.params.chunk)
        });
      }
      if (
        event.method === "tool.delta" &&
        String(event.params.delta).includes("D:/workspace")
      ) {
        commandOutputEvents.push({
          method: event.method,
          text: String(event.params.delta)
        });
      }
      if (event.method === "session.context.updated") {
        contextUpdates.push(event.params);
      }
    });

    await port.start();
    const startResponse = await port.request({
      id: "turn-1",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "hello from test"
      }
    });

    expect(startResponse).toMatchObject({
      ok: true,
      result: {
        type: "turn_started",
        sessionId: "session-1",
        turnId: expect.any(String),
        providerSessionId: expect.any(String)
      }
    });

    await waitFor(() => events.includes("turn.completed"));

    expect(events).toEqual(
      expect.arrayContaining([
        "session.updated",
        "turn.started",
        "message.started",
        "message.delta",
        "message.completed",
        "tool.started",
        "tool.completed",
        "terminal.started",
        "terminal.output",
        "terminal.completed",
        "session.context.updated",
        "turn.completed"
      ])
    );
    expect(chunks.join("")).toContain("Real Codex says: hello from test");
    expect(chunks.join("")).toContain("D:/workspace");
    expect(commandOutputEvents.every((event) => event.method === "terminal.output")).toBe(
      true
    );
    expect(commandOutputEvents.map((event) => event.text).join("")).toContain(
      "D:/workspace"
    );
    expect(completedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          finalText: expect.stringContaining("Real Codex says: hello from test")
        })
      ])
    );
    expect(contextUpdates).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        contextUsage: expect.objectContaining({
          usedTokens: 1500,
          contextWindow: 128000,
          lastUsedTokens: 2200
        })
      })
    ]);
  });

  it("routes live turn events to the session that started the turn when thread aliases exist", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: (sessionId) => `conversation-${sessionId}`
    });
    disposers.push(() => port.stop());

    const routedSessions: string[] = [];
    port.subscribe((event) => {
      if (
        event.method === "message.delta" ||
        event.method === "message.completed" ||
        event.method === "turn.completed"
      ) {
        routedSessions.push(String(event.params.sessionId));
      }
    });

    await port.start();
    port.attachThreadToSession("session-sender", "thread-shared");
    port.attachThreadToSession("session-hydrated-alias", "thread-shared");
    await port.request({
      id: "turn-shared-thread",
      method: "turn/start",
      params: {
        sessionId: "session-sender",
        content: "route this turn to its sender"
      }
    });

    await waitFor(() => routedSessions.length > 0);
    expect(routedSessions).not.toContain("session-hydrated-alias");
    expect(routedSessions.every((sessionId) => sessionId === "session-sender")).toBe(
      true
    );
  });

  it("marks message.completed as final for the turn when upstream phase is final_answer", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-final-answer",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger final-answer"
      }
    });

    await waitFor(() => completedMessages.length > 0);

    expect(completedMessages).toEqual([
      expect.objectContaining({
        finalText: "Real Codex says: please trigger final-answer\n",
        phase: "final_answer",
        isFinalForTurn: true
      })
    ]);
  });

  it("preserves commentary phase without marking the message as final", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-commentary",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger commentary"
      }
    });

    await waitFor(() => completedMessages.length > 0);

    expect(completedMessages).toEqual([
      expect.objectContaining({
        finalText: "Real Codex says: please trigger commentary\n",
        phase: "commentary"
      })
    ]);
    expect(completedMessages[0]).not.toHaveProperty("isFinalForTurn");
  });

  it("maps reasoning and web search process items into generic tool events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-process-events",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger process-events"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:reason-empty-/)
          })
        })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:reason-/),
            toolName: "reasoning",
            inputSummary: "Reasoning"
          })
        }),
        expect.objectContaining({
          method: "tool.delta",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:reason-/),
            delta: "Looking up current market data.\n"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:reason-/),
            outputSummary: "Looking up current market data."
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringContaining(":reasoning:"),
            outputSummary: "Comparing low-power CPU options."
          })
        }),
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:web-/),
            toolName: "webSearch",
            inputSummary: expect.stringContaining("mini PC low power CPUs")
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringContaining(":webSearch:"),
            status: "completed"
          })
        }),
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:compact-/),
            toolName: "contextCompaction",
            inputSummary: "compacting..."
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^session-1:compact-/),
            outputSummary: "compaction finished"
          })
        })
      ])
    );
  });

  it("maps raw custom tool response items into a visible tool lifecycle", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-raw-custom-tool",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger raw-custom-tool"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    const toolCallId = `session-1:raw-custom-tool:${turnId}:apply-patch-${turnId}`;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            toolName: "apply_patch",
            inputSummary: expect.stringContaining("*** Begin Patch")
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            status: "completed",
            outputSummary: expect.stringContaining("Success. Updated")
          })
        })
      ])
    );
  });

  it("maps output-only raw custom tool response items when the item carries a name", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-raw-custom-tool-output-only",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger raw-custom-tool-output-only"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    const toolCallId = `session-1:raw-custom-tool:${turnId}:notify-${turnId}`;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            toolName: "notify"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            status: "completed",
            outputSummary: "background notification"
          })
        })
      ])
    );
  });

  it("maps canonical image view and generation items into visible image activity", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-image-items",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger image-items"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `session-1:image-view-${turnId}`,
            toolName: "imageView",
            inputSummary: "D:/workspace/sample.png"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `session-1:image-view-${turnId}`,
            status: "completed",
            outputSummary: expect.stringContaining(
              "![Viewed image](file:///D:/workspace/sample.png)"
            )
          })
        }),
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `session-1:image-generation-${turnId}`,
            toolName: "imageGeneration",
            inputSummary: "A quiet dashboard screenshot"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `session-1:image-generation-${turnId}`,
            status: "completed",
            outputSummary: expect.stringContaining(
              "![Generated image](file:///D:/workspace/generated.png)"
            )
          })
        })
      ])
    );
  });

  it("diagnoses unsupported canonical and raw Codex items once per type", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(async () => {
      warn.mockRestore();
      await port.stop();
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-unhandled-diagnostics",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger unhandled-diagnostics"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[vermillion] Ignored unsupported Codex ThreadItem.",
      expect.objectContaining({
        method: "item/completed",
        sessionId: "session-1",
        itemType: "plan"
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "[vermillion] Ignored unsupported Codex raw ResponseItem.",
      expect.objectContaining({
        method: "rawResponseItem/completed",
        sessionId: "session-1",
        itemType: "tool_search_call"
      })
    );
  });

  it("maps app-server error notifications from TurnError payloads", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const runtimeErrors: Array<Record<string, unknown>> = [];
    const completedTurns: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "runtime.error") {
        runtimeErrors.push(event.params);
      }
      if (event.method === "turn.completed") {
        completedTurns.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-runtime-error",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger runtime-error"
      }
    });

    await waitFor(() => runtimeErrors.length > 0 && completedTurns.length > 0);

    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        code: "other",
        message: "Boom from app-server",
        details: {
          additionalDetails: "extra details"
        },
        recoverable: false
      })
    ]);
    expect(completedTurns).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        finishReason: "failed"
      })
    ]);
  });

  it("marks app-server retrying error notifications as recoverable", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const runtimeErrors: Array<Record<string, unknown>> = [];
    const completedTurns: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "runtime.error") {
        runtimeErrors.push(event.params);
      }
      if (event.method === "turn.completed") {
        completedTurns.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-recoverable-runtime-error",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger recoverable-runtime-error"
      }
    });

    await waitFor(() => runtimeErrors.length > 0);

    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        code: "CODEX_APP_SERVER_ERROR",
        message: "Reconnecting... 1/5",
        recoverable: true
      })
    ]);
    expect(completedTurns).toEqual([]);
  });

  it("round-trips approval requests and resumes the turn after server confirmation", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-approval",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger approval"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "approval.requested")
    );

    const requestId = events.find((event) => event.method === "approval.requested")
      ?.params.requestId;

    expect(requestId).toBeDefined();

    await port.request({
      id: "approve-1",
      method: "approval/respond",
      params: {
        sessionId: "session-1",
        requestId,
        action: "approve"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session.updated",
          params: expect.objectContaining({
            conversationId: "conversation-1",
            status: "awaiting_approval"
          })
        }),
        expect.objectContaining({
          method: "approval.requested"
        }),
        expect.objectContaining({
          method: "approval.resolved",
          params: expect.objectContaining({
            action: "approve"
          })
        }),
        expect.objectContaining({
          method: "session.updated",
          params: expect.objectContaining({
            conversationId: "conversation-1",
            status: "running"
          })
        }),
        expect.objectContaining({
          method: "tool.started"
        }),
        expect.objectContaining({
          method: "terminal.output",
          params: expect.objectContaining({
            chunk: "approved\n"
          })
        }),
        expect.objectContaining({
          method: "turn.completed"
        })
      ])
    );
  });

  it("grants requested permission profile when approving permissions requests", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-permissions-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-permissions",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger permissions-approval"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.requested")
      );

      const requestId = events.find((event) => event.method === "approval.requested")
        ?.params.requestId;

      await port.request({
        id: "approve-permissions",
        method: "approval/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "approve"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.resolved")
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            permissions: {
              network: {
                domains: ["example.com"]
              },
              fileSystem: {
                entries: [
                  {
                    path: "D:/workspace",
                    access: "read"
                  }
                ]
              }
            },
            scope: "turn"
          }
        })
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("writes object-valued command approval decisions unchanged", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-object-approval-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-object-approval",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger object-approval"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.requested")
      );

      const requestId = events.find((event) => event.method === "approval.requested")
        ?.params.requestId;
      const decision = {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow"
          }
        }
      };

      await port.request({
        id: "approve-object-decision",
        method: "approval/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "approve",
          decision
        }
      });

      await waitFor(() =>
        readRequestLog(requestLogPath).some(
          (request) => String(request.id) === String(requestId) && request.result
        )
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            decision
          }
        })
      );
      expect(
        events.find((event) => event.method === "approval.requested")?.params
      ).toEqual(
        expect.objectContaining({
          availableActions: expect.arrayContaining(["applyNetworkPolicyAmendment"]),
          metadata: expect.objectContaining({
            availableDecisions: expect.arrayContaining([decision])
          })
        })
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("falls back to an available object approval decision when explicit strings are invalid", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-object-approval-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-object-approval-invalid-string",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger object-approval"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.requested")
      );

      const requestId = events.find((event) => event.method === "approval.requested")
        ?.params.requestId;
      const decision = {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow"
          }
        }
      };

      await port.request({
        id: "approve-object-invalid-string",
        method: "approval/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "approve",
          decision: "accept"
        }
      });

      await waitFor(() =>
        readRequestLog(requestLogPath).some(
          (request) => String(request.id) === String(requestId) && request.result
        )
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            decision
          }
        })
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("round-trips tool user input requests through runtime interactions", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-user-input",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger user-input"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.requested")
    );

    const requestId = events.find((event) => event.method === "interaction.requested")
      ?.params.requestId;

    await port.request({
      id: "interaction-1",
      method: "interaction/respond",
      params: {
        sessionId: "session-1",
        requestId,
        action: "submit",
        answers: {
          confirm: ["yes"]
        }
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.resolved")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "interaction.requested",
          params: expect.objectContaining({
            interactionKind: "tool_user_input"
          })
        }),
        expect.objectContaining({
          method: "interaction.resolved",
          params: expect.objectContaining({
            action: "submit",
            response: {
              answers: {
                confirm: {
                  answers: ["yes"]
                }
              }
            }
          })
        })
      ])
    );
  });

  it("normalizes tool user input decline and cancel actions to submit answers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-user-input-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-user-input-cancel",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger user-input"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "interaction.requested")
      );

      const requestId = events.find((event) => event.method === "interaction.requested")
        ?.params.requestId;

      await port.request({
        id: "interaction-cancel",
        method: "interaction/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "cancel",
          answers: {
            confirm: ["no"]
          }
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "interaction.resolved")
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            answers: {
              confirm: {
                answers: ["no"]
              }
            }
          }
        })
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "interaction.resolved",
            params: expect.objectContaining({
              action: "submit"
            })
          })
        ])
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("keeps out-of-band MCP elicitation session-scoped when turnId is null", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-mcp-elicitation-null",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger mcp-elicitation-null"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.requested")
    );

    const requested = events.find((event) => event.method === "interaction.requested");
    const requestId = requested?.params.requestId;

    expect(requested?.params).toEqual(
      expect.objectContaining({
        interactionKind: "mcp_elicitation",
        sessionId: "session-1"
      })
    );
    expect(requested?.params).not.toHaveProperty("turnId");
    expect(
      events.some(
        (event) =>
          event.method === "turn.started" && event.params.turnId === requestId
      )
    ).toBe(false);

    await port.request({
      id: "interaction-mcp-null",
      method: "interaction/respond",
      params: {
        sessionId: "session-1",
        requestId,
        action: "accept",
        content: {
          confirmed: true
        }
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.resolved")
    );

    const resolved = events.find((event) => event.method === "interaction.resolved");
    expect(resolved?.params).toEqual(
      expect.objectContaining({
        action: "accept",
        response: {
          action: "accept",
          content: {
            confirmed: true
          },
          _meta: null
        }
      })
    );
    expect(resolved?.params).not.toHaveProperty("turnId");

    const sessionUpdates = events.filter(
      (event) => event.method === "session.updated"
    );
    expect(sessionUpdates.at(-1)?.params).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        status: "idle"
      })
    );
  });

  it("maps mcp tool lifecycle and progress notifications", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-mcp",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger mcp-tool"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolName: "mcp.browser.open",
            inputSummary: expect.stringContaining("https://example.com")
          })
        }),
        expect.objectContaining({
          method: "tool.delta",
          params: expect.objectContaining({
            delta: "opening page"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            status: "completed",
            outputSummary: "opened"
          })
        })
      ])
    );
  });

  it("does not override codex sandbox and approval defaults unless explicitly selected", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start({
      cwd: "D:/workspace/vermillion/apps/desktop"
    });
    await port.request({
      id: "turn-thread-start-defaults",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "__THREAD_START_PARAMS__"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")?.finalText
    );

    expect(finalText).toContain('"cwd":"D:/workspace/vermillion/apps/desktop"');
    expect(finalText).not.toContain('"sandbox":"workspace-write"');
    expect(finalText).not.toContain('"approvalPolicy":"on-request"');
  });

  it("uses command-scoped cwd when starting a Codex thread", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start({
      cwd: "D:/workspace/vermillion/apps/desktop"
    });
    await port.request({
      id: "turn-thread-start-command-cwd",
      method: "turn/start",
      params: {
        sessionId: "session-command-cwd",
        content: "__THREAD_START_PARAMS__",
        cwd: "D:/workspace"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")?.finalText
    );

    expect(finalText).toContain('"cwd":"D:/workspace"');
  });

  it("maps subagent collaboration items into tool activity and child session events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-collab",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger subagent"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolName: "subagent.spawn",
            inputSummary: expect.stringContaining("Review this file")
          })
        }),
        expect.objectContaining({
          method: "session.created",
          params: expect.objectContaining({
            sessionId: "codex-thread:sub-thread-1",
            relation: expect.objectContaining({
              parentSessionId: "session-1",
              childSessionId: "codex-thread:sub-thread-1",
              relationType: "subagent"
            })
          })
        }),
        expect.objectContaining({
          method: "session.updated",
          params: expect.objectContaining({
            sessionId: "codex-thread:sub-thread-1",
            metadata: expect.objectContaining({
              providerSessionId: "sub-thread-1"
            })
          })
        }),
        expect.objectContaining({
          method: "message.completed",
          params: expect.objectContaining({
            sessionId: "codex-thread:sub-thread-1",
            turnId: "child-turn-1",
            messageId: "codex-thread:sub-thread-1:reviewer-task-1",
            role: "user",
            finalText: "Review this file"
          })
        }),
        expect.objectContaining({
          method: "message.completed",
          params: expect.objectContaining({
            sessionId: "codex-thread:sub-thread-1",
            turnId: "child-turn-1",
            role: "assistant",
            finalText: "Reviewed successfully"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: "session-1:collab-turn-1",
            outputSummary: expect.stringContaining("sub-thread-1: completed")
          })
        })
      ])
    );
    expect(port.getThreadIdForSession("codex-thread:sub-thread-1")).toBe("sub-thread-1");
  });

  it("interrupts the active subagent subtree when stopping a parent turn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-subtree-interrupt-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({ method: event.method, params: event.params });
    });

    await port.start({
      env: {
        FAKE_CODEX_REQUEST_LOG: requestLogPath
      }
    });
    const started = await port.request({
      id: "turn-collab-running",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger subagent-running"
      }
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.method === "turn.started" &&
          event.params.sessionId === "codex-thread:sub-thread-1"
      )
    );

    const turnId = String(
      ((started.result ?? {}) as Record<string, unknown>).turnId
    );
    await port.request({
      id: "interrupt-collab-running",
      method: "turn/interrupt",
      params: {
        sessionId: "session-1",
        turnId
      }
    });

    const interruptRequests = readRequestLog(requestLogPath).filter(
      (request) => request.method === "turn/interrupt"
    );
    expect(interruptRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ turnId })
        }),
        expect.objectContaining({
          params: {
            threadId: "sub-thread-1",
            turnId: `child-${turnId}`
          }
        })
      ])
    );
    expect(interruptRequests).toHaveLength(2);
  });

  it("passes through explicit sandbox and approval selections", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start({
      cwd: "D:/workspace/vermillion/apps/desktop",
      metadata: {
        selectedConfig: {
          sandbox: "danger-full-access",
          approvalPolicy: "never"
        }
      }
    });
    await port.request({
      id: "turn-thread-start-explicit",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "__THREAD_START_PARAMS__"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")?.finalText
    );

    expect(finalText).toContain('"sandbox":"danger-full-access"');
    expect(finalText).toContain('"approvalPolicy":"never"');
  });

  it("invokes read_session through the Codex dynamic tool path", async () => {
    const hostTools = new HostToolRegistry([
      createReadSessionHostTool({
        getSnapshot: () => readSessionSnapshot
      })
    ]);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1",
      hostTools
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-read-session-tool",
      method: "turn/start",
      params: {
        sessionId: "session-reader",
        content: "please trigger read-session-tool"
      }
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.method === "tool.completed" &&
          event.params.sessionId === "session-reader"
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-reader",
            toolName: "vermillion.read_session"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-reader",
            outputSummary: expect.stringContaining(
              "Session final from dynamic read tool."
            )
          })
        })
      ])
    );
  });

  it("records fileChange items for the Codex turn-changes extension without emitting shared diff events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-file-change",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger file-change"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "turn.diff.updated"
        })
      ])
    );
    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(
      getRecordedCodexTurnChanges("session-1", turnId)
    ).toMatchObject({
      mergedDiff: `diff --git a/apps/desktop/abc.txt b/apps/desktop/abc.txt
--- a/apps/desktop/abc.txt
+++ b/apps/desktop/abc.txt
@@ -1 +1,3 @@
-
+第一行内容
+第二行内容
+第三行内容`,
      changes: [
        expect.objectContaining({
          path: "apps/desktop/abc.txt",
          changeKind: "update"
        })
      ]
    });
  });

  it("records hook lifecycle notifications for the Codex hook activity extension", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger hook-activity"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            engineId: "codex",
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
    expect(getRecordedCodexHookActivity("session-1", turnId)).toMatchObject({
      runs: [
        expect.objectContaining({
          id: `hook-${turnId}`,
          eventName: "preToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          status: "completed",
          durationMs: 25,
          entries: [
            {
              kind: "warning",
              text: "checked command policy"
            },
            {
              kind: "context",
              text: "workspace hook context"
            }
          ]
        })
      ]
    });
  });

  it("attaches null-turn hook activity to the active Codex turn", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-thread-scope-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger thread-scope hook-activity"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            engineId: "codex",
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
    expect(getRecordedCodexHookActivity("session-1", turnId)).toMatchObject({
      runs: [
        expect.objectContaining({
          id: `thread-hook-${turnId}`,
          eventName: "sessionStart",
          scope: "thread",
          status: "completed",
          entries: [
            {
              kind: "context",
              text: "thread startup hook context"
            }
          ]
        })
      ]
    });
  });

  it("matches null-turn hook completion to a prior started run after the turn completes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(async () => {
      warn.mockRestore();
      await port.stop();
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-async-thread-scope-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger async-thread-scope hook-activity"
      }
    });

    await waitFor(() => {
      const turnId = events.find(
        (event) => event.method === "turn.completed"
      )?.params.turnId;
      return (
        typeof turnId === "string" &&
        getRecordedCodexHookActivity("session-1", turnId)?.runs[0]?.status ===
          "completed"
      );
    });

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    const hookActivity = getRecordedCodexHookActivity("session-1", turnId);
    expect(hookActivity).toMatchObject({
      runs: [
        expect.objectContaining({
          id: `async-thread-hook-${turnId}`,
          eventName: "stop",
          scope: "thread",
          status: "completed",
          durationMs: 42,
          entries: [
            {
              kind: "context",
              text: "async hook completed after turn"
            }
          ]
        })
      ]
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            engineId: "codex",
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Ignoring Codex hook activity"),
      expect.anything()
    );
  });

  it("warns instead of silently dropping null-turn hook activity with no active turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(async () => {
      warn.mockRestore();
      await port.stop();
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-post-complete-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger post-complete hook-activity"
      }
    });

    await waitFor(() =>
      warn.mock.calls.some((call) =>
        String(call[0]).includes("Ignoring Codex hook activity")
      )
    );

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(getRecordedCodexHookActivity("session-1", turnId)).toBeUndefined();
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
  });
});
