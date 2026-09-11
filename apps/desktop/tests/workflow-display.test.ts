import { describe, expect, it } from "vitest";
import type { WorkflowAction, WorkItem } from "@vermillion/workbench/client";
import { actionRoleLabel, actionStatusText, integrationFailureSummary, integrationProgress, integrationShortStatus, waitingActions } from "../src/ui/app/components/workflow-display.js";

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

  it("shows integration retry progress and the delegated worker state", () => {
    const retry = { actionId: "merge", kind: "integration", workItemId: "one", status: "retry", attempts: 2, retryAt: "2026-01-01T00:00:00.000Z", updatedAt: "3" } as WorkflowAction;
    const delegated = { ...retry, status: "running", agent: { sessionId: "worker", requestedAt: "now", deliveredAt: "later" } } as WorkflowAction;
    expect(integrationProgress(retry)).toBe("合入失败 · 自动重试第 2/4 次");
    expect(integrationShortStatus(retry)).toBe("等待重试");
    expect(integrationFailureSummary({ ...retry, failure: "Command failed\nerror: Your local changes to the following files would be overwritten by merge:\n\tresult.txt\nPlease commit" } as WorkflowAction)).toBe("主工作区有未提交修改：result.txt");
    expect(actionStatusText(delegated)).toBe("Agent 处理合入");
    expect(actionRoleLabel(delegated)).toBe("Worker");
  });
});
