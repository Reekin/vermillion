import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DocChange, DocFile, WorkItem } from "./contracts.js";
import { locateMarkdownSection, sectionDiff } from "./doc-ref.js";

const execFileAsync = promisify(execFile);

export class WorktreeMergeConflict extends Error {
  constructor(readonly files: string[]) {
    super("merge conflict: " + files.join(", "));
  }
}

/** A draft could not reach the main branch; the same files stay editable in the draft. */
export class DocDraftConflict extends Error {
  constructor(readonly files: string[]) {
    super("文档草稿与主分支冲突：" + files.join("、") +
      "。调用 docs.rebase 把本会话的草稿同步到主分支，解决冲突标记后用 docs.write 保存并再次 docs.commit。");
  }
}

export class WorktreeNotReady extends Error {}

export class WorkspaceNotReady extends Error {}

export const STATE_DIR = ".vermillion";
export const DOCS_DIR = STATE_DIR + "/docs";
export const DRAFT_DIR_SUFFIX = "-docs-drafts";
const DRAFT_BRANCH_PREFIX = "docs/";

/** One conversation tree's documents before they reach the main branch. */
export type DocDraft = { treeId: string; path: string; branch: string };

/** Git-safe name of a tree's draft; the same key names the branch and the directory. */
export const draftKey = (treeId: string): string =>
  treeId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "tree";

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

/** Every directory holding a Git-tracked file, as a POSIX path relative to the workspace root. */
export const listTrackedDirectories = async (rootPath: string): Promise<string[]> => {
  const listed = await git(rootPath, ["ls-files", "-z"]);
  const directories = new Set<string>();
  for (const file of listed.split("\0")) {
    const parts = file.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) directories.add(parts.slice(0, i).join("/"));
  }
  return [...directories].sort();
};

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

const assertReferencePath = (path: string): void => {
  const normalized = toPosix(path);
  if (!normalized || isAbsolute(path) || normalized.split("/").includes("..")) {
    throw new Error("Reference path must be relative to the workspace root: " + path);
  }
};

/** Git-backed document store rooted at <workspace>/.vermillion/docs. */
export class DocsService {
  private gitDir?: string;
  /**
   * A draft worktree compares its documents with the main branch it will be merged into, so its
   * markers, diffs and discards describe what the draft would change there. The main store uses its
   * own HEAD.
   */
  constructor(private readonly rootPath: string, private readonly base?: string) {}

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

  async listDirectMarkdown(dirPath: string): Promise<string[]> {
    assertDocPathOrRoot(dirPath);
    const dir = join(this.rootPath, dirPath);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => toPosix(relative(this.rootPath, join(dir, entry.name))))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
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

  /** Delete a document. Tracked files stay recorded as pending deletions until the next docs commit. */
  async remove(path: string): Promise<void> {
    assertDocPath(path);
    const full = join(this.rootPath, path);
    const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Doc delete requires a real file: " + path);
    await unlink(full);
  }

  /** Read-only: does not touch the index. Untracked files count as added. */
  async pendingChanges(): Promise<DocChange[]> {
    if (!this.base) return this.editedChanges();
    const changes = new Map<string, DocChange["status"]>();
    const diff = await git(this.rootPath, ["--no-optional-locks", "--literal-pathspecs", "diff", "--name-status", "-z", "--no-renames", this.base, "--", DOCS_DIR]);
    const listed = diff.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < listed.length; i += 2) {
      changes.set(listed[i + 1]!, listed[i]!.includes("D") ? "deleted" : listed[i]!.includes("A") ? "added" : "modified");
    }
    for (const path of (await git(this.rootPath, ["--literal-pathspecs", "ls-files", "--others", "-z", "--exclude-standard", "--", DOCS_DIR])).split("\0").filter(Boolean)) {
      changes.set(path, "added");
    }
    return [...changes].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Worktree edits this scope has not committed yet; the only changes a commit can capture. */
  async editedChanges(): Promise<DocChange[]> {
    const status = await git(this.rootPath, ["--no-optional-locks", "--literal-pathspecs", "status", "--no-renames", "--porcelain=v1", "-z", "--untracked-files=all", "--", DOCS_DIR]);
    const changes: DocChange[] = [];
    const entries = status.split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      const kind: DocChange["status"] = code.includes("D") ? "deleted" : code === "??" || code.includes("A") ? "added" : "modified";
      changes.push({ path, status: kind });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Expand selected files/folders to the currently changed files, without touching the index. */
  async discardPreview(paths: string[]): Promise<DocChange[]> {
    if (!paths.length) throw new Error("Select at least one doc path.");
    const targets = paths.map((path) => toPosix(path).replace(/\/$/, ""));
    for (const path of targets) assertDocPathOrRoot(path);
    return (await this.pendingChanges()).filter((change) => targets.some((path) => change.path === path || change.path.startsWith(path + "/")));
  }

  /** Restore exactly the confirmed files to HEAD in both index and worktree. Caller serializes Git mutations. */
  async discard(paths: string[]): Promise<DocChange[]> {
    if (!paths.length) throw new Error("Select at least one doc path.");
    const targets = paths.map(toPosix);
    for (const path of targets) assertDocPath(path);
    const changes = (await this.pendingChanges()).filter((change) => targets.includes(change.path));
    if (!changes.length) return [];
    // Never traverse a symlink parent or recursively remove a directory that replaced a confirmed file.
    for (const { path } of changes) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i += 1) {
        const full = join(this.rootPath, ...parts.slice(0, i));
        const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (info && (i < parts.length ? !info.isDirectory() || info.isSymbolicLink() : info.isDirectory())) {
          throw new Error("Doc discard requires a file with real directory parents: " + path);
        }
      }
    }
    const head = this.base ?? await this.head();
    const tracked = new Set(head ? (await git(this.rootPath, ["ls-tree", "-r", "--name-only", "-z", head, "--", DOCS_DIR])).split("\0") : []);
    const restore = changes.filter(({ path }) => tracked.has(path)).map(({ path }) => path);
    const remove = changes.filter(({ path }) => !tracked.has(path)).map(({ path }) => path);
    for (const path of remove) {
      await unlink(join(this.rootPath, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    if (remove.length) await git(this.rootPath, ["update-index", "--force-remove", "--", ...remove]);
    if (restore.length) await git(this.rootPath, ["--literal-pathspecs", "restore", "--source=" + head, "--staged", "--worktree", "--", ...restore]);
    return changes;
  }

  /** Current file against HEAD, including staged edits and untracked additions; never writes the index. */
  async diff(path: string): Promise<string> {
    assertDocPath(path);
    const head = this.base ?? await this.head();
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
    if (await git(worktreePath, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"])) {
      throw new WorktreeNotReady("Worker must commit its worktree before integration.");
    }
    return this.mergeCommit(target, message, before);
  }

  /** Merge one committed revision into the main branch; a conflicting merge is aborted and reported. */
  private async mergeCommit(target: string, message: string, before: string): Promise<{ commit: string; diffStat: string }> {
    await this.checkIntegrationReady();
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

  /** Where this tree's drafts live: beside the workspace, outside the repository. */
  private draftRoot(): string {
    return join(dirname(this.rootPath), basename(this.rootPath) + DRAFT_DIR_SUFFIX);
  }

  /** One tree's draft, created at the main branch tip when requested. */
  async draft(treeId: string, create = false): Promise<DocDraft | undefined> {
    const key = draftKey(treeId);
    const path = join(this.draftRoot(), key);
    const branch = DRAFT_BRANCH_PREFIX + key;
    const registered = await this.registration(path);
    // A draft replaying its own commits is detached, so the path and not the branch identifies it.
    if (registered) return !registered.branch || registered.branch === branch ? { treeId: key, path, branch } : undefined;
    if (!create) return undefined;
    const head = await this.resolveCommit("HEAD");
    await git(this.rootPath, (await this.branchExists(branch))
      ? ["worktree", "add", "--no-checkout", path, branch]
      : ["worktree", "add", "--no-checkout", "-b", branch, path, head]);
    await git(path, ["sparse-checkout", "set", DOCS_DIR]);
    await git(path, ["read-tree", "-mu", "HEAD"]);
    return { treeId: key, path, branch };
  }

  /** Every draft this workspace still registers. */
  async listDrafts(): Promise<DocDraft[]> {
    const root = this.draftRoot();
    return (await this.registrations())
      .flatMap((entry) => samePath(dirname(entry.path), root)
        ? [{ treeId: basename(entry.path), path: entry.path, branch: DRAFT_BRANCH_PREFIX + basename(entry.path) }]
        : []);
  }

  /**
   * Bring a draft to the main branch tip so its changes are always measured against the current
   * main branch. Local edits survive: a draft whose own edit would be overwritten, and a draft
   * carrying its own commits, stay put and are resolved by the next commit.
   */
  async syncDraft(draft: DocDraft): Promise<void> {
    if (await this.rebaseInProgress(draft.path)) return;
    const head = await this.resolveCommit("HEAD");
    const own = await this.resolveCommit(draft.branch);
    if (await this.isAncestor(head, own) || !await this.isAncestor(own, head)) return;
    const local = await this.editedPaths(draft.path);
    const incoming = (await git(this.rootPath, ["diff", "--name-only", own, head, "--", DOCS_DIR])).split("\n").filter(Boolean);
    if (incoming.some((path) => local.has(path))) return;
    await git(draft.path, ["merge", "--ff-only", "-q", head]);
  }

  /** Documents this worktree holds, staged, edited or not tracked yet; a merge must never touch them. */
  private async editedPaths(worktreePath: string): Promise<Set<string>> {
    const status = await git(worktreePath, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", DOCS_DIR]);
    return new Set(status.split("\0").filter(Boolean).map((entry) => entry.slice(3)));
  }

  /** True while the draft holds commits the main branch does not carry yet. */
  async draftAhead(draft: DocDraft): Promise<boolean> {
    return !await this.isAncestor(await this.resolveCommit(draft.branch), await this.resolveCommit("HEAD"));
  }

  /** Merge a committed draft into the main branch, then let the draft follow the merged tip. */
  async mergeDraft(draft: DocDraft, message: string): Promise<{ commit?: string; diffStat: string }> {
    const before = await this.resolveCommit("HEAD");
    const target = await this.resolveCommit(draft.branch);
    if (await this.isAncestor(target, before)) return { diffStat: "" };
    try {
      const merged = await this.isAncestor(before, target)
        ? await this.fastForwardMain(target, before)
        : await this.mergeCommit(target, message, before);
      await this.syncDraft(draft);
      return merged;
    } catch (error) {
      if (error instanceof WorktreeMergeConflict) throw new DocDraftConflict(error.files);
      throw error;
    }
  }

  /** The main branch has not moved since the draft branched, so the draft is the whole change. */
  private async fastForwardMain(target: string, before: string): Promise<{ commit: string; diffStat: string }> {
    await this.checkIntegrationReady();
    await git(this.rootPath, ["-c", "user.name=Vermillion", "-c", "user.email=vermillion@local", "merge", "--ff-only", "-q", target]);
    const commit = await this.resolveCommit("HEAD");
    return { commit, diffStat: await git(this.rootPath, ["diff", "--stat", before, commit]) };
  }

  /** True while a draft is replaying its own commits on the main branch. */
  async rebaseInProgress(worktreePath: string): Promise<boolean> {
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      const path = (await git(worktreePath, ["rev-parse", "--git-path", marker])).trim();
      if (await exists(resolve(worktreePath, path))) return true;
    }
    return false;
  }

  /** Replay a draft's own commits on the main branch; a conflict stays in the draft with its files. */
  async rebaseDraft(draft: DocDraft): Promise<string[]> {
    const head = await this.resolveCommit("HEAD");
    try {
      await git(draft.path, ["rebase", head]);
    } catch (error) {
      const files = await this.unmerged(draft.path);
      if (!files.length) throw error;
      return files;
    }
    return [];
  }

  /** Finish a rebase the caller resolved; a further conflict stops again with its files. */
  async continueDraftRebase(worktreePath: string, message?: string): Promise<string[]> {
    await git(worktreePath, ["add", "-A", "--", DOCS_DIR]);
    try {
      await git(worktreePath, ["-c", "core.editor=true", "rebase", "--continue"]);
    } catch (error) {
      const files = await this.unmerged(worktreePath);
      if (!files.length) throw error;
      return files;
    }
    const files = await this.unmerged(worktreePath);
    // The replayed commit keeps its original message; the caller's message describes this delivery.
    if (!files.length && message) {
      await git(worktreePath, ["-c", "user.name=Vermillion", "-c", "user.email=vermillion@local", "commit", "--amend", "-m", message]);
    }
    return files;
  }

  /** True when a draft holds nothing the main branch does not already carry. */
  async draftMerged(draft: DocDraft): Promise<boolean> {
    const head = await this.head();
    if (!head) return false;
    if ((await git(draft.path, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all", "--", DOCS_DIR])).trim()) return false;
    return !(await git(this.rootPath, ["diff", "--name-only", head, draft.branch, "--", DOCS_DIR])).trim();
  }

  private async unmerged(worktreePath: string): Promise<string[]> {
    return (await git(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z", "--", DOCS_DIR])).split("\0").filter(Boolean);
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
    if (samePath(worktreePath, this.rootPath)) throw new Error("Cannot remove the workspace root");
    const registered = await this.registration(worktreePath);
    if (registered && registered.branch !== branch) throw new Error("Worktree branch ownership changed: " + worktreePath);
    if (registered) await git(this.rootPath, ["worktree", "remove", ...(discard ? ["--force"] : []), worktreePath]);
    else if (await exists(worktreePath)) {
      if ((await readdir(worktreePath)).length) throw new Error("已注销的 worktree 目录仍有内容，保留以待检查：" + worktreePath);
      await rmdir(worktreePath);
    }
    const ref = "refs/heads/" + branch;
    const branches = await git(this.rootPath, ["for-each-ref", "--format=%(refname)", ref]);
    if (branches.split("\n").includes(ref)) await git(this.rootPath, ["branch", discard ? "-D" : "-d", "--", branch]);
  }

  /** Worktrees Git currently registers for this repository, with their checked-out branch. */
  private async registrations(): Promise<Array<{ path: string; branch?: string }>> {
    const listed = await git(this.rootPath, ["worktree", "list", "--porcelain", "-z"]);
    return listed.split("\0\0").flatMap((entry) => {
      const fields = entry.split("\0");
      const location = fields.find((field) => field.startsWith("worktree "));
      if (!location) return [];
      const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "");
      return [{ path: location.slice("worktree ".length), ...(branch ? { branch } : {}) }];
    });
  }

  private async registration(path: string): Promise<{ path: string; branch?: string } | undefined> {
    return (await this.registrations()).find((entry) => samePath(entry.path, path));
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await git(this.rootPath, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch]);
      return true;
    } catch {
      return false;
    }
  }

  async head(): Promise<string | undefined> {
    try {
      return (await git(this.rootPath, ["rev-parse", "HEAD"])).trim();
    } catch {
      return undefined;
    }
  }

  async changedPaths(from: string | undefined, to: string | undefined): Promise<string[]> {
    if (!from || !to || from === to) return [];
    const start = await this.resolveCommit(from);
    const end = await this.resolveCommit(to);
    return (await git(this.rootPath, ["diff", "--name-only", "-z", start, end]))
      .split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
  }

  async resolveRevision(value: string): Promise<string> {
    return this.resolveCommit(value);
  }

  private workspacePaths(paths: string[]): string[] {
    return paths.filter((path) => {
      const relativePath = relative(this.rootPath, resolve(this.rootPath, path));
      return relativePath !== ".." && !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath);
    });
  }

  async rootResult(commit: string | undefined, base: string | undefined, allowedPaths: string[]): Promise<{ commit?: string; commits?: string[]; diffStat: string }> {
    const workspacePaths = this.workspacePaths(allowedPaths);
    if (!workspacePaths.length) {
      if (commit) throw new WorktreeNotReady("根目录代码成果需要在 scope.allowedPaths 登记归属路径。");
      return { diffStat: "" };
    }
    const paths = [...workspacePaths, ":(exclude).vermillion"];
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

  /** Read any workspace-relative UTF-8 file at a fixed commit for work-item requirements. */
  async readReference(path: string, commit: string): Promise<string> {
    assertReferencePath(path);
    const revision = await this.resolveCommit(commit);
    const { stdout } = await execFileAsync("git", ["show", revision + ":" + toPosix(path)], {
      cwd: this.rootPath, encoding: "buffer", maxBuffer: 16 * 1024 * 1024
    });
    if (!isTextContent(stdout)) throw new Error("引用不是 UTF-8 文本文件：" + path);
    return stdout.toString("utf8");
  }

  /** Validate and canonicalize one fixed reference before it enters a contract. */
  async validateReference(ref: WorkItem["refs"][number]): Promise<WorkItem["refs"][number]> {
    const commit = await this.resolveRevision(ref.commit);
    const content = await this.readReference(ref.path, commit);
    const section = ref.section?.trim();
    if (section) locateMarkdownSection(content, section);
    return {
      path: toPosix(ref.path),
      ...(section ? { section } : {}),
      ...(ref.description?.trim() ? { description: ref.description.trim() } : {}),
      commit
    };
  }

  /** Compare exactly one reference; an invalid location is reported and never widened to the full file. */
  async referenceChange(ref: WorkItem["refs"][number], to: string): Promise<{ changed: boolean; diff?: string; invalid?: string }> {
    const target = await this.resolveRevision(to);
    if (ref.commit === target) return { changed: false };
    let beforeContent: string;
    try { beforeContent = await this.readReference(ref.path, ref.commit); }
    catch (error) {
      return { changed: false, invalid: `基准 ${ref.commit}：${error instanceof Error ? error.message : String(error)}` };
    }
    let afterContent: string;
    try { afterContent = await this.readReference(ref.path, target); }
    catch (error) {
      return { changed: false, invalid: `当前 ${target}：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!ref.section) {
      const diff = await this.committedDiff(ref.path, ref.commit, target);
      return diff.trim() ? { changed: true, diff } : { changed: false };
    }
    let before;
    try { before = locateMarkdownSection(beforeContent, ref.section); }
    catch (error) {
      return { changed: false, invalid: `基准 ${ref.commit}：${error instanceof Error ? error.message : String(error)}` };
    }
    let after;
    try { after = locateMarkdownSection(afterContent, ref.section); }
    catch (error) {
      return { changed: false, invalid: `当前 ${target}：${error instanceof Error ? error.message : String(error)}` };
    }
    return before.text === after.text
      ? { changed: false }
      : { changed: true, diff: sectionDiff(ref.path, ref.section, before.text, after.text) };
  }

  async referenceProblem(ref: WorkItem["refs"][number], current = "HEAD"): Promise<string | undefined> {
    try {
      await this.validateReference(ref);
      const content = await this.readReference(ref.path, current);
      if (ref.section) locateMarkdownSection(content, ref.section);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
      if (path === "index") notify("docs");
      if (path === "HEAD" || path === "packed-refs" || path.startsWith("refs/")) notify("git");
    }) : undefined;
    return { close: () => { stateWatcher.close(); gitWatcher?.close(); for (const timer of timers.values()) clearTimeout(timer); } };
  }
}
