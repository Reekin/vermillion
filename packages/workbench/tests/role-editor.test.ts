import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { RoleService } from "../src/roles.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { parseRoleDocument, serializeRoleDocument } from "../src/role-document.js";

it("edits scalar settings without trimming the prompt or losing unrelated frontmatter", () => {
  const body = "\r\n# 中文角色\r\n  缩进与末尾空格  \r\n\r\n";
  const parsed = parseRoleDocument("---\r\nmode: 'append' # mode\r\nmodel: \"model#1\"\r\nreasoningOptionId: high\r\nserviceTierId: priority\r\nnote: keep\r\n---\r\n" + body);
  expect(parsed).toEqual({ body, mode: "append", model: "model#1", reasoningOptionId: "high", serviceTierId: "priority", extraHeader: "note: keep" });
  const saved = serializeRoleDocument({ ...parsed, mode: "override", reasoningOptionId: null, serviceTierId: null });
  expect(parseRoleDocument(saved)).toEqual({ ...parsed, mode: "override", reasoningOptionId: null, serviceTierId: null });
  expect(saved.endsWith(body)).toBe(true);
});

it("saves and clears independent role settings through the editor RPC and leaves global content intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-role-editor-"));
  const globalDir = join(root, "global");
  await mkdir(globalDir);
  const globalContent = "---\nmodel: example\nreasoningOptionId: high\nserviceTierId: priority\n---\n# Worker\n";
  await writeFile(join(globalDir, "worker.md"), globalContent);
  const roles = new RoleService({ globalDir });
  const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
  try {
    const { workspaceId } = await service.addWorkspace({ rootPath: root });
    const rpc = createWorkbenchRpcHandler(service);
    const params = { workspaceId, roleId: "worker" };
    const globalDocument = { ...parseRoleDocument(globalContent), mode: "global" as const };
    const document = { ...parseRoleDocument(globalContent), mode: "append" as const, body: "\n# 项目\n正文  \n" };
    expect(await rpc({ method: "role.editor.read", params })).toEqual({ ok: true, result: { document: globalDocument, source: "global", globalDocument } });
    expect(await rpc({ method: "role.editor.write", params: { ...params, document } })).toEqual({ ok: true, result: {} });
    expect(await rpc({ method: "role.editor.read", params })).toEqual({ ok: true, result: { document, source: "workspace", globalDocument } });
    const overrideDocument = { ...document, mode: "override" as const, body: globalDocument.body };
    expect(await rpc({ method: "role.editor.write", params: { ...params, document: overrideDocument } })).toEqual({ ok: true, result: {} });
    expect(await rpc({ method: "role.editor.read", params })).toEqual({ ok: true, result: { document: overrideDocument, source: "workspace", globalDocument } });
    const file = await readFile(join(root, ".vermillion/roles/worker.md"), "utf8");
    expect(file).toBe('---\nmode: "override"\nmodel: "example"\nreasoningOptionId: "high"\nserviceTierId: "priority"\n---\n' + globalDocument.body);
    expect(await rpc({ method: "role.editor.write", params: { ...params, document: globalDocument } })).toEqual({ ok: true, result: {} });
    expect(await rpc({ method: "role.editor.read", params })).toEqual({ ok: true, result: { document: globalDocument, source: "global", globalDocument } });
    await expect(readFile(join(root, ".vermillion/roles/worker.md"), "utf8")).rejects.toThrow();
    expect(await readFile(join(globalDir, "worker.md"), "utf8")).toBe(globalContent);
    expect(await roles.resolve(root, "worker")).toEqual({ content: globalDocument.body, modelConfig: { modelId: "example", reasoningOptionId: "high", serviceTierId: "priority" } });
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
