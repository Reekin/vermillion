import { describe, expect, it } from "vitest";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { branchesStatus, treeBranches } from "../src/ui/mobile/branches.js";

const node = (nodeId: string, sessionId: string, order: number, parentNodeId?: string, extra: object = {}) =>
  ({ nodeId, turnId: nodeId, sessionId, order, parentNodeId, label: nodeId, isCurrent: false, status: "completed", ...extra });

describe("mobile branch list", () => {
  it("lists each member once, nested under the branch it forked from, with its latest message and state", () => {
    const tree = {
      sessionId: "root", treeId: "root", engineId: "codex", fetchedAt: "",
      nodes: [
        node("r1", "root", 0), node("r2", "root", 1, "r1"), node("r3", "root", 5, "r2"),
        node("p1", "prep", 2, "r2"),
        node("w1", "worker", 3, "p1", { status: "pending" }),
        node("w2", "worker-b", 4, "p1", { unread: true }),
        node("m1", "supervisor", 6, "p1")
      ]
    } as ChatTreeSnapshotRpc;
    const branches = treeBranches(tree, new Set(["supervisor"]));
    expect(branches.map((branch) => [branch.sessionId, branch.depth])).toEqual([["root", 0], ["prep", 1], ["worker", 2], ["worker-b", 2]]);
    expect(branches[0]).toMatchObject({ firstLabel: "r1", lastLabel: "r3", running: false, unread: false });
    expect(branches[2]).toMatchObject({ running: true });
    expect(branchesStatus(branches)).toBe("running");
    expect(branchesStatus(branches.filter((branch) => !branch.running))).toBe("unread_completed");
  });
});
