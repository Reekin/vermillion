import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainSnapshot } from "@vermillion/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalogService } from "../src/session-catalog.js";
import { SessionIndexStore } from "../src/session-index.js";
import type { SessionRuntimeService } from "../src/runtime-service.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-catalog-"));
  tempDirs.push(dir);
  return dir;
};

const emptySnapshot = (): DomainSnapshot => ({
  conversations: [],
  sessions: [],
  turns: [],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  participants: [],
  sessionRelations: []
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SessionCatalogService", () => {
  it("merges runtime and index state into flat per-workspace lists with pin and status dots", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });

    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-2",
      absolutePath: "I:/workspace-beta",
      label: "Beta"
    });
    await workspaceRegistry.setSessionPinned("session-root", true);
    await workspaceRegistry.setLastActiveSelection({
      workspaceId: "workspace-1",
      sessionId: "session-child"
    });

    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-root",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Index Root",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerSessionId: "thread-root",
      summaryText: "summary from index",
      unreadState: "unread_completed"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-archived",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Archived Session",
        createdAt: "2026-04-18T00:00:03Z",
        updatedAt: "2026-04-18T00:00:04Z",
        archivedAt: "2026-04-18T00:00:04Z"
      },
      unreadState: "read"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-2",
      session: {
        sessionId: "session-beta",
        conversationId: "conversation-2",
        engineId: "acp",
        title: "Beta Session",
        createdAt: "2026-04-18T00:00:05Z",
        updatedAt: "2026-04-18T00:00:06Z"
      },
      unreadState: "read"
    });
    await indexStore.upsertRelation({
      workspaceId: "workspace-1",
      parentSessionId: "session-root",
      childSessionId: "session-child",
      relationType: "fork",
      createdAt: "2026-04-18T00:00:07Z"
    });

    const snapshot: DomainSnapshot = {
      ...emptySnapshot(),
      conversations: [
        {
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          participantEngineIds: ["codex"],
          activeSessionId: "session-root",
          sessionIds: ["session-root", "session-child"],
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:10Z"
        },
        {
          conversationId: "conversation-2",
          workspaceId: "workspace-2",
          participantEngineIds: ["acp"],
          activeSessionId: "session-beta",
          sessionIds: ["session-beta"],
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:11Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-root",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          title: "Runtime Root",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:12Z"
        },
        {
          sessionId: "session-child",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "running",
          title: "Runtime Child",
          createdAt: "2026-04-18T00:00:08Z",
          updatedAt: "2026-04-18T00:00:11Z"
        },
        {
          sessionId: "session-beta",
          conversationId: "conversation-2",
          engineId: "acp",
          status: "completed",
          title: "Runtime Beta",
          createdAt: "2026-04-18T00:00:05Z",
          updatedAt: "2026-04-18T00:00:10Z"
        }
      ],
      turns: [
        {
          turnId: "turn-root-completed",
          sessionId: "session-root",
          status: "completed",
          startedAt: "2026-04-18T00:00:09Z",
          completedAt: "2026-04-18T00:00:13Z",
          messageIds: [],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: []
        }
      ],
      sessionRelations: [
        {
          relationId: "relation-1",
          parentSessionId: "session-root",
          childSessionId: "session-child",
          relationType: "fork",
          createdAt: "2026-04-18T00:00:07Z"
        }
      ]
    };
    const runtimeService = {
      getSnapshot: () => snapshot,
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;

    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const alpha = await service.list({ workspaceId: "workspace-1" });
    const beta = await service.list({ workspaceId: "workspace-2" });

    expect(alpha.items.map((item) => item.sessionId)).toEqual(["session-root"]);
    expect(alpha.items[0]).toMatchObject({
      sessionId: "session-root",
      title: "Runtime Root",
      memberSessionIds: ["session-root", "session-child"],
      statusDot: "running",
      isPinned: true,
      isActive: true,
      lastCompletedTurnAt: "2026-04-18T00:00:13Z"
    });
    expect(alpha.items[0]?.parentSessionId).toBeUndefined();
    expect((await service.get("session-child"))?.sessionId).toBe("session-root");
    expect(JSON.stringify(alpha)).not.toContain("summary from index");
    expect(beta.items[0]).toMatchObject({ sessionId: "session-beta", statusDot: "none" });
    expect(await service.get("session-archived")).toBeUndefined();

    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-reviewer",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Reviewer",
        createdAt: "2026-04-18T00:00:20Z",
        updatedAt: "2026-04-18T00:00:21Z"
      },
      providerSessionId: "thread-reviewer"
    });
    await indexStore.upsertRelation({
      workspaceId: "workspace-1",
      parentSessionId: "session-child",
      childSessionId: "session-reviewer",
      relationType: "subagent",
      createdAt: "2026-04-18T00:00:20Z"
    });
    const nested = await service.list({ workspaceId: "workspace-1" });
    expect(nested.items.map((item) => item.sessionId)).toEqual(["session-root"]);
    expect(nested.items[0]?.subagents.map((item) => item.sessionId)).toEqual(["session-reviewer"]);
    expect((await service.get("session-reviewer"))?.parentSessionId).toBe("session-root");
  });

  it("marks unread sessions as read through the backing index store", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      unreadState: "unread_completed"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-1",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex",
            status: "idle",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ]
      }),
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    await service.markSessionRead("session-1");

    expect(indexStore.getEntry("session-1")?.unreadState).toBe("read");
  });

  it("acknowledges every visible fork member without changing node reads or a subagent tree", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({ workspaceId: "workspace-1", absolutePath: "I:/workspace-alpha" });
    const sessions = ["root", "branch", "subagent"].map((sessionId) => ({
      sessionId, conversationId: `conversation-${sessionId}`, engineId: "codex",
      status: "idle" as const, createdAt: "2026-04-18T00:00:01Z", updatedAt: "2026-04-18T00:00:04Z"
    }));
    for (const session of sessions) {
      await indexStore.upsertSession({ workspaceId: "workspace-1", session, unreadState: "unread_completed" });
    }
    await indexStore.upsertRelation({ workspaceId: "workspace-1", parentSessionId: "root",
      childSessionId: "branch", relationType: "fork" });
    await indexStore.upsertRelation({ workspaceId: "workspace-1", parentSessionId: "root",
      childSessionId: "subagent", relationType: "subagent" });
    const runtimeService = {
      getSnapshot: () => ({ ...emptySnapshot(), sessions, turns: [
        { turnId: "root-turn", sessionId: "root", status: "completed", startedAt: "2026-04-18T00:00:01Z", completedAt: "2026-04-18T00:00:02Z" },
        { turnId: "branch-turn", sessionId: "branch", status: "completed", startedAt: "2026-04-18T00:00:02Z", completedAt: "2026-04-18T00:00:03Z" },
        { turnId: "subagent-turn", sessionId: "subagent", status: "completed", startedAt: "2026-04-18T00:00:03Z", completedAt: "2026-04-18T00:00:04Z" }
      ] }),
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;
    const service = new SessionCatalogService({ runtimeService, workspaceRegistry, sessionIndexStore: indexStore });

    await service.markSessionRead("branch");

    expect(indexStore.getEntry("root")).toMatchObject({ unreadState: "read",
      acknowledgedCompletionNotice: { turnId: "root-turn" } });
    expect(indexStore.getEntry("branch")).toMatchObject({ unreadState: "read",
      acknowledgedCompletionNotice: { turnId: "branch-turn" } });
    expect(indexStore.getEntry("subagent")?.unreadState).toBe("unread_completed");
    expect(indexStore.getEntry("root")?.readTurnIds).toBeUndefined();
    expect(indexStore.getEntry("branch")?.readTurnIds).toBeUndefined();
  });

  it("orders sessions by their last completed turn, ignoring live activity", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-old",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-old",
            sessionIds: ["session-old"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:30:00Z"
          },
          {
            conversationId: "conversation-new",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-new",
            sessionIds: ["session-new"],
            createdAt: "2026-04-18T00:10:00Z",
            updatedAt: "2026-04-18T00:10:01Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-old",
            conversationId: "conversation-old",
            engineId: "codex",
            status: "running",
            title: "Old running session",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:30:00Z"
          },
          {
            sessionId: "session-new",
            conversationId: "conversation-new",
            engineId: "codex",
            status: "idle",
            title: "New completed session",
            createdAt: "2026-04-18T00:10:00Z",
            updatedAt: "2026-04-18T00:10:01Z"
          }
        ],
        turns: [
          {
            turnId: "turn-old-completed",
            sessionId: "session-old",
            status: "completed",
            startedAt: "2026-04-18T00:04:00Z",
            completedAt: "2026-04-18T00:05:00Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-old-running",
            sessionId: "session-old",
            status: "streaming",
            startedAt: "2026-04-18T00:20:00Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-new-completed",
            sessionId: "session-new",
            status: "completed",
            startedAt: "2026-04-18T00:14:00Z",
            completedAt: "2026-04-18T00:15:00Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ]
      }),
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const page = await service.list({ workspaceId: "workspace-1" });

    expect(page.items.map((item) => item.sessionId)).toEqual([
      "session-new",
      "session-old"
    ]);
    expect(page.items[0]?.lastCompletedTurnAt).toBe("2026-04-18T00:15:00Z");
    expect(page.items[1]?.lastCompletedTurnAt).toBe("2026-04-18T00:05:00Z");
  });

  it("uses the latest user message for activity and ordering before turn completion", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-old",
        conversationId: "conversation-old",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:30:00Z"
      },
      lastCompletedTurnAt: "2026-04-18T00:05:00Z"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-new",
        conversationId: "conversation-new",
        engineId: "codex",
        createdAt: "2026-04-18T00:10:00Z",
        updatedAt: "2026-04-18T00:15:00Z"
      },
      lastCompletedTurnAt: "2026-04-18T00:15:00Z"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-old",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-old",
            sessionIds: ["session-old"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:30:00Z"
          },
          {
            conversationId: "conversation-new",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-new",
            sessionIds: ["session-new"],
            createdAt: "2026-04-18T00:10:00Z",
            updatedAt: "2026-04-18T00:15:00Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-old",
            conversationId: "conversation-old",
            engineId: "codex",
            status: "running",
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:30:00Z"
          },
          {
            sessionId: "session-new",
            conversationId: "conversation-new",
            engineId: "codex",
            status: "idle",
            createdAt: "2026-04-18T00:10:00Z",
            updatedAt: "2026-04-18T00:15:00Z"
          }
        ],
        messageBlocks: [
          {
            blockId: "user-message:md",
            messageId: "user-message",
            sessionId: "session-old",
            turnId: "turn-running",
            role: "user",
            kind: "markdown",
            text: "still running",
            startedAt: "2026-04-18T00:20:00Z",
            completedAt: "2026-04-18T00:20:00Z"
          },
          {
            blockId: "assistant-message:md",
            messageId: "assistant-message",
            sessionId: "session-old",
            turnId: "turn-running",
            role: "assistant",
            kind: "markdown",
            text: "still working",
            startedAt: "2026-04-18T00:30:00Z",
            completedAt: "2026-04-18T00:30:00Z"
          }
        ]
      }),
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const page = await service.list({ workspaceId: "workspace-1" });

    expect(page.items.map((item) => item.sessionId)).toEqual([
      "session-old",
      "session-new"
    ]);
    expect(page.items[0]).toMatchObject({
      activityAt: "2026-04-18T00:20:00Z",
      lastCompletedTurnAt: "2026-04-18T00:05:00Z"
    });
  });

  it("falls back to created time when completed turn time is unknown", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-recently-updated",
        conversationId: "conversation-recent",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:30:00Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-recent"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-newer-created",
        conversationId: "conversation-created",
        engineId: "codex",
        createdAt: "2026-04-18T00:20:00Z",
        updatedAt: "2026-04-18T00:21:00Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-created"
    });

    const runtimeService = {
      getSnapshot: () => emptySnapshot(),
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const page = await service.list({ workspaceId: "workspace-1" });

    expect(page.items.map((item) => item.sessionId)).toEqual([
      "session-newer-created",
      "session-recently-updated"
    ]);
  });

  it("keeps a session with a completed turn ahead of one with only live activity", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-running",
        conversationId: "conversation-running",
        engineId: "codex",
        createdAt: "2026-08-04T18:37:26.000Z",
        updatedAt: "2026-08-15T11:20:21.561Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-running",
      lastCompletedTurnAt: "2026-08-04T18:49:11.852Z"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-yesterday",
        conversationId: "conversation-yesterday",
        engineId: "codex",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-yesterday",
      lastCompletedTurnAt: "2026-08-14T12:00:00.000Z"
    });
    const service = new SessionCatalogService({
      runtimeService: {
        getSnapshot: () => emptySnapshot(),
        getSessionBrowserRevision: () => 0
      } as unknown as SessionRuntimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const page = await service.list({
      workspaceId: "workspace-1",
      limit: 10
    });

    expect(page.items.map((item) => item.sessionId)).toEqual([
      "session-yesterday",
      "session-running"
    ]);
    expect(page.items[0]).toMatchObject({
      activityAt: "2026-08-14T12:00:00.000Z",
      lastCompletedTurnAt: "2026-08-14T12:00:00.000Z"
    });
  });

  it("does not hide a new unread dot merely because the tree remains active", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await workspaceRegistry.setLastActiveSelection({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      unreadState: "unread_completed"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-1",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex",
            status: "idle",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ]
      }),
      getSessionBrowserRevision: () => 1
    } as unknown as SessionRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const page = await service.list({ workspaceId: "workspace-1" });

    expect(page.items[0]).toMatchObject({
      sessionId: "session-1",
      isActive: true,
      statusDot: "unread_completed"
    });
  });

  it("returns every row of the workspace without summary text and caches until sources change", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    for (let index = 0; index < 25; index += 1) {
      await indexStore.upsertSession({
        workspaceId: "workspace-1",
        session: {
          sessionId: `session-${index.toString().padStart(2, "0")}`,
          conversationId: `conversation-${index}`,
          engineId: "codex",
          title: `Session ${index}`,
          createdAt: `2026-07-19T00:${index.toString().padStart(2, "0")}:00Z`,
          updatedAt: `2026-07-19T00:${index.toString().padStart(2, "0")}:00Z`
        },
        providerSessionId: `thread-${index}`,
        summaryText: "x".repeat(10_000)
      });
    }
    const getSnapshot = vi.fn(() => emptySnapshot());
    let runtimeRevision = "runtime-1";
    let runtimeBrowserRevision = 1;
    const service = new SessionCatalogService({
      runtimeService: {
        getSnapshot,
        getRevision: () => runtimeRevision,
        getSessionBrowserRevision: () => runtimeBrowserRevision
      } as unknown as SessionRuntimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const snapshot = await service.list({ workspaceId: "workspace-1" });
    expect(snapshot.items).toHaveLength(25);
    expect(JSON.stringify(snapshot)).not.toContain("summaryText");
    expect((await service.get("session-24"))?.title).toBe("Session 24");
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    runtimeRevision = "runtime-2";
    await service.list({ workspaceId: "workspace-1" });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    runtimeBrowserRevision += 1;
    await service.list({ workspaceId: "workspace-1" });
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    await indexStore.markSessionUnreadCompleted("session-00");
    await service.list({ workspaceId: "workspace-1" });
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("renames a loaded session through session state", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    let snapshot: DomainSnapshot = {
      ...emptySnapshot(),
      conversations: [
        {
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          participantEngineIds: ["codex"],
          activeSessionId: "session-1",
          sessionIds: ["session-1"],
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:00Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          title: "Runtime title",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:02Z"
        }
      ]
    };
    const renameSession = vi.fn(async (sessionId: string, title: string) => {
      snapshot = {
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.sessionId === sessionId ? { ...session, title } : session
        )
      };
    });
    const service = new SessionCatalogService({
      runtimeService: {
        getSnapshot: () => snapshot,
        getSessionBrowserRevision: () => 1,
        setSessionTitle: renameSession
      } as unknown as SessionRuntimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    await expect(
      service.renameSession({ sessionId: "session-1", title: "  Renamed root  " })
    ).resolves.toEqual({ sessionId: "session-1", title: "Renamed root" });

    expect(renameSession).toHaveBeenCalledWith("session-1", "Renamed root");
    expect((await service.get("session-1"))?.title).toBe("Renamed root");
  });

  it("renames a session this runtime has not loaded through its index entry", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-cold",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Cold session",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerSessionId: "thread-cold"
    });
    const setSessionTitle = vi.fn();
    const service = new SessionCatalogService({
      runtimeService: {
        getSnapshot: () => emptySnapshot(),
        getSessionBrowserRevision: () => 1,
        setSessionTitle
      } as unknown as SessionRuntimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    await expect(
      service.renameSession({ sessionId: "session-cold", title: "Renamed cold" })
    ).resolves.toEqual({ sessionId: "session-cold", title: "Renamed cold" });

    expect(setSessionTitle).not.toHaveBeenCalled();
    expect(indexStore.getEntry("session-cold")?.title).toBe("Renamed cold");
    expect((await service.get("session-cold"))?.title).toBe("Renamed cold");
    expect((await service.list({ workspaceId: "workspace-1" })).items[0]?.title).toBe("Renamed cold");
  });

  it("refuses a blank title and an unknown session", async () => {
    const baseDir = await createTempDir();
    const service = new SessionCatalogService({
      runtimeService: { getSnapshot: () => emptySnapshot() } as unknown as SessionRuntimeService,
      workspaceRegistry: new WorkspaceRegistryService({ baseDir }),
      sessionIndexStore: new SessionIndexStore({ baseDir })
    });

    await expect(service.renameSession({ sessionId: "session-1", title: "   " })).rejects.toThrow(
      "Session title must not be blank."
    );
    await expect(service.renameSession({ sessionId: "session-1", title: "Renamed" })).rejects.toThrow(
      "Unknown session: session-1"
    );
  });

  it("keeps revisions addressable so callers can read only the rows that changed", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({ baseDir });
    const indexStore = new SessionIndexStore({ baseDir });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Before",
        createdAt: "2026-07-19T00:00:00Z",
        updatedAt: "2026-07-19T00:00:00Z"
      },
      providerSessionId: "thread-1"
    });
    const service = new SessionCatalogService({
      runtimeService: {
        getSnapshot: () => emptySnapshot(),
        getRevision: () => "runtime-1",
        getSessionBrowserRevision: () => 1
      } as unknown as SessionRuntimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const first = await service.list({ workspaceId: "workspace-1" });
    expect(await service.changes({ workspaceId: "workspace-1", revision: first.revision })).toEqual({
      status: "changed",
      workspaceId: "workspace-1",
      revision: first.revision,
      items: [],
      removedSessionIds: []
    });

    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "After",
        createdAt: "2026-07-19T00:00:00Z",
        updatedAt: "2026-07-19T00:05:00Z"
      },
      providerSessionId: "thread-1"
    });
    const renamed = await service.changes({ workspaceId: "workspace-1", revision: first.revision });
    if (renamed.status !== "changed") {
      throw new Error(`expected changed rows, received ${renamed.status}`);
    }
    expect(renamed.revision).not.toBe(first.revision);
    expect(renamed.items.map((item) => item.title)).toEqual(["After"]);
    expect(renamed.removedSessionIds).toEqual([]);

    await indexStore.archiveSession("session-1", "2026-07-19T00:10:00Z");
    const archived = await service.changes({ workspaceId: "workspace-1", revision: renamed.revision });
    expect(archived).toMatchObject({
      status: "changed",
      removedSessionIds: ["session-1"]
    });

    expect(await service.changes({ workspaceId: "workspace-1", revision: "unknown-revision" })).toEqual({
      status: "full-required",
      workspaceId: "workspace-1"
    });
  });

});
