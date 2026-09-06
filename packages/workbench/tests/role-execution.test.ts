import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RoleService } from "../src/roles.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { createWorkbenchClient } from "../src/rpc.js";
import { WorkbenchService } from "../src/workbench-service.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

it("carries independent model overrides through the role RPC without inheriting global header fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-role-execution-"));
  dirs.push(root);
  const roles = new RoleService({ globalDir: root });
  await writeFile(join(root, "worker.md"), '---\nmodel: "global-model"\nreasoningOptionId: high\nserviceTierId: priority\n---\nGlobal');
  const service = new WorkbenchService({ roles, workspaces: createMemoryWorkspaceSource() });
  try {
    const { workspaceId } = await service.addWorkspace({ rootPath: root });
    const client = createWorkbenchClient({ request: createWorkbenchRpcHandler(service), onEvent: () => () => {} });
    const params = { workspaceId, roleId: "worker" };
    expect(await client.request("role.resolve", params)).toEqual({
      content: "Global", modelConfig: { modelId: "global-model", reasoningOptionId: "high", serviceTierId: "priority" }
    });
    await client.request("role.write", { ...params, content: "---\r\nmode: append\r\nreasoningOptionId: 'low' # selection\r\nserviceTierId: null\r\n---\r\nProject" });
    expect(await client.request("role.resolve", params)).toEqual({
      content: "Global\n\nProject", modelConfig: { reasoningOptionId: "low", serviceTierId: null }
    });
    await client.request("role.write", { ...params, content: '---\nmodel: "role-model"\nreasoningOptionId: null\n---\nProject' });
    expect(await client.request("role.resolve", params)).toEqual({
      content: "Project", modelConfig: { modelId: "role-model", reasoningOptionId: null }
    });
    await client.request("role.write", { ...params, content: "Project" });
    expect(await client.request("role.resolve", params)).toEqual({ content: "Project" });
  } finally {
    service.dispose();
  }
});
