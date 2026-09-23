#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const help = `Usage: node scripts/migrate-task-supervision.mjs --workspace ABSOLUTE_PATH --backup ABSOLUTE_NEW_DIRECTORY --owner-stopped [--data-dir ABSOLUTE_PATH] [--apply]

Stop every Vermillion instance and CLI writer that owns this workspace yourself first.
--owner-stopped explicitly confirms those owners have exited. The script never stops processes.
--data-dir checks that instance's endpoint.json PID; omit to check ~/.vermillion.
Default: dry-run, no files or directories are written. --apply enables replacement.
The backup directory must not exist and must be outside the workspace and data directory.
Original record bytes and a manifest are backed up before any replacement. Historical runs
are copied to the backup unchanged. No directory is deleted. Replacement is atomic per file,
not across the workspace; keep owners stopped until the report says complete.
Manual, retrying and uncertain deliveries remain paused for explicit review. Old attempts
cards are withdrawn as history. Pending chat text remains in backups, never replayed.
No supervisor or delivery acknowledgement is fabricated for historical preparation.
Requires current workbench build: pnpm --filter @vermillion/workbench build
Example: migrate-task-supervision.bat --workspace I:/project --backup I:/migration-backup --owner-stopped --apply
`;

function absolute(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}
const inside = (root, path) => {
  const rel = relative(root, path);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const unfinished = (status) => !["closed", "cancelled", "done"].includes(status);
const pendingDelivery = (record) => record.deliveryUncertain || record.pendingMessageId ||
  record.deliveries?.some((entry) => !["accepted", "cancelled"].includes(entry.state));
const needsPause = (record) => record.paused || (record.control && record.control !== "auto") ||
  record.pauseReason === "user" || pendingDelivery(record) || record.status === "retry" || record.retryAt ||
  record.attempts > 0 || record.idleTurns > 0 || record.notices?.some((entry) => entry.kind === "nag");

export function convertRecord(collection, original, schemas, at, retiredItems = new Set(), retiredRequests = new Set()) {
  if (collection === "runs") return original;
  if (collection === "decisions") {
    if (original.kind !== "attempts") return schemas.zDecisionCard.parse(original);
    return schemas.zDecisionCard.parse({ ...original, kind: undefined, deliveryPending: false,
      withdrawn: original.withdrawn ?? { reason: "Legacy automatic retry decision retired; review the original backup before explicitly resuming work.",
        at, sessionId: original.sessionId ?? "task-supervision-migration" } });
  }
  const schema = collection === "workitems" ? schemas.zWorkItemRecord : schemas.zWorkRequest;
  if (original.formatVersion === 2) { schema.parse(original); return original; }
  if (original.formatVersion !== undefined && original.formatVersion !== 1) throw new Error("Unsupported record formatVersion");
  if (collection === "work-requests") {
    const paused = needsPause(original) || retiredRequests.has(original.requestId);
    return schema.parse({ ...original, formatVersion: 2, paused: !!paused,
      userStopped: original.userStopped || original.pauseReason === "user" || undefined,
      pendingMessageId: undefined, dispatchRequested: false, supervisor: undefined,
      ...(paused ? { waitReason: "Historical execution is paused; review the migration backup before explicitly resuming." } : {}) });
  }
  const execution = original.execution;
  if (!execution || !original.item || !Array.isArray(original.integrations)) throw new Error("Expected a stored WorkItemRecord with execution and integrations");
  const openIntegrations = original.integrations.filter((entry) => unfinished(entry.status));
  const status = original.item.status === "decision"
    ? openIntegrations.length || execution.integrationActionId ? "merging" : execution.deliveredAt ? "running" : "queued"
    : original.item.status;
  const paused = unfinished(status) && (needsPause(execution) || retiredItems.has(original.workItemId));
  const integrations = original.integrations.map((entry) => ({ ...entry,
    ...(unfinished(entry.status) ? { status: "decision", failure: entry.failure ?? "Historical Git operation requires explicit review before continuing." } : {})
  }));
  return schema.parse({ ...original, formatVersion: 2, item: { ...original.item, status }, integrations,
    execution: { ...execution, paused: !!paused,
      userStopped: execution.userStopped || execution.pauseReason === "user" || undefined,
      status: retiredItems.has(original.workItemId) && execution.status === "decision" ? "pending"
        : execution.status === "retry" ? "pending" : execution.status,
      pendingMessageId: undefined,
      notices: execution.notices.filter((entry) => entry.kind !== "nag"),
      ...(paused ? { waitReason: "Historical execution is paused; review the migration backup before explicitly resuming." } : {})
    }
  });
}

async function ownerStopped(dataDir) {
  let endpoint;
  try { endpoint = JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!Number.isInteger(endpoint.pid) || endpoint.pid <= 0) throw new Error("endpoint.json has no valid owner PID; remove the stale endpoint manually only after confirming all owners have stopped");
  try { process.kill(endpoint.pid, 0); }
  catch (error) { if (error.code === "ESRCH") return; throw new Error(`Cannot confirm owner PID ${endpoint.pid} has stopped: ${error.message}`); }
  throw new Error(`Owner PID ${endpoint.pid} is still alive; stop the owner yourself before migration`);
}

export async function migrate(options, schemas) {
  if (!options.ownerStopped) throw new Error("--owner-stopped confirmation is required");
  const workspace = await realpath(absolute(options.workspace, "--workspace"));
  let dataDir = absolute(options.dataDir, "--data-dir");
  try { dataDir = await realpath(dataDir); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const backupInput = absolute(options.backup, "--backup");
  const backup = join(await realpath(resolve(backupInput, "..")), relative(resolve(backupInput, ".."), backupInput));
  if (inside(workspace, backup) || inside(dataDir, backup) || inside(backup, workspace) || inside(backup, dataDir)) throw new Error("Backup must be independent from workspace and data directory");
  try { await lstat(backup); throw new Error("Backup directory already exists; choose a new directory"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await ownerStopped(dataDir);
  const stateDir = await realpath(join(workspace, ".vermillion"));
  if (!inside(workspace, stateDir)) throw new Error("Workspace state directory points outside workspace");
  const records = [];
  for (const collection of ["workitems", "work-requests", "decisions", "runs"]) {
    const directory = join(stateDir, collection);
    let files;
    try { if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing linked collection: ${directory}`); files = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files.filter((entry) => entry.name.endsWith(".json"))) {
      if (!file.isFile()) throw new Error(`Refusing non-file record: ${file.name}`);
      const path = join(directory, file.name);
      const bytes = await readFile(path);
      records.push({ collection, name: file.name, path, bytes, original: JSON.parse(bytes.toString("utf8")) });
    }
  }
  const retiredItems = new Set(records.filter((entry) => entry.collection === "decisions" && entry.original.kind === "attempts")
    .map((entry) => entry.original.workItemId).filter(Boolean));
  const retiredRequests = new Set(records.filter((entry) => entry.collection === "decisions" && entry.original.kind === "attempts")
    .map((entry) => entry.original.requestId).filter(Boolean));
  const pendingDecisions = records.filter((entry) => entry.collection === "decisions" && entry.original.deliveryPending && !entry.original.withdrawn);
  const at = new Date().toISOString();
  for (const record of records) {
    let source = record.original;
    if (source.formatVersion !== 2 && record.collection === "workitems" &&
      pendingDecisions.some((entry) => entry.original.workItemId === source.workItemId)) {
      source = { ...source, execution: { ...source.execution, paused: true } };
    }
    if (source.formatVersion !== 2 && record.collection === "work-requests" &&
      pendingDecisions.some((entry) => entry.original.requestId === source.requestId)) {
      source = { ...source, paused: true };
    }
    try { record.converted = convertRecord(record.collection, source, schemas, at, retiredItems, retiredRequests); }
    catch (error) { throw new Error(`${record.path}: ${error.message}`); }
    record.changed = JSON.stringify(record.original) !== JSON.stringify(record.converted);
  }
  const report = { mode: options.apply ? "apply" : "dry-run", workspace, backup,
    files: records.map((entry) => ({ path: relative(stateDir, entry.path), changed: entry.changed })),
    warnings: ["Pending legacy chat text is backup-only; review it manually.", "Historical open Git operations require explicit continuation.", "No supervisor is created for old preparation records."], complete: false };
  if (!options.apply || !records.some((entry) => entry.changed)) return { ...report, complete: true };
  await ownerStopped(dataDir);
  await mkdir(backup);
  for (const record of records) {
    await mkdir(join(backup, record.collection), { recursive: true });
    await writeFile(join(backup, record.collection, record.name), record.bytes, { flag: "wx" });
  }
  await writeFile(join(backup, "manifest.json"), JSON.stringify({ ...report, at }, null, 2) + "\n", { flag: "wx" });
  for (const record of records.filter((entry) => entry.changed)) {
    await ownerStopped(dataDir);
    if (!(await readFile(record.path)).equals(record.bytes)) throw new Error(`Record changed during migration; owners must remain stopped: ${record.path}`);
    const temporary = `${record.path}.migration-${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record.converted, null, 2) + "\n", { flag: "wx" });
    try { await rename(temporary, record.path); }
    catch (error) { await unlink(temporary); throw error; }
  }
  await writeFile(join(backup, "complete.json"), JSON.stringify({ completedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
  return { ...report, complete: true };
}

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) { console.log(help); return; }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--owner-stopped") options.ownerStopped = true;
    else if (["--workspace", "--backup", "--data-dir"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      options[argument === "--data-dir" ? "dataDir" : argument.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${argument}; use --help`);
  }
  const { homedir } = await import("node:os");
  options.dataDir ??= join(homedir(), ".vermillion");
  const schemas = await import("../packages/workbench/dist/contracts.js");
  if (schemas.zWorkRequest.shape.formatVersion?.value !== 2 || schemas.zWorkItemRecord.shape.formatVersion?.value !== 2) {
    throw new Error("Build the current workbench before migration: pnpm --filter @vermillion/workbench build");
  }
  console.log(JSON.stringify(await migrate(options, schemas), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
