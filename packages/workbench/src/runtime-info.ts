import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Capture the loaded build once, so rebuilding files cannot relabel a running process.
const directory = dirname(fileURLToPath(import.meta.url));
const hash = createHash("sha256");
for (const name of readdirSync(directory).filter((name) => /\.(?:js|cjs|ts)$/.test(name) && !name.endsWith(".d.ts")).sort()) {
  hash.update(name).update(readFileSync(join(directory, name)));
}
export const runtimeInfo = { buildId: "sha256:" + hash.digest("hex"), pid: process.pid, startedAt: new Date().toISOString() };
