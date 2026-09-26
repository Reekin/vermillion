import { describe, expect, it } from "vitest";
import type { DecisionCard, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { ENDED_PREVIEW, filterShowing, visibleBoard, workBoard, workBoardAttentionCount, workBoardCounts, type BoardEntry } from "../src/ui/app/components/work-board-display.js";
import { workItemBoardLabel, workRequestStatus } from "../src/ui/app/components/task-labels.js";
import { integration } from "./workbench-fixtures.js";

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const item = (id: string, status: WorkItem["status"], day: number, treeId?: string, requestId?: string): WorkItem => ({
  workItemId: id, title: id, status, updatedAt: at(day), createdAt: at(1), treeId, requestId,
  risk: "R2", objective: "", contractRevision: 0, scope: { inScope: [], outOfScope: [], allowedPaths: [] },
  refs: [], acceptance: [], needs: [], dependsOn: [], review: [], rejections: [], decisions: [], run: {}
});
const request = (id: string, status: WorkRequest["status"], day: number, treeId?: string): WorkRequest => ({
  formatVersion: 2, requestId: id, sourceSessionId: "source", treeId, status, updatedAt: at(day), createdAt: at(1)
});
const board = (requests: WorkRequest[], items: WorkItem[], decisions: DecisionCard[] = [], actions = [] as Parameters<typeof workBoard>[0]["actions"]) =>
  workBoard({ requests, items, decisions, actions });
const ids = (entries: BoardEntry[]) => entries.map((entry) => entry.id);
const archived = "session 01a08d58-93c8-7413-9d3b-8bcb8c5fc7b8 is archived. Run `codex unarchive 01a08d58-93c8-7413-9d3b-8bcb8c5fc7b8` to unarchive it first.";

describe("work board projection", () => {
  it("keeps preparation in progress through partial creation, child cancellation and handoff turn exit", () => {
    const r = { ...request("prep", "preparing", 2, "tree"), activeTurnId: "turn" };
    const child = item("child", "preparing", 3, "tree", "prep");
    expect(workRequestStatus(r, [child])).toEqual({ label: "会话运行中", status: "running" });
    expect(board([r], [child])[0]!.section).toBe("active");
    expect(board([r], [{ ...child, status: "cancelled" }])[0]!.section).toBe("active");
    expect(workRequestStatus({ ...r, status: "ready" }, [child]).label).toBe("会话运行中");
    expect(board([{ ...r, status: "ready", activeTurnId: undefined }], [{ ...child, status: "closed" }])[0]!.section).toBe("ended");
  });

  it("reports interruption from runtime failure", () => {
    const failed = { ...item("failed", "running", 2), run: { lastFailure: "connection lost" } };
    expect(workItemBoardLabel(failed, "执行")).toBe("已中断");
  });

  it("groups by whether the user must act, newest first inside each group, each item exactly once", () => {
    const requests = [request("moving", "ready", 5, "a"), { ...request("paused-prep", "preparing", 3, "b"), paused: true }, request("done", "ready", 9, "a")];
    const items = [item("moving-child", "running", 6, "a", "moving"), item("done-child", "closed", 9, "a", "done"),
      item("standalone-open", "queued", 8), item("standalone-ended", "cancelled", 10), item("orphan", "queued", 4, "a", "absent")];
    const entries = board(requests, items);
    expect(entries.map((entry) => [entry.id, entry.section])).toEqual([
      ["paused-prep", "attention"],
      ["standalone-open", "active"], ["moving", "active"], ["orphan", "active"],
      ["standalone-ended", "ended"], ["done", "ended"]
    ]);
    const shownItems = entries.flatMap((entry) => entry.kind === "work" ? entry.items : [entry.item]).map((entry) => entry.workItemId);
    expect(shownItems.sort()).toEqual(items.map((entry) => entry.workItemId).sort());
    expect(workBoardCounts(entries)).toEqual({ attention: 1, active: 3, ended: 2 });
  });

  it("orders items inside a work by latest change and counts a multi-item work once", () => {
    const entries = board([request("work", "ready", 2)], [item("old", "running", 3, undefined, "work"), item("new", "queued", 7, undefined, "work"), item("closed", "closed", 5, undefined, "work")]);
    const work = entries[0]!;
    expect(work.kind === "work" && work.items.map((entry) => entry.workItemId)).toEqual(["new", "closed", "old"]);
    expect(work.updatedAt).toBe(at(7));
    expect(workBoardCounts(entries)).toEqual({ attention: 0, active: 1, ended: 0 });
  });

  it("turns an archived preparation session into a readable cause, next step and unarchive command", () => {
    const r = { ...request("prep", "failed", 2), paused: true, failure: archived, waitReason: "Historical execution is paused; review the migration backup before explicitly resuming." };
    const entry = board([r], [])[0]!;
    expect(entry.section).toBe("attention");
    expect(entry.attention).toMatchObject({ title: "会话已被 Codex 归档，无法继续。", next: "取消归档后点恢复即可继续。", action: "resume",
      command: "codex unarchive 01a08d58-93c8-7413-9d3b-8bcb8c5fc7b8", raw: archived });
    expect(board([{ ...r, paused: false }], [])[0]!.attention?.action).toBe("retry");
  });

  it("raises a child's problem to its work and names the item", () => {
    const decision: DecisionCard = { decisionId: "d", workItemId: "asks", question: "保留旧入口吗？", options: [{ key: "yes", label: "保留" }], createdAt: at(3) } as DecisionCard;
    const children = [item("fine", "running", 5, undefined, "work"), item("asks", "running", 4, undefined, "work")];
    const entry = board([request("work", "ready", 2)], children, [decision])[0]!;
    expect(entry.section).toBe("attention");
    expect(entry.attention).toMatchObject({ itemId: "asks", action: "decision", title: "等待你答复：保留旧入口吗？" });
    expect(board([request("work", "ready", 2)], children, [{ ...decision, answer: { key: "yes", at: at(4) } }])[0]!.section).toBe("active");
  });

  it("treats paused, stopped, failed, blocked-merge and unconfirmed items as needing the user", () => {
    const cases: Array<[WorkItem, string]> = [
      [{ ...item("paused", "running", 2), run: { paused: true } }, "resume"],
      [{ ...item("stopped", "running", 2), run: { userStopped: true } }, "resume"],
      [{ ...item("failed", "running", 2), run: { lastFailure: "turn interrupted" } }, "retry"],
      [{ ...item("unknown", "running", 2), run: { activeTurnId: "t", turnStatus: "unknown" } }, "session"],
      [item("blocked", "merging", 2), "detail"]
    ];
    const blocked = integration({ actionId: "merge", workItemId: "blocked", status: "decision", failure: "CONFLICT (content): Merge conflict in a.ts" });
    for (const [entry, action] of cases) expect(board([], [entry], [], [blocked])[0]!.attention?.action).toBe(action);
    expect(board([], [{ ...item("running", "running", 2), run: { activeTurnId: "t" } }])[0]!.section).toBe("active");
    expect(workBoardAttentionCount({ requests: [], items: cases.map(([entry]) => entry), decisions: [], actions: [blocked] })).toBe(5);
  });

  it("shows the latest ended entries in the default view and all of them in the ended view", () => {
    const ended = Array.from({ length: ENDED_PREVIEW + 3 }, (_, index) => item("ended-" + index, "closed", 10 + index));
    const entries = board([], [item("open", "queued", 2), ...ended]);
    const open = visibleBoard(entries, "open");
    expect(open.map((group) => [group.section, group.entries.length, group.total])).toEqual([["active", 1, 1], ["ended", ENDED_PREVIEW, ENDED_PREVIEW + 3]]);
    expect(ids(open[1]!.entries)[0]).toBe("ended-" + (ENDED_PREVIEW + 2));
    expect(visibleBoard(entries, "ended")[0]!.entries).toHaveLength(ENDED_PREVIEW + 3);
    expect(visibleBoard(entries, "attention")).toEqual([]);
    expect(visibleBoard(entries, "all", (entry) => entry.id.endsWith("-1")).map((group) => ids(group.entries))).toEqual([["ended-1"]]);
  });

  it("widens the filter only when the target item is hidden", () => {
    const ended = Array.from({ length: ENDED_PREVIEW + 1 }, (_, index) => item("ended-" + index, "closed", 10 + index));
    const entries = board([request("work", "ready", 2)], [item("child", "running", 3, undefined, "work"), ...ended]);
    expect(filterShowing(entries, "child", "open")).toBe("open");
    expect(filterShowing(entries, "child", "ended")).toBe("open");
    expect(filterShowing(entries, "ended-0", "open")).toBe("ended");
    expect(filterShowing(entries, "ended-5", "open")).toBe("open");
    expect(filterShowing(entries, "missing", "all")).toBe("all");
  });

  it.each([
    ["closed", "closed", "已完成"],
    ["cancelled", "cancelled", "已取消"],
    ["closed", "cancelled", "部分完成"]
  ] as const)("keeps paused work with %s/%s children ended in both grouping and labels", (first, second, label) => {
    const r = { ...request("work", "ready", 2, "ended"), paused: true };
    const children = [item("one", first, 3, "ended", "work"), item("two", second, 4, "ended", "work")];
    expect(board([r], [...children, item("waiting", "queued", 1, "open")]).map((entry) => [entry.id, entry.section])).toEqual([["waiting", "active"], ["work", "ended"]]);
    expect(workRequestStatus(r, children).label).toBe(label);
  });

  it("only shows a parent pause while preparation or a child remains unfinished", () => {
    const r = { ...request("work", "ready", 2), paused: true };
    expect(workRequestStatus(r, [item("waiting", "queued", 3)]).label).toBe("已暂停");
    expect(board([r], [item("waiting", "queued", 3, undefined, "work")])[0]!.attention?.title).toBe("工作已暂停");
    expect(workRequestStatus({ ...r, status: "preparing" }, []).label).toBe("已暂停");
    expect(workRequestStatus(r, []).label).toBe("已交接");
    expect(workRequestStatus({ ...r, status: "cancelled" }, []).label).toBe("已取消");
  });
});
