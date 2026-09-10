import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSessionTreeFixture } from "../src/session-tree-fixture.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session-tree fixture preparation", () => {
  it("writes the isolated workspace and three browsable session records", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vermillion-session-tree-fixture-"));
    directories.push(dataDir);

    const result = await prepareSessionTreeFixture(dataDir, "I:/fixture-package");
    const registry = JSON.parse(await readFile(join(dataDir, "workspace-registry.json"), "utf8"));
    const index = JSON.parse(await readFile(join(dataDir, "session-index.json"), "utf8"));

    expect(result.workspaceId).toBe("workspace-fixture-session-tree");
    expect(result.projectPath).toContain("fixtures\\session-tree\\project");
    expect(result.env.VERMILLION_CODEX_BIN).toBe("I:\\fixture-package\\scripts\\session-tree-fixture-codex.cmd");
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0].absolutePath).toBe(result.projectPath);
    expect(index.entries.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([
      "session-fixture-parent",
      "session-fixture-child",
      "session-fixture-plain"
    ]);
    expect(index.relations).toEqual([expect.objectContaining({
      parentSessionId: "session-fixture-parent",
      childSessionId: "session-fixture-child",
      relationType: "subagent"
    })]);
  });

  it("does not overwrite unrelated workspace data", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vermillion-session-tree-fixture-"));
    directories.push(dataDir);
    await writeFile(join(dataDir, "workspace-registry.json"), JSON.stringify({
      version: 1,
      workspaces: [{ workspaceId: "workspace-user-data" }]
    }));

    await expect(prepareSessionTreeFixture(dataDir, "I:/fixture-package"))
      .rejects.toThrow("without unrelated workspaces");
  });
});

