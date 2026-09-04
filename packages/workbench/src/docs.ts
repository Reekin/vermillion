import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { DocChange, DocFile } from "./contracts.js";

const execFileAsync = promisify(execFile);

export const DOCS_DIR = "docs";

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const toPosix = (value: string): string => value.split(sep).join("/");

const assertDocPath = (path: string): void => {
  const normalized = toPosix(path);
  if (!normalized.startsWith(DOCS_DIR + "/") || normalized.includes("..")) {
    throw new Error("Doc path must live under " + DOCS_DIR + "/: " + path);
  }
};

export class DocsService {
  constructor(private readonly rootPath: string) {}

  async ensureRepo(): Promise<void> {
    try {
      await git(this.rootPath, ["rev-parse", "--git-dir"]);
    } catch {
      await git(this.rootPath, ["init", "-q"]);
    }
    await mkdir(join(this.rootPath, DOCS_DIR), { recursive: true });
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
          out.push({
            path: toPosix(relative(this.rootPath, full)),
            size: info.size,
            modifiedAt: info.mtime.toISOString()
          });
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

  async pendingChanges(): Promise<DocChange[]> {
    await this.ensureRepo();
    await git(this.rootPath, ["add", "-N", "--", DOCS_DIR]);
    const status = await git(this.rootPath, ["status", "--porcelain", "--", DOCS_DIR]);
    const changes: DocChange[] = [];
    for (const line of status.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      const kind: DocChange["status"] = code.includes("D") ? "deleted" : code.includes("A") || code.includes("?") ? "added" : "modified";
      let diff = "";
      try {
        diff = await git(this.rootPath, ["diff", "--", path]);
      } catch {}
      changes.push({ path, status: kind, diff });
    }
    return changes;
  }

  async commit(message: string): Promise<string> {
    await this.ensureRepo();
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
}
