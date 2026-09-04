import type { WorkspaceSource } from "./workbench-service.js";

/** In-memory WorkspaceSource for tests and standalone tooling. */
export const createMemoryWorkspaceSource = (now: () => string = () => new Date().toISOString()): WorkspaceSource => {
  const records: Array<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }> = [];
  return {
    list: async () => [...records],
    register: async (input) => {
      const existing = records.find((r) => r.rootPath === input.rootPath);
      if (existing) return existing;
      const record = {
        workspaceId: "ws-" + (records.length + 1),
        rootPath: input.rootPath,
        label: input.label ?? input.rootPath,
        createdAt: now(),
        updatedAt: now()
      };
      records.push(record);
      return record;
    },
    remove: async (workspaceId) => {
      const index = records.findIndex((r) => r.workspaceId === workspaceId);
      if (index >= 0) records.splice(index, 1);
    }
  };
};
