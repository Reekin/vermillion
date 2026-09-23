import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as schemas from "../src/contracts.js";
import { migrate, convertRecord } from "../../../scripts/migrate-task-supervision.mjs";

const at = "2026-09-20T00:00:00.000Z";
const roots: string[] = [];
const oldItem = () => ({
  workItemId: "item",
  item: { workItemId: "item", title: "Contract", objective: "Keep objective", status: "decision", contractRevision: 3,
    risk: "R1", needs: [], dependsOn: [], refs: [{ path: "spec", commit: "abc" }], scope: { inScope: [], outOfScope: [], allowedPaths: [] },
    acceptance: [{ text: "Pass", source: "spec" }], review: [], decisions: [], rejections: [], createdAt: at, updatedAt: at,
    evidence: { summary: "Evidence", commands: [{ command: "test", output: "pass" }], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [], submittedAt: at } },
  execution: { actionId: "execute", workItemId: "item", kind: "execute", stage: "execute", status: "decision", attempts: 2,
    sessionId: "fixed-worker", deliveredAt: at, control: "manual", notices: [{ kind: "nag", at, text: "obsolete nag" }],
    deliveries: [{ state: "unknown", messageId: "pending", content: "unconfirmed text" }], pendingMessageId: "pending",
    migratedFromSessionId: "historical-worker", continuationSummary: "old continuation", idleTurns: 2,
    history: [{ at, event: "start", message: "Preserve history" }], createdAt: at, updatedAt: at },
  integrations: [], cleanup: [{ sessionId: "old", worktreePath: "I:/old", branch: "old", discard: false }]
});
const oldRequest = () => ({ requestId: "request", sourceSessionId: "source", workerSessionId: "preparation",
  status: "ready", control: "manual", attempts: 1, createdAt: at, updatedAt: at, workItemIds: ["item"],
  handoff: { sessionId: "preparation", at, workItemIds: ["item"], refs: [] },
  deliveries: [{ state: "queued", content: "pending preparation text" }] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vermillion-supervision-migration-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const backup = join(root, "backup");
  await mkdir(dataDir);
  const records = {
    "workitems/item.json": oldItem(),
    "work-requests/request.json": oldRequest(),
    "decisions/automatic.json": { decisionId: "automatic", kind: "attempts", workItemId: "item", requestId: "request", question: "Retry?", context: "Previous failure", options: [], createdAt: at },
    "decisions/business.json": { decisionId: "business", kind: "worker", workItemId: "item", question: "Choose scope", context: "Requirement", options: [], createdAt: at },
    "runs/history.json": { runId: "historical", content: "Raw historical record", extra: "preserve" }
  };
  for (const [path, record] of Object.entries(records)) {
    const file = join(workspace, ".vermillion", path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(record, null, 4) + "\r\n");
  }
  return { root, workspace, dataDir, backup, ownerStopped: true, records };
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("task supervision migration", () => {
  it("offers standalone CLI help before loading contracts or touching data", () => {
    const output = execFileSync(process.execPath, ["scripts/migrate-task-supervision.mjs", "--help"], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
    expect(output).toContain("--owner-stopped");
    expect(output).toContain("Default: dry-run");
  });

  it("previews without writes, then backs up exact bytes and emits schema-valid stopped records", async () => {
    const input = await fixture();
    const original = new Map(await Promise.all(Object.keys(input.records).map(async (path) => [path, await readFile(join(input.workspace, ".vermillion", path))] as const)));
    const preview = await migrate(input, schemas);
    expect(preview.mode).toBe("dry-run");
    await expect(access(input.backup)).rejects.toThrow();
    for (const [path, bytes] of original) expect(await readFile(join(input.workspace, ".vermillion", path))).toEqual(bytes);
    expect((await migrate({ ...input, apply: true }, schemas)).complete).toBe(true);
    for (const [path, bytes] of original) expect(await readFile(join(input.backup, path))).toEqual(bytes);
    const read = async (path: string) => JSON.parse(await readFile(join(input.workspace, ".vermillion", path), "utf8"));
    const item = schemas.zWorkItemRecord.parse(await read("workitems/item.json"));
    expect(item.item.status).toBe("running");
    expect(item.item.evidence).toEqual(input.records["workitems/item.json"].item.evidence);
    expect(item.execution).toMatchObject({ sessionId: "fixed-worker", paused: true, status: "pending", deliveredAt: at, history: input.records["workitems/item.json"].execution.history });
    expect(item.execution).not.toHaveProperty("deliveries");
    expect(item.execution).not.toHaveProperty("pendingMessageId");
    expect(item.execution.notices).toEqual([]);
    expect(item.cleanup).toEqual(input.records["workitems/item.json"].cleanup);
    const request = schemas.zWorkRequest.parse(await read("work-requests/request.json"));
    expect(request).toMatchObject({ formatVersion: 2, workerSessionId: "preparation", status: "ready", paused: true });
    expect(request.supervisor).toBeUndefined();
    expect(request.handoff?.turnId).toBeUndefined();
    const retired = schemas.zDecisionCard.parse(await read("decisions/automatic.json"));
    expect(retired.withdrawn?.reason).toContain("retired");
    expect(retired.answer).toBeUndefined();
    expect(retired.deliveryPending).toBe(false);
    expect(await read("decisions/business.json")).toEqual(input.records["decisions/business.json"]);
    expect(await readFile(join(input.workspace, ".vermillion/runs/history.json"))).toEqual(original.get("runs/history.json"));
    expect((await migrate({ ...input, backup: join(input.root, "second-backup") }, schemas)).files.every((file: { changed: boolean }) => !file.changed)).toBe(true);
  });

  it("restores decision phase from delivered or integration facts without manufacturing delivery", () => {
    const record = oldItem();
    delete (record.execution as Partial<typeof record.execution>).deliveredAt;
    expect(convertRecord("workitems", record, schemas, at).item.status).toBe("queued");
    expect(convertRecord("workitems", record, schemas, at).execution.deliveredAt).toBeUndefined();
    const integration = { actionId: "git", workItemId: "item", kind: "integration", stage: "merge", status: "retry", attempts: 2,
      message: "Resolve conflict", history: [], createdAt: at, updatedAt: at, integration: { operation: "merge", contractRevision: 3, target: "abc", diffStat: "files" } };
    const result = convertRecord("workitems", { ...record, integrations: [integration] }, schemas, at);
    expect(result.item.status).toBe("merging");
    expect(result.integrations[0]).toMatchObject({ status: "decision", integration: integration.integration });
    expect(result.integrations[0]).not.toHaveProperty("attempts");
  });

  it("runs the CLI dry-run and apply paths against a temporary workspace", async () => {
    const input = await fixture();
    const args = ["scripts/migrate-task-supervision.mjs", "--workspace", input.workspace, "--backup", input.backup,
      "--data-dir", input.dataDir, "--owner-stopped"];
    const run = (extra: string[]) => JSON.parse(execFileSync(process.execPath, [...args, ...extra], {
      cwd: new URL("../../../", import.meta.url), encoding: "utf8"
    }));
    expect(run([])).toMatchObject({ mode: "dry-run", complete: true });
    await expect(access(input.backup)).rejects.toThrow();
    expect(run(["--apply"])).toMatchObject({ mode: "apply", complete: true });
    expect(schemas.zWorkItemRecord.parse(JSON.parse(await readFile(join(input.workspace, ".vermillion/workitems/item.json"), "utf8"))).formatVersion).toBe(2);
  });

  it("retains an unanswered-delivery business decision and pauses its owner without claiming delivery", async () => {
    const input = await fixture();
    const automatic = join(input.workspace, ".vermillion/decisions/automatic.json");
    await writeFile(automatic, JSON.stringify({ ...input.records["decisions/business.json"], decisionId: "automatic", kind: "worker",
      answer: { note: "Approved scope", at }, deliveryPending: true }));
    const record = oldItem();
    await writeFile(join(input.workspace, ".vermillion/workitems/item.json"), JSON.stringify({ ...record,
      execution: { ...record.execution, control: "auto", attempts: 0, notices: [], idleTurns: 0, deliveries: [], pendingMessageId: undefined } }));
    await migrate({ ...input, apply: true }, schemas);
    const decision = schemas.zDecisionCard.parse(JSON.parse(await readFile(automatic, "utf8")));
    expect(decision.deliveryPending).toBe(true);
    expect(decision.withdrawn).toBeUndefined();
    expect(decision.answer?.note).toBe("Approved scope");
    const migrated = schemas.zWorkItemRecord.parse(JSON.parse(await readFile(join(input.workspace, ".vermillion/workitems/item.json"), "utf8")));
    expect(migrated.execution.paused).toBe(true);
    expect(migrated.execution.status).toBe("decision");
  });

  it("refuses a live owner, missing confirmation, relative paths and non-independent backups", async () => {
    const input = await fixture();
    await expect(migrate({ ...input, ownerStopped: false }, schemas)).rejects.toThrow("--owner-stopped");
    await expect(migrate({ ...input, workspace: "relative" }, schemas)).rejects.toThrow("absolute");
    await expect(migrate({ ...input, backup: join(input.workspace, "backup") }, schemas)).rejects.toThrow("independent");
    await writeFile(join(input.dataDir, "endpoint.json"), JSON.stringify({ pid: process.pid, port: 1 }));
    await expect(migrate({ ...input, apply: true }, schemas)).rejects.toThrow("still alive");
    await expect(access(input.backup)).rejects.toThrow();
  });

  it("validates the entire plan before writing any record or creating backup", async () => {
    const input = await fixture();
    const file = join(input.workspace, ".vermillion/workitems/item.json");
    await writeFile(file, JSON.stringify({ ...oldItem(), item: { title: "incomplete" } }));
    const original = await readFile(file);
    await expect(migrate({ ...input, apply: true }, schemas)).rejects.toThrow();
    expect(await readFile(file)).toEqual(original);
    await expect(access(input.backup)).rejects.toThrow();
  });
});
