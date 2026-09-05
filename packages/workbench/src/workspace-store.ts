import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
  zDecisionCard,
  zIssue,
  zMission,
  zWorkItem,
  type DecisionCard,
  type Issue,
  type Mission,
  type WorkItem
} from "./contracts.js";

export const WORKSPACE_STATE_DIR = ".vermillion";

type Collection<T> = {
  list: () => Promise<T[]>;
  get: (id: string) => Promise<T | undefined>;
  put: (record: T) => Promise<T>;
};

const readJsonDir = async <T>(dir: string, schema: z.ZodType<T>): Promise<T[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(join(dir, name), "utf8");
    records.push(schema.parse(JSON.parse(raw)));
  }
  return records;
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
};

const createCollection = <T extends Record<string, unknown>>(
  dir: string,
  schema: z.ZodType<T>,
  idKey: keyof T & string
): Collection<T> => ({
  list: () => readJsonDir(dir, schema),
  get: async (id) => {
    try {
      const raw = await readFile(join(dir, id + ".json"), "utf8");
      return schema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  },
  put: async (record) => {
    const parsed = schema.parse(record);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, String(parsed[idKey]) + ".json"), parsed);
    return parsed;
  }
});

export class WorkspaceStore {
  readonly rootPath: string;
  readonly stateDir: string;
  readonly missions: Collection<Mission>;
  readonly workItems: Collection<WorkItem>;
  readonly decisions: Collection<DecisionCard>;
  readonly issues: Collection<Issue>;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.stateDir = join(rootPath, WORKSPACE_STATE_DIR);
    this.missions = createCollection(join(this.stateDir, "missions"), zMission, "missionId");
    this.workItems = createCollection(join(this.stateDir, "workitems"), zWorkItem, "workItemId");
    this.decisions = createCollection(join(this.stateDir, "decisions"), zDecisionCard, "decisionId");
    this.issues = createCollection(join(this.stateDir, "issues"), zIssue, "issueId");
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(this.rootPath)).isDirectory();
    } catch {
      return false;
    }
  }
}
