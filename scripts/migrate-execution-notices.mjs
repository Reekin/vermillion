/**
 * One-off conversion of stored work items from `execution.message` to the typed `execution.notices`
 * list. Every registered workspace is converted by default, because a stale record in any of them
 * stops the desktop from reading its inbox. Run it with the desktop closed: a running instance holds
 * these records in memory and would write its own copy back. Converted records are left alone.
 */
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const explicitRoots = args.filter((arg) => !arg.startsWith("--")).map((arg) => resolve(arg));

const registeredRoots = async () => {
  const registry = JSON.parse(await readFile(join(homedir(), ".vermillion", "workspace-registry.json"), "utf8"));
  return registry.workspaces.map((workspace) => workspace.absolutePath);
};

const roots = explicitRoots.length ? explicitRoots : await registeredRoots();
if (!args.includes("--yes")) {
  console.error("Convert .vermillion/workitems/*.json from execution.message to execution.notices.");
  console.error("Close the Vermillion desktop first, then run again with --yes.");
  console.error("Workspace roots:");
  for (const root of roots) console.error("  " + root);
  process.exit(2);
}

/** A record needs conversion when it has no `notices` array yet; any `message` becomes its one notice. */
const convertWorkspace = async (root) => {
  const dir = join(root, ".vermillion", "workitems");
  let names;
  try { names = (await readdir(dir)).filter((name) => name.endsWith(".json")); }
  catch (error) {
    if (error.code === "ENOENT") return { converted: 0, current: 0 };
    throw error;
  }
  let converted = 0, current = 0;
  for (const name of names) {
    const path = join(dir, name);
    const record = JSON.parse(await readFile(path, "utf8"));
    const execution = record.execution;
    if (!execution || Array.isArray(execution.notices)) { current += 1; continue; }
    const text = String(execution.message ?? "").trim();
    execution.notices = text ? [{ at: execution.updatedAt ?? execution.createdAt, kind: "resumed", text }] : [];
    delete execution.message;
    const tmp = path + ".migrate.tmp";
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    await rename(tmp, path);
    converted += 1;
  }
  return { converted, current };
};

for (const root of roots) {
  const { converted, current } = await convertWorkspace(root);
  console.log(root + ": converted " + converted + ", already current " + current + ".");
}
