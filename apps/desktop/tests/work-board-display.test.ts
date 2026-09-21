import { describe, expect, it } from "vitest";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { workBoardGroups, workBoardCounts } from "../src/ui/app/components/work-board-display.js";
import { workRequestStatus } from "../src/ui/app/components/task-labels.js";

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const item = (id: string, status: WorkItem["status"], day: number, treeId?: string, requestId?: string): WorkItem => ({
  workItemId: id, title: id, status, updatedAt: at(day), createdAt: at(1), treeId, requestId,
  risk: "R2", objective: "", contractRevision: 0, scope: { inScope: [], outOfScope: [], allowedPaths: [] },
  refs: [], acceptance: [], needs: [], dependsOn: [], review: [], rejections: [], decisions: [], run: { attempts: 0 }
});
const request = (id: string, status: WorkRequest["status"], day: number, treeId?: string): WorkRequest => ({
  requestId: id, sourceSessionId: "source", treeId, status, updatedAt: at(day), createdAt: at(1)
});

describe("work board projection", () => {
  it("keeps each tree together and orders each level by open state then latest change", () => {
    const requests = [request("older", "ready", 2, "a"), request("newer", "ready", 5, "a"), request("prep", "preparing", 8, "b")];
    const items = [item("closed-new", "closed", 20, "a", "older"), item("active-old", "running", 3, "a", "older"),
      item("waiting-new", "queued", 6, "a", "older"), item("newer-child", "decision", 5, "a", "newer"),
      item("independent", "queued", 7, "a"), item("ended-tree", "closed", 22, "c"), item("no-tree", "cancelled", 23)];
    const groups = workBoardGroups(requests, items);
    expect(groups.map((g) => g.id)).toEqual(["a", "b", "standalone", "c"]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["older", "independent", "newer"]);
    const work = groups[0]!.entries[0]!;
    expect(work.updatedAt).toBe(at(20));
    expect(work.kind === "work" && work.items.map((i) => i.workItemId)).toEqual(["waiting-new", "active-old", "closed-new"]);
    expect(items.map((i) => i.workItemId)).toEqual(["closed-new", "active-old", "waiting-new", "newer-child", "independent", "ended-tree", "no-tree"]);
  });

  it("retains cancelled requests and assigns their children exactly once", () => {
    const groups = workBoardGroups([request("cancelled", "cancelled", 5, "tree"), request("empty", "cancelled", 6)],
      [item("child", "cancelled", 4, "tree", "cancelled"), item("orphan", "queued", 7, "tree", "absent")]);
    expect(groups.map((g) => g.id)).toEqual(["tree", "standalone"]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["orphan", "cancelled"]);
    expect(groups.flatMap((g) => g.entries.flatMap((e) => e.kind === "work" ? e.items : [e.item])).map((i) => i.workItemId)).toEqual(["orphan", "child"]);
  });

  it("reorders on updates and resolves equal timestamps deterministically", () => {
    const a = item("a", "queued", 2, "a"), b = item("b", "running", 2, "b");
    expect(workBoardGroups([], [b, a]).map((g) => g.id)).toEqual(["a", "b"]);
    expect(workBoardGroups([], [{ ...b, updatedAt: at(3) }, a]).map((g) => g.id)).toEqual(["b", "a"]);
    expect(workBoardGroups([], [{ ...b, status: "closed", updatedAt: at(3) }, a]).map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("aggregates completed, cancelled, mixed and waiting work accurately", () => {
    const r = request("work", "ready", 2, "tree");
    const done = item("done", "closed", 3), cancelled = item("cancelled", "cancelled", 4);
    expect(workRequestStatus(r, [done])).toEqual({ label: "已完成", status: "closed" });
    expect(workRequestStatus(r, [cancelled])).toEqual({ label: "已取消", status: "cancelled" });
    expect(workRequestStatus(r, [done, cancelled])).toEqual({ label: "部分完成", status: "closed" });
    expect(workRequestStatus(r, [{ ...done, status: "queued", run: { attempts: 0, control: "paused" } }]).label).toBe("已暂停");
    expect(workRequestStatus(request("prep", "preparing", 2), []).status).not.toBe("running");
  });

  it("counts actual preparation and child executions without counting their parent work twice", () => {
    const requests = [request("work", "ready", 2), { ...request("prep", "preparing", 3), activeTurnId: "turn" }];
    const active = { ...item("active", "running", 3, "tree", "work"), run: { attempts: 0, activeTurnId: "child-turn" } };
    expect(workBoardCounts(requests, [active, item("done", "closed", 4, "tree", "work"), item("waiting", "decision", 5)]))
      .toEqual({ active: 2, waiting: 1, ended: 1 });
  });
});
