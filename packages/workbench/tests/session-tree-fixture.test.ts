import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    expect(result.projectPath).toBe(join(dataDir, "fixtures", "session-tree", "project"));
    expect(result.env.VERMILLION_CODEX_BIN).toBe(resolve("I:/fixture-package", "scripts",
      "session-tree-fixture-codex" + (process.platform === "win32" ? ".cmd" : ".sh")));
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

  it("implements the config and skills handshake used when fixed history opens", async () => {
    const script = join(import.meta.dirname, "..", "scripts", "session-tree-fixture-codex.mjs");
    const child = spawn(process.execPath, [script, "app-server"], {
      env: { ...process.env, VERMILLION_SESSION_TREE_FIXTURE_PROJECT: "I:/fixture-project" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const responses: Array<{ id?: number; result?: unknown }> = [];
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
    });
    try {
      child.stdin.write(JSON.stringify({ id: 1, method: "config/read", params: { includeLayers: false, cwd: null } }) + "\n");
      child.stdin.write(JSON.stringify({ id: 2, method: "skills/list", params: {} }) + "\n");
      await expect.poll(() => responses).toEqual([
        { id: 1, result: { config: { developer_instructions: null } } },
        { id: 2, result: { data: [] } }
      ]);
    } finally {
      child.kill();
    }
  });
});
