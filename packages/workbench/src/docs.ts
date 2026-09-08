import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DocChange, DocFile } from "./contracts.js";

const execFileAsync = promisify(execFile);

export class WorktreeMergeConflict extends Error {
  constructor(readonly files: string[]) {
    super("merge conflict: " + files.join(", "));
  }
}

export class WorktreeNotReady extends Error {}

export class WorkspaceNotReady extends Error {}

export const STATE_DIR = ".vermillion";
export const DOCS_DIR = STATE_DIR + "/docs";

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const exists = async (path: string): Promise<boolean> => {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const toPosix = (value: string): string => value.split(sep).join("/");

/** Documents are UTF-8 text; whitespace controls are allowed, binary controls are not. */
const isTextContent = (bytes: Buffer): boolean =>
  isUtf8(bytes) && !bytes.some((byte) => byte < 9 || (byte > 13 && byte < 32) || byte === 127);

const samePath = (a: string, b: string): boolean =>
  toPosix(resolve(a)).toLowerCase() === toPosix(resolve(b)).toLowerCase();

const assertDocPathOrRoot = (path: string): void => {
  if (toPosix(path) === DOCS_DIR) return;
  assertDocPath(path);
};

const assertDocPath = (path: string): void => {
  const normalized = toPosix(path);
  if (!normalized.startsWith(DOCS_DIR + "/") || normalized.includes("..")) {
    throw new Error("Doc path must live under " + DOCS_DIR + "/: " + path);
  }
};

/** Git-backed document store rooted at <workspace>/.vermillion/docs. */
export class DocsService {
  private gitDir?: string;
  constructor(private readonly rootPath: string) {}

  async ensureRepo(): Promise<void> {
    let topLevel = "";
    try {
      topLevel = (await git(this.rootPath, ["rev-parse", "--show-toplevel"])).trim();
    } catch {}
    if (!topLevel || !samePath(topLevel, this.rootPath)) {
      await git(this.rootPath, ["init", "-q"]);
    }
    await mkdir(join(this.rootPath, DOCS_DIR), { recursive: true });
    await this.excludeStateFromGit();
    this.gitDir = resolve(this.rootPath, (await git(this.rootPath, ["rev-parse", "--git-common-dir"])).trim());
  }

  /** Only docs/ is versioned; work files under .vermillion stay out of git via the repo-local exclude file. */
  private async excludeStateFromGit(): Promise<void> {
    const gitDir = (await git(this.rootPath, ["rev-parse", "--git-common-dir"])).trim();
    const excludePath = resolve(this.rootPath, gitDir, "info", "exclude");
    const marker = "# vermillion";
    let current = "";
    try {
      current = await readFile(excludePath, "utf8");
    } catch {}
    if (current.includes(marker)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, current + (current.endsWith("\n") || !current ? "" : "\n") + [marker, STATE_DIR + "/*", "!" + STATE_DIR + "/docs/", ""].join("\n"), "utf8");
  }

  async list(): Promise<DocFile[]> {
    const root = join(this.rootPath, DOCS_DIR);
    const out: DocFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const info = await stat(full);
          const isText = isTextContent(await readFile(full));
          out.push({ path: toPosix(relative(this.rootPath, full)), size: info.size, modifiedAt: info.mtime.toISOString(), isText });
        }
      }
    };
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string, commit?: string): Promise<string> {
    assertDocPath(path);
    let bytes: Buffer;
    if (commit !== undefined) {
      const revision = (await git(this.rootPath, ["rev-parse", "--verify", "--end-of-options", commit + "^{commit}"])).trim();
      const { stdout } = await execFileAsync("git", ["show", revision + ":" + toPosix(path)], {
        cwd: this.rootPath, encoding: "buffer", maxBuffer: 16 * 1024 * 1024
      });
      bytes = stdout;
    } else {
      bytes = await readFile(join(this.rootPath, path));
    }
    if (!isTextContent(bytes)) throw new Error("文档不是 UTF-8 文本文件，无法打开：" + path);
    return bytes.toString("utf8");
  }

  async write(path: string, content: string): Promise<void> {
    assertDocPath(path);
    const full = join(this.rootPath, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  /** Read-only: does not touch the index. Untracked files count as added. */
  async pendingChanges(): Promise<DocChange[]> {
    const status = await git(this.rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", DOCS_DIR]);
    const changes: DocChange[] = [];
    const entries = status.split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code[0] === "R" || code[0] === "C") i += 1;
      const kind: DocChange["status"] = code.includes("D") ? "deleted" : code === "??" || code.includes("A") ? "added" : "modified";
      changes.push({ path, status: kind });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Current file against HEAD, including staged edits and untracked additions; never writes the index. */
  async diff(path: string): Promise<string> {
    assertDocPath(path);
    const head = await this.head();
    if (head) {
      const diff = await git(this.rootPath, ["-c", "diff.autoRefreshIndex=false", "--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", head, "--", path]);
      if (diff) return diff;
      const untracked = await git(this.rootPath, ["--literal-pathspecs", "ls-files", "--others", "-z", "--", path]);
      if (!untracked.split("\0").includes(toPosix(path))) return "";
    }
    try {
      return await git(this.rootPath, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", path]);
    } catch (error) {
      // --no-index exits 1 when it successfully produces a difference.
      const result = error as { code?: number; stdout?: string };
      if (result.code === 1 && typeof result.stdout === "string") return result.stdout;
      throw error;
    }
  }

  /** Commits the given doc paths (all pending when omitted). Returns the commit sha. */
  async commit(message: string, paths?: string[]): Promise<string> {
    if (paths?.length === 0) throw new Error("Select at least one doc path to commit.");
    const targets = paths ?? [DOCS_DIR];
    for (const path of targets) assertDocPathOrRoot(path);
    await git(this.rootPath, ["add", "-A", "--", ...targets]);
    await git(this.rootPath, ["-c", "user.name=Vermillion", "-c", "user.email=vermillion@local", "commit", "-q", "-m", message, "--", ...targets]);
    return (await git(this.rootPath, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * Read-only preflight; the caller serializes integration.
   * Uncommitted changes in the main workspace do not block by themselves: Git refuses to merge or
   * revert over files they touch, and that refusal remains a recorded integration failure.
   */
  async checkIntegrationReady(): Promise<void> {
    const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];
    for (const marker of markers) {
      const path = (await git(this.rootPath, ["rev-parse", "--git-path", marker])).trim();
      if (await exists(resolve(this.rootPath, path))) throw new WorkspaceNotReady("Git operation in progress: " + marker);
    }
    const checkLocks = async (directory: string, recursive = false): Promise<void> => {
      if (!await exists(directory)) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.name.endsWith(".lock")) throw new WorkspaceNotReady("Git lock exists: " + path);
        if (entry.isDirectory() && (recursive || entry.name === "refs")) await checkLocks(path, true);
      }
    };
    for (const flag of ["--git-dir", "--git-common-dir"]) {
      await checkLocks(resolve(this.rootPath, (await git(this.rootPath, ["rev-parse", flag])).trim()));
    }
  }

  async integrationSnapshot(branch: string): Promise<{ head: string; target: string; diffStat: string }> {
    const head = await this.resolveCommit("HEAD");
    const target = await this.resolveCommit(branch);
    const diffStat = await git(this.rootPath, ["diff", "--stat", head + "..." + target]);
    return { head, target, diffStat };
  }

  async getMergeCommit(target: string, before: string): Promise<string | undefined> {
    if (await this.isAncestor(target, before)) return undefined;
    const history = await git(this.rootPath, ["rev-list", "--first-parent", "--reverse", "--parents", before + "..HEAD"]);
    return history.split("\n").map((line) => line.split(" ")).find((entry) => entry.slice(2).includes(target))?.[0];
  }

  private async resolveCommit(commit: string): Promise<string> {
    return (await git(this.rootPath, ["rev-parse", "--verify", "--end-of-options", commit + "^{commit}"])).trim();
  }

  private async isAncestor(commit: string, descendant: string): Promise<boolean> {
    try { await git(this.rootPath, ["merge-base", "--is-ancestor", commit, descendant]); return true; } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }

  /** Merge committed worker output; cleanup is a separate recoverable action. */
  async mergeWorktree(worktreePath: string, branch: string, message: string, targetCommit?: string): Promise<{ commit?: string; diffStat: string }> {
    const before = await this.resolveCommit("HEAD");
    const target = await this.resolveCommit(targetCommit ?? branch);
    if (await this.isAncestor(target, before)) return { diffStat: "" };
    await this.checkIntegrationReady();
    if (await git(worktreePath, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"])) {
      throw new WorktreeNotReady("Worker must commit its worktree before integration.");
    }
    try {
      await git(this.rootPath, ["-c", "user.name=Vermillion", "-c", "user.email=vermillion@local", "merge", "--no-ff", "-q", "-m", "Merge " + message, target]);
    } catch (error) {
      const files = (await git(this.rootPath, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      if (!files.length) throw error;
      await git(this.rootPath, ["merge", "--abort"]);
      throw new WorktreeMergeConflict(files);
    }
    const commit = await this.resolveCommit("HEAD");
    return { commit, diffStat: await git(this.rootPath, ["diff", "--stat", before, commit]) };
  }

  /** Find Git's standard merge-revert record on the mainline since the saved starting point. */
  async getRollbackCommit(commit: string, before: string): Promise<string | undefined> {
    const target = await this.resolveCommit(commit);
    const start = await this.resolveCommit(before);
    if (!await this.isAncestor(start, "HEAD")) throw new WorkspaceNotReady("Rollback starting point is no longer on HEAD history.");
    const log = await git(this.rootPath, ["log", "--first-parent", "--format=%H%x00%B%x00", start + "..HEAD"]);
    const entries = log.split("\0");
    for (let i = 0; i + 1 < entries.length; i += 2) {
      if (entries[i + 1]!.split("\n").some((line) => line === "This reverts commit " + target + ", reversing" || line === "This reverts commit " + target + ".")) return entries[i]!.trim();
    }
    return undefined;
  }

  async rollbackMerge(commit: string, before?: string): Promise<string> {
    const target = await this.resolveCommit(commit);
    const completed = await this.getRollbackCommit(target, before ?? target);
    if (completed) return completed;
    await this.checkIntegrationReady();
    const parents = (await git(this.rootPath, ["rev-list", "--parents", "-n", "1", target])).trim().split(/\s+/).length - 1;
    try {
      await git(this.rootPath, ["-c", "user.name=Vermillion", "-c", "user.email=vermillion@local", "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), target]);
    } catch (error) {
      const files = (await git(this.rootPath, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      if (files.length) {
        await git(this.rootPath, ["revert", "--abort"]);
        throw new WorkspaceNotReady("Rollback conflict: " + files.join(", "));
      }
      throw error;
    }
    return this.resolveCommit("HEAD");
  }

  async dropWorktree(worktreePath: string, branch: string, discard = false): Promise<void> {
    const registered = (await git(this.rootPath, ["worktree", "list", "--porcelain", "-z"]))
      .split("\0").some((field) => field.startsWith("worktree ") && samePath(field.slice(9), worktreePath));
    if (registered) await git(this.rootPath, ["worktree", "remove", ...(discard ? ["--force"] : []), worktreePath]);
    else if (await exists(worktreePath)) {
      if ((await readdir(worktreePath)).length) throw new Error("已注销的 worktree 目录仍有内容，保留以待检查：" + worktreePath);
      await rmdir(worktreePath);
    }
    const ref = "refs/heads/" + branch;
    const branches = await git(this.rootPath, ["for-each-ref", "--format=%(refname)", ref]);
    if (branches.split("\n").includes(ref)) await git(this.rootPath, ["branch", discard ? "-D" : "-d", "--", branch]);
  }

  async head(): Promise<string | undefined> {
    try {
      return (await git(this.rootPath, ["rev-parse", "HEAD"])).trim();
    } catch {
      return undefined;
    }
  }

  async rootResult(commit: string | undefined, base: string | undefined, allowedPaths: string[]): Promise<{ commit?: string; commits?: string[]; diffStat: string }> {
    if (!allowedPaths.length) {
      if (commit) throw new WorktreeNotReady("根目录代码成果需要在 scope.allowedPaths 登记归属路径。");
      return { diffStat: "" };
    }
    const paths = [...allowedPaths, ":(exclude).vermillion"];
    const dirty = await git(this.rootPath, ["diff", "--name-only", "HEAD", "--", ...paths]);
    const untracked = await git(this.rootPath, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
    if (dirty.trim() || untracked.trim()) throw new WorktreeNotReady("根目录范围内仍有未提交成果，请先提交再登记 evidence.commit。");
    if (!base) throw new WorktreeNotReady("根目录执行缺少起始提交，无法确认成果范围。");
    if (!commit) {
      if ((await git(this.rootPath, ["diff", "--name-only", base, "HEAD", "--", ...paths])).trim())
        throw new WorktreeNotReady("根目录代码成果需要在 evidence.commit 登记提交末端。");
      return { diffStat: "" };
    }
    const target = await this.resolveCommit(commit);
    await git(this.rootPath, ["merge-base", "--is-ancestor", target, "HEAD"]);
    await git(this.rootPath, ["merge-base", "--is-ancestor", base, target]);
    const candidates = (await git(this.rootPath, ["rev-list", "--reverse", base + ".." + target])).trim().split("\n").filter(Boolean);
    const commits: string[] = [];
    for (const candidate of candidates) {
      const args = ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-m", "-z", candidate];
      const own = (await git(this.rootPath, [...args, "--", ...paths])).split("\0").filter(Boolean);
      if (!own.length) continue;
      const all = (await git(this.rootPath, args)).split("\0").filter(Boolean);
      if (all.some((path) => !own.includes(path))) throw new WorktreeNotReady("提交混合本单与范围外改动，无法安全记录回滚：" + candidate);
      commits.push(candidate);
    }
    if (!commits.length) throw new WorktreeNotReady("提交范围中没有属于本单的代码成果。");
    const stats = await Promise.all(commits.map((sha) => git(this.rootPath, ["show", "--format=", "--stat", sha])));
    return { commit: commits.at(-1), commits, diffStat: stats.join("\n") };
  }

  async committedDiff(path: string, from: string, to: string): Promise<string> {
    assertDocPath(path);
    return git(this.rootPath, ["diff", from, to, "--", ":(literal)" + path]);
  }

  /**
   * Recursive watcher over .vermillion; reports which area changed ("docs", "roles", "work-requests", "workitems", "decisions")
   * so out-of-process writers (CLI, agents) surface as the same events as in-process writes. Debounced per area.
   */
  watch(onChange: (area: string) => void): Pick<FSWatcher, "close"> {
    const timers = new Map<string, NodeJS.Timeout>();
    const notify = (area: string) => {
      clearTimeout(timers.get(area));
      timers.set(area, setTimeout(() => onChange(area), 150));
    };
    const stateWatcher = watch(join(this.rootPath, STATE_DIR), { recursive: true }, (_event, filename) => {
      const area = String(filename ?? "").split(/[\\/]/)[0] ?? "";
      if (!area || area.endsWith(".tmp")) return;
      notify(area);
    });
    const gitWatcher = this.gitDir ? watch(this.gitDir, { recursive: true }, (_event, filename) => {
      const path = String(filename ?? "").replace(/\\/g, "/");
      if (path === "HEAD" || path === "packed-refs" || path.startsWith("refs/")) notify("git");
    }) : undefined;
    return { close: () => { stateWatcher.close(); gitWatcher?.close(); for (const timer of timers.values()) clearTimeout(timer); } };
  }
}
