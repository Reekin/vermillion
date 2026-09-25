// Exits 1 when any source file is newer than the desktop bundle, 0 otherwise.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(root, "apps/desktop/dist-web/index.html");
const mainJs = join(root, "apps/desktop/dist-electron/main.js");

const mtime = (path) => { try { return statSync(path).mtimeMs; } catch { return 0; } };
const built = Math.min(mtime(bundle), mtime(mainJs));
if (built === 0) process.exit(1);

const skip = new Set(["node_modules", "dist", "dist-web", "dist-electron", ".git", ".tmp", "tests"]);
const newest = (dir) => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }
  return latest;
};

const sources = Math.max(newest(join(root, "packages")), newest(join(root, "apps")));
process.exit(sources > built ? 1 : 0);
