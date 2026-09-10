import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const fixtureWorkspaceId = "workspace-fixture-session-tree";
const fixtureParentSessionId = "session-fixture-parent";
const fixtureChildSessionId = "session-fixture-child";
const fixturePlainSessionId = "session-fixture-plain";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
};

const readJsonIfPresent = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Unable to read isolated fixture data: ${path}`, { cause: error });
  }
};

const assertFixtureDataDir = async (dataDir: string): Promise<void> => {
  const registry = await readJsonIfPresent(join(dataDir, "workspace-registry.json"));
  const existingWorkspaces = Array.isArray(registry?.workspaces) ? registry.workspaces : [];
  if (existingWorkspaces.some((item) =>
    item && typeof item === "object" && (item as { workspaceId?: unknown }).workspaceId !== fixtureWorkspaceId
  )) {
    throw new Error("session-tree fixture requires a dataDir without unrelated workspaces");
  }

  const index = await readJsonIfPresent(join(dataDir, "session-index.json"));
  const allowedSessionIds = new Set([
    fixtureParentSessionId,
    fixtureChildSessionId,
    fixturePlainSessionId
  ]);
  const existingEntries = Array.isArray(index?.entries) ? index.entries : [];
  if (existingEntries.some((item) =>
    item && typeof item === "object" && !allowedSessionIds.has(String((item as { sessionId?: unknown }).sessionId))
  )) {
    throw new Error("session-tree fixture requires a dataDir without unrelated sessions");
  }
};

const sessionEntry = (input: {
  workspaceId: string;
  sessionId: string;
  conversationId: string;
  providerSessionId: string;
  title: string;
  summaryText: string;
  createdAt: string;
  cwd: string;
}) => ({
  workspaceId: input.workspaceId,
  sessionId: input.sessionId,
  conversationId: input.conversationId,
  engineId: "codex",
  providerKind: "codex-thread",
  providerSessionId: input.providerSessionId,
  title: input.title,
  summaryText: input.summaryText,
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
  lastCompletedTurnAt: input.createdAt,
  lastTurnId: `turn-${input.providerSessionId}`,
  unreadState: "read",
  source: "registry",
  metadata: { cwd: input.cwd }
});

export type SessionTreeFixture = {
  dataDir: string;
  projectPath: string;
  workspaceId: string;
  env: Record<string, string>;
};

export const prepareSessionTreeFixture = async (
  dataDirInput: string,
  packageRoot: string
): Promise<SessionTreeFixture> => {
  const dataDir = resolve(dataDirInput);
  await assertFixtureDataDir(dataDir);
  const projectPath = join(dataDir, "fixtures", "session-tree", "project");
  await mkdir(projectPath, { recursive: true });
  const createdAt = new Date().toISOString();
  const conversationId = "conversation-fixture-session-tree";

  await writeJson(join(dataDir, "workspace-registry.json"), {
    version: 1,
    workspaces: [{
      workspaceId: fixtureWorkspaceId,
      absolutePath: projectPath,
      label: "Session Tree Fixture",
      createdAt,
      updatedAt: createdAt
    }],
    pinnedSessionIds: [],
    engineProgramPathsByEngineId: {},
    allowedModelIdsByEngineId: {},
    customModelReasoningOptionIdsByEngineId: {},
    executionPreferencesByEngineId: {},
    lastActiveWorkspaceId: fixtureWorkspaceId,
    lastActiveSessionId: fixtureParentSessionId
  });

  await writeJson(join(dataDir, "session-index.json"), {
    version: 1,
    entries: [
      sessionEntry({
        workspaceId: fixtureWorkspaceId,
        sessionId: fixtureParentSessionId,
        conversationId,
        providerSessionId: "fixture-parent",
        title: "Fixture parent session",
        summaryText: "Fixture parent question",
        createdAt,
        cwd: projectPath
      }),
      sessionEntry({
        workspaceId: fixtureWorkspaceId,
        sessionId: fixtureChildSessionId,
        conversationId,
        providerSessionId: "fixture-child",
        title: "Fixture child session",
        summaryText: "Fixture child question",
        createdAt,
        cwd: projectPath
      }),
      sessionEntry({
        workspaceId: fixtureWorkspaceId,
        sessionId: fixturePlainSessionId,
        conversationId: "conversation-fixture-plain",
        providerSessionId: "fixture-plain",
        title: "Fixture plain session",
        summaryText: "Fixture plain question",
        createdAt,
        cwd: projectPath
      })
    ],
    relations: [{
      workspaceId: fixtureWorkspaceId,
      parentSessionId: fixtureParentSessionId,
      childSessionId: fixtureChildSessionId,
      relationType: "subagent",
      createdAt
    }],
    treeViews: {}
  });

  return {
    dataDir,
    projectPath,
    workspaceId: fixtureWorkspaceId,
    env: {
      VERMILLION_CODEX_BIN: resolve(packageRoot, "scripts", "session-tree-fixture-codex.cmd"),
      VERMILLION_SESSION_TREE_FIXTURE_PROJECT: projectPath
    }
  };
};
