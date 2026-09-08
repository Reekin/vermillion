import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { createWorkbenchClient } from "../src/rpc.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";

const exec = promisify(execFile);
export const git = async (root: string, ...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
export const contract = { title: "Deliver result", objective: "A visible result", risk: "R1" as const,
  scope: { inScope: [], outOfScope: [], allowedPaths: [] as string[] }, acceptance: [{ text: "Result is available" }] };
export const submission = { evidence: { summary: "Result available", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [] },
  review: [], verify: { verdict: "pass" as const, items: [{ index: 0, pass: true, evidence: "Checked result" }] } };

export async function setup(now?: () => string) {
  const root = await mkdtemp(join(tmpdir(), "verm-workflow-"));
  const roles = new RoleService({ globalDir: join(root, ".vermillion", "roles"), defaultsDir: join(process.cwd(), "roles") });
  await roles.ensureGlobal();
  const workspaces = createMemoryWorkspaceSource();
  const options = { workspaces, roles, now };
  const service = new WorkbenchService(options);
  const { workspaceId } = await service.addWorkspace({ rootPath: root });
  await git(root, "config", "user.name", "Workflow test");
  await git(root, "config", "user.email", "workflow@local");
  await git(root, "commit", "--allow-empty", "-qm", "baseline");
  const client = createWorkbenchClient({ request: createWorkbenchRpcHandler(service), onEvent: (listener) => service.subscribe(listener) });
  return { root, roles, service, options, client, workspaceId,
    cleanup: async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
