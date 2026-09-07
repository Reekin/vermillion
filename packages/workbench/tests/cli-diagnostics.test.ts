import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/vermillion.mjs", import.meta.url));

it("exits after cold CLI diagnosis, reports offline disposition, and explains invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-cli-diagnostics-"));
  const env = { ...process.env, VERMILLION_PERSISTENCE_BASE_DIR: join(root, "state") };
  const call = async (method: string, params: object = {}) => JSON.parse((await exec(process.execPath, [cli, method, JSON.stringify(params)], { env, timeout: 5000 })).stdout);
  try {
    await mkdir(join(root, "workspace"));
    const { workspaceId } = await call("workspace.add", { rootPath: join(root, "workspace") });
    const { workItemId } = await call("workItem.create", { workspaceId, title: "CLI", objective: "Waiting", risk: "R1", scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "Visible" }] });
    expect(await call("workItem.diagnose", { workspaceId, workItemId })).toMatchObject({ phase: "queued", scheduler: { online: false }, blockers: [] });
    expect(await call("workItem.escalate", { workspaceId, workItemId, message: "Clarify contract" })).toMatchObject({ feedback: { dispatch: "offline" } });
    expect(await call("workItem.recover", { workspaceId, workItemId })).toMatchObject({ dispatched: false, diagnosis: { blockers: [{ role: "steward" }] } });
    expect(await call("runtime.info")).toMatchObject({ buildId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), schedulerOnline: false });
    const help = await exec(process.execPath, [cli, "workspace.repair.submit", "--help"], { env });
    expect(help.stdout).toContain("适用状态");
    expect(help.stdout).toContain("evidence");
    expect(help.stdout).toContain("示例");
    await expect(exec(process.execPath, [cli, "workItem.recover", "{broken"], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("下一步") });
    await expect(call("workspace.repair.submit", { workspaceId, actionId: "missing" })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("sessionId") });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}, 20000);
