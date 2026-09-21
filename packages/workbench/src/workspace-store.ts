import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./docs.js";
import type { z } from "zod";
import {
  zAgentRun,
  zDomainConfig,
  zPatrolRun,
  zScheduler,
  zDecisionCard,
  zIssue,
  zWorkRequest,
  zWorkItemRecord,
  type WorkItemRecord,
  type AgentRun,
  type DomainConfig,
  type PatrolRun,
  type Scheduler,
  type DecisionCard,
  type Issue,
  type WorkRequest
} from "./contracts.js";

type Collection<T> = {
  list: () => Promise<T[]>;
  get: (id: string) => Promise<T | undefined>;
  put: (record: T) => Promise<T>;
  remove: (id: string) => Promise<void>;
};

const parseStored = <T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T => {
  try { return schema.parse(JSON.parse(raw)); }
  catch (cause) { throw new Error("Unsupported or invalid workbench record: " + path + ". Convert stored data explicitly before running this version.", { cause }); }
};

const readJsonDir = async <T>(dir: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(join(dir, name), "utf8");
    records.push(parseStored(join(dir, name), schema, raw));
  }
  return records;
};

let writeSeq = 0;
// Multiple services in the same host share each aggregate's read/modify/write transaction.
const recordWrites = new Map<string, Promise<unknown>>();

/**
 * Writes go through a per-call temp file (so concurrent writers of the same record never share one) and are renamed over the target.
 * Windows briefly locks a file while a watcher or reader has it open; rename then fails with EPERM. Retry a few times.
 */
const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const tmp = `${path}.${process.pid}-${writeSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

const createCollection = <T extends Record<string, unknown>>(
  dir: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  idKey: keyof T & string
): Collection<T> => ({
  list: () => readJsonDir(dir, schema),
  get: async (id) => {
    try {
      const raw = await readFile(join(dir, id + ".json"), "utf8");
      return parseStored(join(dir, id + ".json"), schema, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  put: async (record) => {
    const parsed = schema.parse(record);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, String(parsed[idKey]) + ".json"), parsed);
    return parsed;
  },
  remove: async (id) => { await rm(join(dir, id + ".json"), { force: true }); }
});

const transactCollection = async <T, R>(
  key: string,
  collection: Collection<T>,
  id: string,
  update: (record: T | undefined) => { record: T; result: R }
): Promise<R> => {
  const next = (recordWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const { record, result } = update(await collection.get(id));
    await collection.put(record);
    return result;
  });
  recordWrites.set(key, next);
  try { return await next; }
  finally { if (recordWrites.get(key) === next) recordWrites.delete(key); }
};

export class WorkspaceStore {
  readonly rootPath: string;
  readonly stateDir: string;
  readonly workRequests: Collection<WorkRequest>;
  readonly decisions: Collection<DecisionCard>;
  readonly issues: Collection<Issue>;
  readonly domainConfigs: Collection<DomainConfig>;
  readonly patrolRuns: Collection<PatrolRun>;
  readonly runs: Collection<AgentRun>;
  private readonly schedulerPath: string;
  private readonly records: Collection<WorkItemRecord>;

  async listRecords(): Promise<WorkItemRecord[]> { return this.records.list(); }

  async getRecord(id: string): Promise<WorkItemRecord | undefined> { return this.records.get(id); }

  /** Reject incompatible execution storage before any scheduler or preparation side effect. */
  async validateExecutionStorage(): Promise<void> {
    await this.records.list();
    let names: string[];
    try { names = await readdir(join(this.stateDir, "actions")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (names.some((name) => name.endsWith(".json"))) throw new Error("Unsupported separate action records in " + this.stateDir + ". Convert stored data explicitly before running this version.");
  }

  async transactRecord<T>(id: string, update: (record: WorkItemRecord | undefined) => { record: WorkItemRecord; result: T }): Promise<T> {
    return transactCollection(join(this.stateDir, "workitems", id), this.records, id, update);
  }

  async transactIssue<T>(id: string, update: (record: Issue | undefined) => { record: Issue; result: T }): Promise<T> {
    return transactCollection(join(this.stateDir, "issues", id), this.issues, id, update);
  }

  async transactWorkRequest<T>(id: string, update: (record: WorkRequest | undefined) => { record: WorkRequest; result: T }): Promise<T> {
    return transactCollection(join(this.stateDir, "work-requests", id), this.workRequests, id, update);
  }

  async transactDomainConfig<T>(id: string, update: (record: DomainConfig | undefined) => { record: DomainConfig; result: T }): Promise<T> {
    return transactCollection(join(this.stateDir, "domains", id), this.domainConfigs, id, update);
  }

  async transactPatrolRun<T>(id: string, update: (record: PatrolRun | undefined) => { record: PatrolRun; result: T }): Promise<T> {
    return transactCollection(join(this.stateDir, "patrols", id), this.patrolRuns, id, update);
  }

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.stateDir = join(rootPath, STATE_DIR);
    this.workRequests = createCollection(join(this.stateDir, "work-requests"), zWorkRequest, "requestId");
    this.records = createCollection(join(this.stateDir, "workitems"), zWorkItemRecord, "workItemId");
    this.decisions = createCollection(join(this.stateDir, "decisions"), zDecisionCard, "decisionId");
    this.issues = createCollection(join(this.stateDir, "issues"), zIssue, "issueId");
    this.domainConfigs = createCollection(join(this.stateDir, "domains"), zDomainConfig, "domainId");
    this.patrolRuns = createCollection(join(this.stateDir, "patrols"), zPatrolRun, "patrolRunId");
    this.runs = createCollection(join(this.stateDir, "runs"), zAgentRun, "runId");
    this.schedulerPath = join(this.stateDir, "scheduler.json");
  }

  async readScheduler(): Promise<Scheduler> {
    try {
      return zScheduler.parse(JSON.parse(await readFile(this.schedulerPath, "utf8")));
    } catch {
      return { enabled: true, maxWorkers: 2 };
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
