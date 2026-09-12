import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

it.each([false, true])("converts legacy takeover without losing ownership or pause (%s)", async (paused) => {
  const f = await setup();
  let restarted: WorkbenchService | undefined;
  try {
    const item = await f.service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    const action = await f.service.createAction(f.workspaceId, {
      kind: "integration", workItemId: item.workItemId, stage: "merge", status: "running", message: "Git checkpoint",
      agent: { sessionId: "worker", requestedAt: "before", note: "preserve result" },
      integration: { operation: "merge", contractRevision: 0, target: "commit", diffStat: "" }
    }, (current) => ({ ...current, status: paused ? "decision" : "merging" }));
    await f.service.dispose();
    const dir = join(f.root, ".vermillion", "workitems");
    const path = join(dir, item.workItemId + ".json");
    const record = JSON.parse(await readFile(path, "utf8"));
    record.execution.status = "done";
    record.integrations[0].agent.deliveredAt = "before";
    if (paused) record.integrations[0].agent.pausedAt = "before";
    await writeFile(path, JSON.stringify(record));
    const secondDir = join(f.root, "second-workspace", ".vermillion", "workitems");
    await mkdir(secondDir, { recursive: true });
    await writeFile(join(secondDir, item.workItemId + ".json"), JSON.stringify(record));
    await writeFile(join(f.root, "workspace-registry.json"), JSON.stringify({ workspaces: [
      { absolutePath: f.root }, { absolutePath: join(f.root, "second-workspace") }, { absolutePath: join(f.root, "empty-workspace") }
    ] }));
    const migrate = () => promisify(execFile)(process.execPath, [resolve("../../scripts/migrate-integration-execution.mjs"), "--owner-stopped"], {
      env: { ...process.env, VERMILLION_PERSISTENCE_BASE_DIR: f.root }
    });
    expect((await migrate()).stdout).toContain("Migrated 2 records");
    expect(JSON.parse(await readFile(join(secondDir, item.workItemId + ".json"), "utf8")).execution.integrationActionId).toBe(action.actionId);
    expect((await migrate()).stdout).toContain("Migrated 0 records");
    restarted = new WorkbenchService(f.options);
    expect(await restarted.getWorkItem(f.workspaceId, item.workItemId)).toMatchObject({ status: paused ? "decision" : "queued", run: { sessionId: "worker" } });
    const [execution, integration] = await restarted.listActions(f.workspaceId);
    expect(execution).toMatchObject({ integrationActionId: action.actionId, status: paused ? "decision" : "pending" });
    expect(execution?.kind === "execute" && execution.pauseReason).toBe(paused ? "user" : undefined);
    expect(integration).toMatchObject({ integration: { target: "commit" }, agent: { note: "preserve result" } });
    expect((await readdir(dir)).filter((name) => name.includes("integration-backup"))).toHaveLength(1);
  } finally {
    await restarted?.dispose();
    await f.cleanup();
  }
});
