import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [dataDirInput, projectPathInput, countInput = "50"] = process.argv.slice(2);
if (!dataDirInput || !projectPathInput) {
  throw new Error("usage: node seed-multi-session-index.mjs <dataDir> <projectPath> [count]");
}
const count = Number(countInput);
if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
const dataDir = resolve(dataDirInput);
const projectPath = resolve(projectPathInput);
const path = join(dataDir, "session-index.json");
const existing = JSON.parse(await readFile(path, "utf8"));
const createdAt = new Date().toISOString();
const entries = Array.from({ length: count }, (_, index) => ({
  workspaceId: "workspace-fixture-session-tree",
  sessionId: `session-multi-${index}`,
  conversationId: `conversation-multi-${index}`,
  engineId: "codex",
  providerKind: "codex-thread",
  providerSessionId: `multi-session-${index}`,
  title: `Multi session ${index}`,
  summaryText: `Question ${index}:0`,
  createdAt,
  updatedAt: createdAt,
  lastCompletedTurnAt: createdAt,
  lastTurnId: `multi-session-${index}-turn-99`,
  unreadState: "read",
  source: "registry",
  metadata: { cwd: projectPath }
}));
await writeFile(path, `${JSON.stringify({
  version: 1,
  entries,
  relations: [],
  treeViews: existing.treeViews ?? {}
}, null, 2)}\n`, "utf8");
