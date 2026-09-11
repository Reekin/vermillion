import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const baseDir = resolve(process.argv[2] || process.env.VERMILLION_PERSISTENCE_BASE_DIR || join(homedir(), ".vermillion"));
const registryPath = join(baseDir, "workspace-registry.json");
const backupRoot = join(baseDir, "migration-backups", "work-item-completion-" + new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));

const parse = (path, raw) => {
  try { return JSON.parse(raw); }
  catch (error) { throw new Error("无法解析 " + path + ": " + (error instanceof Error ? error.message : String(error))); }
};

const migrateRecord = (path, record) => {
  if (!record || typeof record !== "object" || !record.item || typeof record.item !== "object") throw new Error("不是受支持的工单记录：" + path);
  const item = record.item;
  let changed = false;
  if (item.contractRevision === undefined) { item.contractRevision = 0; changed = true; }
  const verifyItems = item.verify?.items;
  if (Array.isArray(verifyItems)) for (const entry of verifyItems) {
    if (entry.status === undefined) {
      if (typeof entry.pass !== "boolean") throw new Error("验收结果缺少可转换的 status/pass：" + path);
      entry.status = entry.pass ? "pass" : "defect";
      changed = true;
    }
    if (entry.pass !== undefined) { delete entry.pass; changed = true; }
  }
  return { record, changed };
};

const readTargets = async () => {
  const registry = parse(registryPath, await readFile(registryPath, "utf8"));
  if (!Array.isArray(registry.workspaces)) throw new Error("workspace-registry.json 缺少 workspaces");
  const targets = [];
  for (const workspace of registry.workspaces) {
    if (!workspace || typeof workspace.absolutePath !== "string") throw new Error("workspace 缺少 absolutePath");
    const dir = join(workspace.absolutePath, ".vermillion", "workitems");
    let names;
    try { names = await readdir(dir); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const path = join(dir, name);
      const raw = await readFile(path, "utf8");
      const migrated = migrateRecord(path, parse(path, raw));
      if (migrated.changed) targets.push({ path, record: migrated.record });
    }
  }
  return targets;
};

const targets = await readTargets();
if (targets.length) {
  await mkdir(backupRoot, { recursive: true });
  for (const { path, record } of targets) {
    const backupPath = join(backupRoot, path.replaceAll(":", "").replaceAll("\\", "_").replaceAll("/", "_"));
    await copyFile(path, backupPath);
    const temporary = path + ".work-item-completion.tmp";
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
    await rename(temporary, path);
  }
  console.log("Backups: " + backupRoot);
}
console.log("Migrated " + targets.length + " work item records.");
