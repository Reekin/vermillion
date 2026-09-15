import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleService } from "../src/roles.js";
import { createMemoryWorkspaceSource } from "../src/memory-workspace-source.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { WorkbenchService } from "../src/workbench-service.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "verm-role-"));
  const globalDir = await mkdtemp(join(tmpdir(), "verm-global-role-"));
  dirs.push(root, globalDir);
  await writeFile(join(globalDir, "worker.md"), "---\nmodel: example\n---\n# Global\nGlobal instructions.\n");
  return { root, globalDir, roles: new RoleService({ globalDir }) };
};

describe("role prompt composition", () => {
  it.each(["", "---\nmode: override\n---\n"])("uses only the workspace body with header %j", async (header) => {
    const { root, roles } = await setup();
    await roles.writeOverride(root, "worker", header + "# Project\nProject instructions.\n");
    expect(await roles.resolve(root, "worker")).toEqual({ content: "# Project\nProject instructions.\n" });
  });

  it.each(["append", '"append"', "'append' # comment"])("appends with mode %s and preserves editable CRLF Markdown", async (mode) => {
    const { root, roles } = await setup();
    const raw = `---\r\nmode: ${mode}\r\n---\r\n# Project\r\nProject instructions.\r\n`;
    await roles.writeOverride(root, "worker", raw);
    expect((await roles.resolve(root, "worker")).content).toBe("# Global\nGlobal instructions.\n\n# Project\r\nProject instructions.");
    const editable = await roles.read(root, "worker");
    await roles.writeOverride(root, "worker", editable.content);
    expect(editable).toEqual({ content: raw, source: "workspace" });
    expect(await readFile(join(root, ".vermillion/roles/worker.md"), "utf8")).toBe(raw);
  });

  it("resolves the global body after reset and permits a project-only role", async () => {
    const { root, roles } = await setup();
    await roles.writeOverride(root, "worker", "---\nmode: append\n---\nProject");
    await roles.removeOverride(root, "worker");
    expect((await roles.resolve(root, "worker")).content).toBe("# Global\nGlobal instructions.\n");
    await roles.writeOverride(root, "custom", "---\nmode: append\n---\nProject");
    expect((await roles.resolve(root, "custom")).content).toBe("Project");
  });

  it("exposes raw and resolved content separately through RPC and rejects invalid modes before saving", async () => {
    const { root, roles } = await setup();
    const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
    try {
      const { workspaceId } = await service.addWorkspace({ rootPath: root, label: "Roles" });
      const rpc = createWorkbenchRpcHandler(service);
      const raw = "---\nmode: append\n---\nProject";
      const params = { workspaceId, roleId: "worker" };
      expect(await rpc({ method: "role.write", params: { ...params, content: raw } })).toEqual({ ok: true, result: {} });
      expect(await rpc({ method: "role.read", params })).toEqual({ ok: true, result: { content: raw, source: "workspace" } });
      expect(await rpc({ method: "role.resolve", params })).toEqual({ ok: true, result: { content: "# Global\nGlobal instructions.\n\nProject", modelConfig: { modelId: "example" } } });
      expect((await rpc({ method: "role.write", params: { ...params, content: "---\nmode: invalid\n---\nBad" } })).ok).toBe(false);
      expect((await roles.read(root, "worker")).content).toBe(raw);
    } finally {
      service.dispose();
    }
  });

  it("resolves current session instructions from role metadata without storing role text", async () => {
    const { root, globalDir, roles } = await setup();
    await Promise.all([
      writeFile(join(globalDir, "design-partner.md"), "# Design\nCurrent design role.\n"),
      writeFile(join(globalDir, "reviewer.md"), "# Reviewer\nReview current work.\n"),
      writeFile(join(globalDir, "verifier.md"), "# Verifier\nVerify current work.\n")
    ]);
    const service = new WorkbenchService({ workspaces: createMemoryWorkspaceSource(), roles });
    try {
      const { workspaceId } = await service.addWorkspace({ rootPath: root, label: "Roles" });
      const design = await service.resolveSessionInstructions(workspaceId, {});
      expect(design).toContain("Current design role.");
      expect(design).toContain(`当前 workspaceId: ${workspaceId}`);
      const worker = await service.resolveSessionInstructions(workspaceId, { role: "worker" });
      expect(worker).toContain("Global instructions.");
      expect(worker).toContain("## reviewer subagent prompt");
      expect(worker).toContain("Review current work.");
      expect(worker).toContain("## verifier subagent prompt");
      expect(worker).toContain("Verify current work.");
    } finally {
      service.dispose();
    }
  });
});
