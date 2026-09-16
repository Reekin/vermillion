/**
 * One-off conversion of stored work items from `execution.message` to the typed `execution.notices`
 * list. Run it with the desktop closed: a running instance holds these records in memory and would
 * write its own copy back. Records that are already converted are left alone.
 */
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const root = resolve(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
if (!args.includes("--yes")) {
  console.error("Convert .vermillion/workitems/*.json from execution.message to execution.notices.");
  console.error("Close the Vermillion desktop first, then run again with --yes.");
  console.error("Workspace root: " + root);
  process.exit(2);
}

const dir = join(root, ".vermillion", "workitems");
let names;
try { names = (await readdir(dir)).filter((name) => name.endsWith(".json")); }
catch (error) {
  if (error.code === "ENOENT") { console.log("No work items in " + dir + "."); process.exit(0); }
  throw error;
}

let converted = 0, skipped = 0;
for (const name of names) {
  const path = join(dir, name);
  const record = JSON.parse(await readFile(path, "utf8"));
  const execution = record.execution;
  if (!execution || !Object.prototype.hasOwnProperty.call(execution, "message")) { skipped += 1; continue; }
  const text = String(execution.message ?? "").trim();
  execution.notices = [...(execution.notices ?? []),
    ...(text ? [{ at: execution.updatedAt ?? execution.createdAt, kind: "resumed", text }] : [])];
  delete execution.message;
  const tmp = path + ".migrate.tmp";
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  converted += 1;
}
console.log("Converted " + converted + " work item record(s); " + skipped + " already current.");
