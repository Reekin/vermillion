import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./docs.js";
import type { z } from "zod";
import {
  zAgentRun,
  zScheduler,
  zDecisionCard,
  zMission,
  zWorkItem,
  type AgentRun,
  type Scheduler,
  type DecisionCard,
  type Mission,
  type WorkItem
} from "./contracts.js";

type Collection<T> = {
  list: () => Promise<T[]>;
  get: (id: string) => Promise<T | undefined>;
  put: (record: T) => Promise<T>;
};

/** Fields added after records were first written; filled in on read so older files stay valid. */
const withDefaults = (raw: unknown): unknown =>
  raw && typeof raw === "object" && "workItemId" in raw ? { dependsOn: [], ...(raw as Record<string, unknown>) } : raw;

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
    records.push(schema.parse(withDefaults(JSON.parse(raw))));
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
      return schema.parse(withDefaults(JSON.parse(raw)));
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
  readonly runs: Collection<AgentRun>;
  private readonly schedulerPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.stateDir = join(rootPath, STATE_DIR);
    this.missions = createCollection(join(this.stateDir, "missions"), zMission, "missionId");
    this.workItems = createCollection(join(this.stateDir, "workitems"), zWorkItem, "workItemId");
    this.decisions = createCollection(join(this.stateDir, "decisions"), zDecisionCard, "decisionId");
    this.runs = createCollection(join(this.stateDir, "runs"), zAgentRun, "runId");
    this.schedulerPath = join(this.stateDir, "scheduler.json");
  }

  async readScheduler(): Promise<Scheduler> {
    try {
      return zScheduler.parse(JSON.parse(await readFile(this.schedulerPath, "utf8")));
    } catch {
      return { enabled: false, maxWorkers: 2 };
    }
  }

  async writeScheduler(value: Scheduler): Promise<Scheduler> {
    const parsed = zScheduler.parse(value);
    await mkdir(this.stateDir, { recursive: true });
    await writeJsonAtomic(this.schedulerPath, parsed);
    return parsed;
  }

  async removeRun(runId: string): Promise<void> {
    await rm(join(this.stateDir, "runs", runId + ".json"), { force: true });
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(this.rootPath)).isDirectory();
    } catch {
      return false;
    }
  }
}
