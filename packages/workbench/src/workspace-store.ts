import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./docs.js";
import type { z } from "zod";
import {
  zAgentRun,
  zScheduler,
  zDecisionCard,
  zWorkRequest,
  zWorkItemRecord,
  projectWorkItem,
  type WorkItemRecord,
  type Execution,
  type Integration,
  actionIsOpen,
  type WorkflowAction,
  type AgentRun,
  type Scheduler,
  type DecisionCard,
  type WorkRequest,
  type WorkItem
} from "./contracts.js";

type Collection<T> = {
  list: () => Promise<T[]>;
  get: (id: string) => Promise<T | undefined>;
  put: (record: T) => Promise<T>;
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
  }
});

export class WorkspaceStore {
  readonly rootPath: string;
  readonly stateDir: string;
  readonly workRequests: Collection<WorkRequest>;
  readonly workItems: Pick<Collection<WorkItem>, "get" | "list"> & {
    create: (item: WorkItemRecord["item"], runtime: Pick<Execution, "sessionId" | "worktreePath" | "branch">) => Promise<WorkItem>;
    update: (id: string, mutate: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]) => Promise<WorkItem>;
  };
  readonly decisions: Collection<DecisionCard>;
  readonly runs: Collection<AgentRun>;
  readonly actions: Pick<Collection<WorkflowAction>, "get" | "list"> & {
    createIntegration: (action: Integration, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]) => Promise<Integration>;
    update: <T extends WorkflowAction>(action: T, mutate: (current: T) => T, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]) => Promise<T>;
  };
  private readonly schedulerPath: string;
  private readonly records: Collection<WorkItemRecord>;

  async listRecords(): Promise<WorkItemRecord[]> { return this.records.list(); }

  async mutateRecord(id: string, mutate: (record: WorkItemRecord) => WorkItemRecord): Promise<WorkItem> {
    return this.updateRecord(id, (current) => {
      if (!current) throw new Error("Unknown work item: " + id);
      const record = mutate(current);
      return { record, result: projectWorkItem(record) };
    });
  }

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

  async updateExecution(id: string, mutate: (execution: Execution, item: WorkItemRecord["item"]) => { execution: Execution; item?: WorkItemRecord["item"] }): Promise<WorkItem> {
    return this.updateRecord(id, (current) => {
      if (!current) throw new Error("Unknown work item: " + id);
      const next = mutate(current.execution, current.item);
      const record = { ...current, ...next };
      return { record, result: projectWorkItem(record) };
    });
  }

  private async updateRecord<T>(id: string, update: (record: WorkItemRecord | undefined) => { record: WorkItemRecord; result: T }): Promise<T> {
    const key = join(this.stateDir, "workitems", id);
    const next = (recordWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const { record, result } = update(await this.records.get(id));
      await this.records.put(record);
      return result;
    });
    recordWrites.set(key, next);
    try { return await next; }
    finally { if (recordWrites.get(key) === next) recordWrites.delete(key); }
  }

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.stateDir = join(rootPath, STATE_DIR);
    this.workRequests = createCollection(join(this.stateDir, "work-requests"), zWorkRequest, "requestId");
    this.records = createCollection(join(this.stateDir, "workitems"), zWorkItemRecord, "workItemId");
    this.workItems = {
      list: async () => (await this.records.list()).map(projectWorkItem),
      get: async (id) => { const record = await this.records.get(id); return record && projectWorkItem(record); },
      create: async (item, runtime) => this.updateRecord(item.workItemId, (current) => {
        if (current) throw new Error("Use workItems.update for existing work");
        const record: WorkItemRecord = { workItemId: item.workItemId, item, integrations: [], cleanup: [], execution: {
          ...runtime, kind: "execute", actionId: "execution-" + item.workItemId, workItemId: item.workItemId,
          status: "pending", stage: "open", message: "",
          attempts: 0, idleTurns: 0, history: [], createdAt: item.createdAt, updatedAt: item.updatedAt
        } };
        return { record, result: projectWorkItem(record) };
      }),
      update: async (id, mutate) => this.updateRecord(id, (current) => {
        if (!current) throw new Error("Unknown work item: " + id);
        const record: WorkItemRecord = { ...current, item: mutate(current.item) };
        return { record, result: projectWorkItem(record) };
      })
    };
    this.decisions = createCollection(join(this.stateDir, "decisions"), zDecisionCard, "decisionId");
    this.runs = createCollection(join(this.stateDir, "runs"), zAgentRun, "runId");
    this.actions = {
      list: async () => (await this.records.list()).flatMap((record) => [record.execution, ...record.integrations]),
      get: async (id) => (await this.actions.list()).find((action) => action.actionId === id),
      createIntegration: async (action, mutateItem) => this.updateRecord(action.workItemId, (current) => {
        if (!current) throw new Error("Unknown work item: " + action.workItemId);
        const active = current.integrations.find(actionIsOpen);
        if (active) {
          if (active.integration.operation !== action.integration.operation) throw new Error("Another integration is still active for " + action.workItemId);
          return { record: current, result: active };
        }
        const record = { ...current, item: mutateItem ? mutateItem(current.item) : current.item, integrations: [...current.integrations, action] };
        return { record, result: action };
      }),
      update: async (action, mutate, mutateItem) => this.updateRecord(action.workItemId, (current) => {
        if (!current) throw new Error("Unknown work item: " + action.workItemId);
        const saved = action.kind === "execute" ? current.execution : current.integrations.find((entry) => entry.actionId === action.actionId);
        if (!saved) throw new Error("Unknown process: " + action.actionId);
        const updated: WorkflowAction = mutate(saved as typeof action);
        const record: WorkItemRecord = { ...current,
          item: mutateItem ? mutateItem(current.item) : current.item,
          ...(updated.kind === "execute" ? { execution: updated } : { integrations: current.integrations.map((entry) => entry.actionId === updated.actionId ? updated : entry) }) };
        return { record, result: updated as typeof action };
      })
    };
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
