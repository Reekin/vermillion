import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import type { WorkbenchRpcMethod, WorkbenchRpcParams, WorkbenchRpcResult } from "../src/client.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
// Reference queries must not refresh the index being measured around the CLI call.
const git = async (root: string, ...args: string[]) => (await execFileAsync(
  "git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", ...args], { cwd: root }
)).stdout;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const setup = async () => {
  const base = await mkdtemp(join(tmpdir(), "verm-diff-cli-"));
  const root = await mkdtemp(join(tmpdir(), "verm-diff-ws-"));
  dirs.push(base, root);
  vi.stubEnv("VERMILLION_PERSISTENCE_BASE_DIR", base);
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  const cli = async <M extends WorkbenchRpcMethod>(method: M, params: WorkbenchRpcParams<M>): Promise<WorkbenchRpcResult<M>> => {
    expect(await runCli([method, JSON.stringify(params)])).toBe(0);
    return JSON.parse(output.pop()!);
  };
  const { workspaceId } = await cli("workspace.add", { rootPath: root, label: "Diff" });
  await git(root, "config", "core.autocrlf", "false");
  const write = (path: string, content: string) => cli("docs.write", { workspaceId, path, content });
  const diff = async (path: string) => (await cli("docs.diff", { workspaceId, path })).diff;
  const commit = () => cli("mission.create", { workspaceId, title: "Baseline", summary: "" });
  return { root, write, diff, commit };
};

describe("docs.diff CLI/RPC with real Git files", () => {
  it("compares one file with HEAD including staged and unstaged edits, without changing files or the index", async () => {
    const { root, write, diff, commit } = await setup();
    const path = ".vermillion/docs/target.md";
    const other = ".vermillion/docs/other.md";
    await write(path, "# Target\nold staged\ncontext\nold unstaged\n");
    await write(other, "unrelated baseline\n");
    await commit();
    await write(path, "# Target\nnew staged\ncontext\nold unstaged\n");
    await git(root, "add", "--", path);
    expect(await diff(path)).toContain("+new staged");
    await write(path, "# Target\nnew staged\ncontext\nnew unstaged\n");
    await write(other, "unrelated change\n");
    const beforeIndex = await readFile(join(root, ".git/index"));
    const beforeStatus = await git(root, "status", "--porcelain=v1", "-z");
    const beforeContent = await readFile(join(root, path));

    const actual = await diff(path);
    expect(actual).toBe(await git(root, "diff", "--no-ext-diff", "--no-color", "HEAD", "--", path));
    expect(actual).toContain("-old staged\n+new staged");
    expect(actual).toContain("-old unstaged\n+new unstaged");
    expect(actual).not.toContain("unrelated");
    expect(actual).not.toContain(other);
    expect(await readFile(join(root, ".git/index"))).toEqual(beforeIndex);
    expect(await readFile(join(root, path))).toEqual(beforeContent);
    expect(await git(root, "status", "--porcelain=v1", "-z")).toBe(beforeStatus);
  });

  it.each([false, true])("shows actual untracked additions when HEAD exists: %s", async (hasHead) => {
    const { root, write, diff, commit } = await setup();
    if (hasHead) {
      await write(".vermillion/docs/base.md", "baseline\n");
      await commit();
    }
    const path = ".vermillion/docs/new file.md";
    await write(path, "# New document\n真实新增内容");
    const before = await git(root, "status", "--porcelain=v1", "-z");
    const actual = await diff(path);
    expect(actual).toContain("+++ b/" + path);
    expect(actual).toContain("--- /dev/null");
    expect(actual).toContain("@@ -0,0 +1,2 @@");
    expect(actual).toContain("+# New document\n+真实新增内容\n");
    expect(actual).toContain("\\ No newline at end of file");
    expect(await git(root, "status", "--porcelain=v1", "-z")).toBe(before);
    expect(await git(root, "ls-files", "--", path)).toBe("");
  });

  it("shows deletions when a tracked file is emptied and returns no diff for unchanged content", async () => {
    const { root, write, diff, commit } = await setup();
    const path = ".vermillion/docs/empty.md";
    await write(path, "# Removed\nbody\n");
    await commit();
    expect(await diff(path)).toBe("");
    await write(path, "");
    const actual = await diff(path);
    expect(actual).toBe(await git(root, "diff", "--no-ext-diff", "--no-color", "HEAD", "--", path));
    expect(actual).toContain("@@ -1,2 +0,0 @@");
    expect(actual).toContain("-# Removed\n-body\n");
  });

  it("treats a Docs filename as a literal path instead of a pattern selecting other files", async () => {
    const { write, diff, commit } = await setup();
    const path = ".vermillion/docs/[draft].md";
    const other = ".vermillion/docs/d.md";
    await write(path, "target baseline\n");
    await write(other, "unrelated baseline\n");
    await commit();
    await write(path, "target change\n");
    await write(other, "unrelated change\n");
    const actual = await diff(path);
    expect(actual).toContain("+target change");
    expect(actual).not.toContain("unrelated");
    expect(actual).not.toContain(other);
  });
});
