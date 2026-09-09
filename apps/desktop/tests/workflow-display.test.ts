import { describe, expect, it } from "vitest";
import type { WorkflowAction, WorkItem } from "@vermillion/workbench/client";
import { actionRoleLabel, waitingActions } from "../src/ui/app/components/workflow-display.js";

describe("execution and integration presentation", () => {
  it("associates retry and decision records with their single work item", () => {
    const actions = [
      { actionId: "worker", kind: "execute", workItemId: "one", status: "retry", updatedAt: "2" },
      { actionId: "merge", kind: "integration", workItemId: "one", status: "decision", updatedAt: "3" },
      { actionId: "running", kind: "execute", workItemId: "one", status: "running", updatedAt: "4" },
      { actionId: "elsewhere", kind: "integration", workItemId: "two", status: "retry", updatedAt: "5" }
    ] as WorkflowAction[];
    expect(waitingActions(actions, { workItemId: "one" } as WorkItem).map((action) => action.actionId)).toEqual(["merge", "worker"]);
    expect(actionRoleLabel(actions[0]!)).toBe("Worker");
    expect(actionRoleLabel(actions[1]!)).toBe("工作台");
  });
});
