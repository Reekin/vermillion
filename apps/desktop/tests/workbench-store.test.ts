import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchClient, WorkbenchEvent, WorkItem } from "@vermillion/workbench/client";
import { createWorkbenchStore } from "../src/ui/app/workbench-store.js";

const item = (workItemId: string, status: WorkItem["status"], treeId?: string) => ({ workItemId, title: workItemId, status, treeId }) as WorkItem;

const setup = (data: Record<string, { items: WorkItem[] }>) => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  let listener: (event: WorkbenchEvent) => void;
  const request = vi.fn(async (method: string, params: { workspaceId?: string }) => {
    if (method === "workspace.list") return Object.keys(data).map((workspaceId) => ({ workspaceId, label: workspaceId }));
    if (method === "workItem.list") return data[params.workspaceId!]!.items;
    return [];
  });
  const store = createWorkbenchStore({ request, subscribe: (fn) => { listener = fn; return () => undefined; } } as WorkbenchClient);
  store.getState().connect();
  return { store, request, emit: (event: WorkbenchEvent) => listener(event) };
};

afterEach(() => vi.unstubAllGlobals());

describe("global task summary", () => {
  it("counts every unfinished work item across source trees and workspaces", async () => {
    const { store, request } = setup({
      a: { items: [item("p", "preparing", "tree-a"), item("q", "queued", "tree-a"), item("r", "running", "tree-a"), item("closed", "closed")] },
      b: { items: [item("m", "merging"), item("d", "decision"), item("cancel", "cancelled")] }
    });
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(5));
    expect(store.getState().tasks.map((task) => task.id)).toEqual(["p", "q", "r", "m", "d"]);
    expect(request.mock.calls.some(([method]) => method.startsWith("mission."))).toBe(false);
  });

  it("refreshes other workspaces from events and drops a superseded summary response", async () => {
    const data = { a: { items: [] as WorkItem[] }, b: { items: [item("b", "running")] } };
    const { store, request, emit } = setup(data);
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(1));
    expect(store.getState().browsingWorkspaceId).toBe("a");
    let release!: (value: WorkItem[]) => void;
    request.mockImplementationOnce(() => new Promise<WorkItem[]>((resolve) => { release = resolve; }));
    emit({ type: "workItems.changed", workspaceId: "b" });
    data.b.items = [];
    emit({ type: "workItems.changed", workspaceId: "b" });
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(0));
    release([item("stale", "queued")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().tasks).toHaveLength(0);
  });

  it("opens a task in its workspace without losing global commit feedback", async () => {
    const { store } = setup({ a: { items: [] }, b: { items: [] } });
    await vi.waitFor(() => expect(store.getState().workspaces).toHaveLength(2));
    store.getState().setDocCommit({ kind: "commit", commit: "abc", message: "说明" });
    store.getState().showTask({ workspaceId: "b", kind: "workItem", id: "target" });
    expect(store.getState()).toMatchObject({ panel: "workbench", workspaceSection: "workItems", overlay: undefined, browsingWorkspaceId: "b", taskTarget: { id: "target" }, docCommit: { message: "说明" } });
  });
});
