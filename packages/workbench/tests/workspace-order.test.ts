import { describe, expect, it } from "vitest";
import { RoleService } from "../src/roles.js";
import { WorkbenchService, type WorkspaceSource } from "../src/workbench-service.js";

const source = (records: Awaited<ReturnType<WorkspaceSource["list"]>>): WorkspaceSource => ({
  list: async () => records,
  register: async () => { throw new Error("unused"); },
  remove: async () => undefined
});

describe("workspace order", () => {
  it("lists the most recently active workspace first and idle ones by newest added", async () => {
    const service = new WorkbenchService({
      roles: new RoleService({ globalDir: "unused" }),
      workspaces: source([
        { workspaceId: "idle-old", rootPath: "X:/a", label: "a", createdAt: "2026-01-01T00:00:00Z" },
        { workspaceId: "active-old", rootPath: "X:/b", label: "b", createdAt: "2026-01-02T00:00:00Z", lastActiveAt: "2026-09-01T00:00:00Z" },
        { workspaceId: "idle-new", rootPath: "X:/c", label: "c", createdAt: "2026-03-01T00:00:00Z" },
        { workspaceId: "active-new", rootPath: "X:/d", label: "d", createdAt: "2026-01-03T00:00:00Z", lastActiveAt: "2026-09-20T00:00:00Z" }
      ])
    });

    expect((await service.listWorkspaces()).map((workspace) => workspace.workspaceId))
      .toEqual(["active-new", "active-old", "idle-new", "idle-old"]);
  });
});
