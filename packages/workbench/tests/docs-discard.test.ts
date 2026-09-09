import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import type { WorkbenchRpcMethod, WorkbenchRpcParams, WorkbenchRpcResult } from "../src/client.js";

const exec = promisify(execFile);
const dirs: string[] = [];
const git = async (root: string, ...args: string[]) => (await exec("git", ["--no-optional-locks", ...args], { cwd: root })).stdout;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "verm-discard-base-"));
  const root = await mkdtemp(join(tmpdir(), "verm-discard-ws-"));
  dirs.push(base, root);
  vi.stubEnv("VERMILLION_PERSISTENCE_BASE_DIR", base);
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  const cli = async <M extends WorkbenchRpcMethod>(method: M, params: WorkbenchRpcParams<M>): Promise<WorkbenchRpcResult<M>> => {
    expect(await runCli([method, JSON.stringify(params)])).toBe(0);
    return JSON.parse(output.pop()!);
  };
  const { workspaceId } = await cli("workspace.add", { rootPath: root });
  await git(root, "config", "core.autocrlf", "false");
  const write = (path: string, content: string) => cli("docs.write", { workspaceId, path, content });
  const preview = (paths: string[]) => cli("docs.discardPreview", { workspaceId, paths });
  const discard = (paths: string[]) => cli("docs.discard", { workspaceId, paths });
  const commit = () => cli("docs.commit", { workspaceId, message: "Baseline" });
  return { root, write, preview, discard, commit, workspaceId };
}

describe("docs discard CLI/RPC with real Git", () => {
  it("restores staged/unstaged edits and deletions, removes new files, preserves unrelated staged entries", async () => {
    const { root, write, preview, discard, commit } = await setup();
    const folder = ".vermillion/docs/selected";
    const edit = folder + "/edit.md", deleted = folder + "/deleted.md", unstagedDeleted = folder + "/unstaged-deleted.md";
    const other = ".vermillion/docs/selected-other/keep.md";
    for (const path of [edit, deleted, unstagedDeleted, other]) await write(path, "baseline\n");
    await commit();
    await write(edit, "staged\n");
    await git(root, "add", "--", edit);
    await write(edit, "unstaged\n");
    await git(root, "rm", "--", deleted);
    await rm(join(root, unstagedDeleted));
    await write(folder + "/new.md", "new\n");
    await write(folder + "/staged.md", "new staged\n");
    await git(root, "add", "--", folder + "/staged.md");
    await write(other, "keep staged\n");
    await writeFile(join(root, "outside.txt"), "outside staged\n");
    await git(root, "add", "--", other, "outside.txt");
    await write(other, "keep unstaged\n");
    const unrelated = await git(root, "ls-files", "--stage", "--", other, "outside.txt");
    const beforeIndex = await readFile(join(root, ".git/index"));
    const selected = await preview([folder]);
    expect(selected).toHaveLength(5);
    expect(await readFile(join(root, ".git/index"))).toEqual(beforeIndex);
    // A new file created after confirmation must survive.
    await write(folder + "/later.md", "later\n");
    expect(await discard(selected.map(({ path }) => path))).toEqual(selected);
    for (const path of [edit, deleted, unstagedDeleted]) expect(await readFile(join(root, path), "utf8")).toBe("baseline\n");
    for (const name of ["new.md", "staged.md"]) await expect(readFile(join(root, folder, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, "ls-files", "--stage", "--", other, "outside.txt")).toBe(unrelated);
    expect(await readFile(join(root, other), "utf8")).toBe("keep unstaged\n");
    expect(await preview([folder])).toEqual([{ path: folder + "/later.md", status: "added" }]);
  });

  it("represents staged renames as deletion/addition and restores both sides", async () => {
    const { root, write, preview, discard, commit } = await setup();
    const old = ".vermillion/docs/old.md", next = ".vermillion/docs/new.md";
    await write(old, "rename content\n");
    await commit();
    await rename(join(root, old), join(root, next));
    await git(root, "add", "-A");
    const selected = await preview([".vermillion/docs"]);
    expect(selected).toEqual([{ path: next, status: "added" }, { path: old, status: "deleted" }]);
    await discard(selected.map(({ path }) => path));
    expect(await readFile(join(root, old), "utf8")).toBe("rename content\n");
    expect(await preview([".vermillion/docs"])).toEqual([]);
    await expect(readFile(join(root, next))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes selected staged and untracked additions with unborn HEAD", async () => {
    const { root, write, preview, discard } = await setup();
    const first = ".vermillion/docs/first.md", second = ".vermillion/docs/second.md";
    await write(first, "staged\n");
    await git(root, "add", "--", first);
    await write(second, "untracked\n");
    await writeFile(join(root, "outside.txt"), "keep\n");
    await git(root, "add", "--", "outside.txt");
    const outsideIndex = await git(root, "ls-files", "--stage", "--", "outside.txt");
    await discard((await preview([".vermillion/docs"])).map(({ path }) => path));
    expect(await preview([".vermillion/docs"])).toEqual([]);
    expect(await git(root, "ls-files", "--stage", "--", "outside.txt")).toBe(outsideIndex);
    for (const path of [first, second]) await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses literal filenames and rejects paths outside docs without mutations", async () => {
    const { root, write, preview, discard, commit, workspaceId } = await setup();
    const path = ".vermillion/docs/[a].md", other = ".vermillion/docs/a.md";
    await write(path, "baseline\n");
    await write(other, "other\n");
    await commit();
    await write(path, "changed\n");
    await write(other, "keep\n");
    await git(root, "add", "-A");
    expect(await preview([path])).toEqual([{ path, status: "modified" }]);
    await discard([path]);
    expect(await readFile(join(root, path), "utf8")).toBe("baseline\n");
    expect(await readFile(join(root, other), "utf8")).toBe("keep\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const index = await readFile(join(root, ".git/index"));
    for (const invalid of ["outside.txt", ".vermillion/docs/../../outside.txt", ":(top)*"]) {
      expect(await runCli(["docs.discard", JSON.stringify({ workspaceId, paths: [other, invalid] })])).toBe(1);
    }
    expect(await readFile(join(root, ".git/index"))).toEqual(index);
    expect(await readFile(join(root, other), "utf8")).toBe("keep\n");
  });

  it("refuses to recursively delete a directory replacing a confirmed tracked file", async () => {
    const { root, write, preview, commit, workspaceId } = await setup();
    const path = ".vermillion/docs/replaced.md";
    await write(path, "baseline\n");
    await commit();
    await rm(join(root, path));
    const selected = await preview([path]);
    await mkdir(join(root, path));
    await writeFile(join(root, path, "keep.txt"), "keep\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runCli(["docs.discard", JSON.stringify({ workspaceId, paths: selected.map(({ path }) => path) })])).toBe(1);
    expect(await readFile(join(root, path, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
