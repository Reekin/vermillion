import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DocChange, DocFile } from "./contracts.js";
import { DESIGN_PARTNER_INSTRUCTIONS } from "./design-partner-instructions.js";

const execFileAsync = promisify(execFile);

export const STATE_DIR = ".vermillion";
export const DOCS_DIR = STATE_DIR + "/docs";

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const toPosix = (value: string): string => value.split(sep).join("/");

const samePath = (a: string, b: string): boolean =>
  toPosix(resolve(a)).toLowerCase() === toPosix(resolve(b)).toLowerCase();

const assertDocPath = (path: string): void => {
  const normalized = toPosix(path);
  if (!normalized.startsWith(DOCS_DIR + "/") || normalized.includes("..")) {
    throw new Error("Doc path must live under " + DOCS_DIR + "/: " + path);
  }
};

/** Git-backed document store rooted at <workspace>/.vermillion/docs. */
export class DocsService {
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
    const instructionsPath = join(this.rootPath, STATE_DIR, "AGENTS.md");
    try {
      await stat(instructionsPath);
    } catch {
      await writeFile(instructionsPath, DESIGN_PARTNER_INSTRUCTIONS, "utf8");
    }
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
          out.push({ path: toPosix(relative(this.rootPath, full)), size: info.size, modifiedAt: info.mtime.toISOString() });
        }
      }
    };
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string> {
    assertDocPath(path);
    return readFile(join(this.rootPath, path), "utf8");
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

  async diff(path: string): Promise<string> {
    assertDocPath(path);
    try {
      return await git(this.rootPath, ["diff", "--no-color", "--", path]);
    } catch {
      return "";
    }
  }

  async commit(message: string): Promise<string> {
    await git(this.rootPath, ["add", "-A", "--", DOCS_DIR]);
    await git(this.rootPath, ["-c", "user.name=Vermillion", "-c", "user.email=vermillion@local", "commit", "-q", "-m", message, "--", DOCS_DIR]);
    return (await git(this.rootPath, ["rev-parse", "HEAD"])).trim();
  }

  async head(): Promise<string | undefined> {
    try {
      return (await git(this.rootPath, ["rev-parse", "HEAD"])).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Recursive watcher over .vermillion; reports which area changed ("docs", "missions", "workitems", "decisions")
   * so out-of-process writers (CLI, agents) surface as the same events as in-process writes. Debounced per area.
   */
  watch(onChange: (area: string) => void): FSWatcher {
    const timers = new Map<string, NodeJS.Timeout>();
    return watch(join(this.rootPath, STATE_DIR), { recursive: true }, (_event, filename) => {
      const area = String(filename ?? "").split(/[\\/]/)[0] ?? "";
      if (!area || area.endsWith(".tmp")) return;
      clearTimeout(timers.get(area));
      timers.set(area, setTimeout(() => onChange(area), 150));
    });
  }
}
