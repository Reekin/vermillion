import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { WorkspaceSource } from "./workbench-service.js";

const zRecord = z.object({ workspaceId: z.string(), absolutePath: z.string(), label: z.string(), createdAt: z.string(), updatedAt: z.string() });
const zRegistry = z.object({ workspaces: z.array(zRecord) }).passthrough();

/**
 * Reads/writes the session engine's workspace-registry.json directly.
 * Used by the CLI, which runs outside the desktop process; the desktop wires the live registry instead.
 */
export const createFileWorkspaceSource = (registryPath: string, now: () => string = () => new Date().toISOString()): WorkspaceSource => {
  const load = async () => {
    try {
      return zRegistry.parse(JSON.parse(await readFile(registryPath, "utf8")));
    } catch {
      return { workspaces: [] } as z.infer<typeof zRegistry>;
    }
  };
  const save = async (doc: z.infer<typeof zRegistry>) => {
    await mkdir(dirname(registryPath), { recursive: true });
    const tmp = registryPath + ".tmp";
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    await rename(tmp, registryPath);
  };
  const toRecord = (w: z.infer<typeof zRecord>) => ({ workspaceId: w.workspaceId, rootPath: w.absolutePath, label: w.label, createdAt: w.createdAt, updatedAt: w.updatedAt });
  return {
    list: async () => (await load()).workspaces.map(toRecord),
    register: async (input) => {
      const doc = await load();
      const existing = doc.workspaces.find((w) => w.absolutePath.toLowerCase() === input.rootPath.toLowerCase());
      if (existing) return toRecord(existing);
      const record = {
        workspaceId: "workspace-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10),
        absolutePath: input.rootPath,
        label: input.label ?? basename(input.rootPath),
        createdAt: now(),
        updatedAt: now()
      };
      doc.workspaces.push(record);
      await save(doc);
      return toRecord(record);
    },
    remove: async (workspaceId) => {
      const doc = await load();
      doc.workspaces = doc.workspaces.filter((w) => w.workspaceId !== workspaceId);
      await save(doc);
    }
  };
};
