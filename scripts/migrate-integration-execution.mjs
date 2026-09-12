import { copyFile, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const [workspace, confirmation] = process.argv.slice(2);
if (!workspace || confirmation !== "--owner-stopped") {
  throw new Error("Stop the application owning this workspace first. Usage: node scripts/migrate-integration-execution.mjs <workspace> --owner-stopped");
}
const directory = join(resolve(workspace), ".vermillion", "workitems");
const now = new Date().toISOString();
let changed = 0;
for (const name of await readdir(directory)) {
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
console.log(`Migrated ${changed} records in ${directory}; original records backed up beside each file.`);
