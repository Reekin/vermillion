import { copyFile, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

if (process.argv[2] !== "--owner-stopped") {
  throw new Error("Stop the application first. Usage: node scripts/migrate-integration-execution.mjs --owner-stopped");
}
const baseDir = resolve(process.env.VERMILLION_PERSISTENCE_BASE_DIR || join(homedir(), ".vermillion"));
const registry = JSON.parse(await readFile(join(baseDir, "workspace-registry.json"), "utf8"));
if (!Array.isArray(registry.workspaces) || registry.workspaces.some((workspace) => typeof workspace.absolutePath !== "string")) {
  throw new Error("Invalid workspace registry: " + baseDir);
}
const now = new Date().toISOString();
let changed = 0;
for (const workspace of registry.workspaces) await migrateWorkspace(workspace.absolutePath);
console.log(`Migrated ${changed} records across registered workspaces; original records backed up beside each file.`);

async function migrateWorkspace(workspace) {
  const directory = join(workspace, ".vermillion", "workitems");
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const record = JSON.parse(await readFile(path, "utf8"));
    let dirty = false;
    for (const action of record.integrations ?? []) {
      if (!action.agent) continue;
      const { sessionId, note, requestedAt, ...runtime } = action.agent;
      const open = !["done", "cancelled"].includes(action.status);
      if (!Object.keys(runtime).length && (!open || record.execution.integrationActionId === action.actionId)) continue;
      action.agent = { sessionId, note, requestedAt };
      if (open) {
        const paused = runtime.pausedAt || record.execution.pauseReason === "user";
        const waiting = paused || record.item.status === "decision";
        record.execution = { ...record.execution, integrationActionId: action.actionId, sessionId,
          status: waiting ? "decision" : "pending", stage: "deliver", runId: undefined,
          scheduledTurnId: undefined, deliveredAt: undefined, attempts: 0, idleTurns: 0, retryAt: undefined,
          pauseReason: paused ? "user" : undefined, failure: undefined, updatedAt: now,
          message: ["继续接管合入本单。读取 workItem.get 与 action.list，保留已有成果和证据，通过 workItem.integration.complete 完成串行合入。",
            "workItemId: " + record.workItemId, "integrationActionId: " + action.actionId,
            action.failure, note].filter(Boolean).join("\n") };
        record.item.status = waiting ? "decision" : "queued";
        record.item.updatedAt = now;
        action.status = "pending";
        action.retryAt = undefined;
        action.updatedAt = now;
      }
      dirty = true;
    }
    if (!dirty) continue;
    await copyFile(path, path + ".integration-backup-" + Date.now());
    const temporary = path + ".migration.tmp";
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
    await rename(temporary, path);
    changed++;
  }
}
