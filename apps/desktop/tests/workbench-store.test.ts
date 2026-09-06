import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mission, WorkbenchClient, WorkbenchEvent, WorkItem } from "@vermillion/workbench/client";
import { createWorkbenchStore } from "../src/ui/app/workbench-store.js";

const mission = (missionId: string, status: Mission["status"] = "active") => ({ missionId, title: missionId, status }) as Mission;
const item = (workItemId: string, status: WorkItem["status"], missionId?: string) => ({ workItemId, title: workItemId, status, missionId }) as WorkItem;

const setup = (data: Record<string, { missions: Mission[]; items: WorkItem[] }>) => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  let listener: (event: WorkbenchEvent) => void;
  const request = vi.fn(async (method: string, params: { workspaceId?: string }) => {
    if (method === "workspace.list") return Object.keys(data).map((workspaceId) => ({ workspaceId, label: workspaceId }));
    if (method === "mission.list") return data[params.workspaceId!]!.missions;
    if (method === "workItem.list") return data[params.workspaceId!]!.items;
    return [];
  });
  const store = createWorkbenchStore({ request, subscribe: (fn) => { listener = fn; return () => undefined; } } as WorkbenchClient);
  store.getState().connect();
  return { store, request, emit: (event: WorkbenchEvent) => listener(event) };
};

afterEach(() => vi.unstubAllGlobals());

describe("global task summary", () => {
  it("counts active missions once, including empty/finished-child missions, and only open standalone items across workspaces", async () => {
    const { store } = setup({
      a: { missions: [mission("empty"), mission("finished-children"), mission("done", "done"), mission("cancelled", "cancelled")],
        items: [item("child", "closed", "finished-children"), item("cancelled-child", "cancelled", "finished-children"), item("orphan-active", "running", "done"), item("q", "queued"), item("closed", "closed")] },
      b: { missions: [mission("active")], items: [item("r", "running"), item("v", "review"), item("d", "decision"), item("cancel", "cancelled")] }
    });
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(7));
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["empty", "finished-children", "q", "active", "r", "v", "d"]);
    expect(store.getState().tasks.find((t) => t.id === "finished-children")?.progress).toBe("1/2");
    expect(store.getState().tasks.find((t) => t.id === "empty")?.progress).toBe("0/0");
  });

  it("refreshes other workspaces from events and drops a superseded summary response", async () => {
    const data = { a: { missions: [], items: [] }, b: { missions: [mission("b")], items: [] } };
    const { store, request, emit } = setup(data);
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(1));
    expect(store.getState().browsingWorkspaceId).toBe("a");
    let release!: (value: Mission[]) => void;
    request.mockImplementationOnce(() => new Promise<Mission[]>((resolve) => { release = resolve; }));
    emit({ type: "missions.changed", workspaceId: "b" });
    data.b.missions = [];
    emit({ type: "workItems.changed", workspaceId: "b" });
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(0));
    release([mission("stale")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().tasks).toHaveLength(0);
  });

  it("opens a task in its workspace without losing global commit feedback", async () => {
    const { store } = setup({ a: { missions: [], items: [] }, b: { missions: [], items: [] } });
    await vi.waitFor(() => expect(store.getState().workspaces).toHaveLength(2));
    store.getState().setDocCommit({ kind: "commit", commit: "abc", message: "说明" });
    store.getState().showTask({ workspaceId: "b", kind: "workItem", id: "target" });
    expect(store.getState()).toMatchObject({ overlay: "workspaces", browsingWorkspaceId: "b", taskTarget: { id: "target" }, docCommit: { message: "说明" } });
  });
});
