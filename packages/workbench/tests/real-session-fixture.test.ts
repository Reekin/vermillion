import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRealSessionFixture } from "../src/real-session-fixture.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("real-session fixture preparation", () => {
  it("creates an isolated Git project and Codex home without copying mutable history", async () => {
    const source = await mkdtemp(join(tmpdir(), "verm-real-source-"));
    const dataDir = await mkdtemp(join(tmpdir(), "verm-real-fixture-"));
    directories.push(source, dataDir);
    const modelOverride = join(source, "models-override.json");
    await writeFile(modelOverride, "{\"override\":true}\n", "utf8");
    await writeFile(join(source, "config.toml"), [
      "model = \"fixture-model\"",
      "sqlite_home = \"C:/user/state\"",
      `model_catalog_json = '${modelOverride}'`,
      "[mcp_servers.node_repl.env]",
      "CODEX_HOME = 'C:/user/codex'",
      ""
    ].join("\r\n"), "utf8");
    await writeFile(join(source, "models_cache.json"), "{\"models\":[{\"id\":\"fixture-model\"}]}", "utf8");
    await writeFile(join(source, "auth.json"), "{\"auth\":\"fixture\"}", "utf8");
    await writeFile(join(source, "state_5.sqlite"), "user state", "utf8");

    const fixture = await prepareRealSessionFixture(dataDir, source);
    const config = await readFile(join(fixture.codexHome, "config.toml"), "utf8");
    const [, head] = await Promise.all([
      stat(join(fixture.projectPath, "README.md")),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.projectPath, encoding: "utf8" })
    ]);

    expect(fixture.env.CODEX_HOME).toBe(fixture.codexHome);
    expect(fixture.env.CODEX_SQLITE_HOME).toBe(join(dataDir, "codex-sqlite"));
    expect(config).toContain("fixture-model");
    expect(config).not.toMatch(/sqlite_home\s*=/i);
    expect(config).not.toContain("C:/user/state");
    expect(config).not.toContain(source.replace(/\\/g, "/"));
    expect(config).toContain("models-override.json");
    expect(config).toContain(fixture.codexHome.replace(/\\/g, "/"));
    expect(await readFile(join(fixture.codexHome, "auth.json"), "utf8")).toContain("fixture");
    await expect(stat(join(fixture.codexHome, "state_5.sqlite"))).rejects.toThrow();
    await expect(stat(join(dataDir, "workspace-registry.json"))).rejects.toThrow();
    expect(head.stdout.trim()).toHaveLength(40);
  });

  it("reuses completed data without regenerating the project or overwriting its files", async () => {
    const source = await mkdtemp(join(tmpdir(), "verm-real-source-"));
    const dataDir = await mkdtemp(join(tmpdir(), "verm-real-fixture-"));
    directories.push(source, dataDir);
    await writeFile(join(source, "config.toml"), "model = \"fixture-model\"\n", "utf8");
    await writeFile(join(source, "models_cache.json"), "{\"models\":[{\"id\":\"fixture-model\"}]}", "utf8");

    const first = await prepareRealSessionFixture(dataDir, source);
    await writeFile(join(first.projectPath, "kept.txt"), "keep this file\n", "utf8");
    const second = await prepareRealSessionFixture(dataDir, join(homedir(), ".missing-codex-source"));

    expect(second).toEqual(first);
    expect(await readFile(join(second.projectPath, "kept.txt"), "utf8")).toBe("keep this file\n");
  });

  it("reports missing model metadata before creating a partial fixture", async () => {
    const source = await mkdtemp(join(tmpdir(), "verm-real-source-"));
    const dataDir = await mkdtemp(join(tmpdir(), "verm-real-fixture-"));
    directories.push(source, dataDir);
    await writeFile(join(source, "config.toml"), "model = \"fixture-model\"\n", "utf8");

    await expect(prepareRealSessionFixture(dataDir, source)).rejects.toThrow("models_cache.json");
    await expect(stat(join(dataDir, "real-session-fixture.json"))).rejects.toThrow();
  });
});
