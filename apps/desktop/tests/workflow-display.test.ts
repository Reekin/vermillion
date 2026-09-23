import { describe, expect, it } from "vitest";
import type { AgentRun, WorkflowAction, WorkItem } from "@vermillion/workbench/client";
import { actionRoleLabel, actionStatusText, integrationFailureSummary, integrationProgress, integrationShortStatus, waitingActions, workItemEvents, workItemProgress } from "../src/ui/app/components/workflow-display.js";

describe("execution and integration presentation", () => {
  it("associates blocked actions with their single work item", () => {
    const actions = [
      { actionId: "worker", kind: "execute", workItemId: "one", status: "decision", updatedAt: "2" },
      { actionId: "merge", kind: "integration", workItemId: "one", status: "decision", updatedAt: "3" },
      { actionId: "running", kind: "execute", workItemId: "one", status: "running", updatedAt: "4" },
      { actionId: "elsewhere", kind: "integration", workItemId: "two", status: "decision", updatedAt: "5" }
    ] as WorkflowAction[];
    expect(waitingActions(actions, { workItemId: "one" } as WorkItem).map((action) => action.actionId)).toEqual(["merge", "worker"]);
    expect(actionRoleLabel(actions[0]!)).toBe("Worker");
    expect(actionRoleLabel(actions[1]!)).toBe("工作台");
  });

  it("shows blocked integration and the delegated worker state", () => {
    const retry = { actionId: "merge", kind: "integration", workItemId: "one", status: "decision", updatedAt: "3" } as WorkflowAction;
    const delegated = { ...retry, status: "running", agent: { sessionId: "worker", requestedAt: "now", deliveredAt: "later" } } as WorkflowAction;
    expect(integrationProgress(retry)).toBe("合入受阻");
    expect(integrationShortStatus(retry)).toBe("待处置");
    expect(integrationFailureSummary({ ...retry, failure: "Command failed\nerror: Your local changes to the following files would be overwritten by merge:\n\tresult.txt\nPlease commit" } as WorkflowAction)).toBe("主工作区有未提交修改：result.txt");
    expect(actionStatusText(delegated)).toBe("等待 Worker 处理合入");
    expect(actionRoleLabel(delegated)).toBe("Worker");
  });

  it("explains the distinct returned-work stages from durable execution facts", () => {
    const item = { workItemId: "one", status: "queued", dependsOn: [], rejections: [{ reason: "Worker must commit its worktree before integration.", at: "2026-01-01T00:00:00.000Z" }], run: { sessionId: "worker" } } as WorkItem;
    const execute = { actionId: "worker", kind: "execute", workItemId: "one", status: "pending", stage: "deliver", updatedAt: "2026-01-01T00:00:01.000Z", notices: [] } as WorkflowAction;
    const activeRun = { runId: "run", sessionId: "worker", workItemId: "one", status: "running", turns: 1, startedAt: "2026-01-01T00:00:00.000Z" } as AgentRun;
    const returned = workItemProgress(item, [execute], activeRun);
    expect(returned.shortLabel).toBe("退回待续做");
    expect(returned.title).toBe("提交已退回");
    expect(returned.next).toContain("当前 turn 结束");

    const waiting = workItemProgress(item, [execute], { ...activeRun, status: "done", endedAt: "2026-01-01T00:00:02.000Z" });
    expect(waiting.shortLabel).toBe("等待调度续接");
    expect(waiting.handler).toBe("工作台");

    const activeReturn = workItemProgress(item, [{ ...execute, status: "running", stage: "execute" } as WorkflowAction], activeRun, []);
    expect(activeReturn.shortLabel).toBe("退回待续做");
    expect(activeReturn.handler).toBe("当前 Worker 会话");
  });

  it("does not let closed dependencies hide the current queued reason", () => {
    const item = { workItemId: "one", status: "queued", dependsOn: ["done"], rejections: [{ reason: "合入发生冲突，需要处理后继续。", at: "2026-01-01T00:00:00.000Z" }], run: { sessionId: "worker" } } as WorkItem;
    const execute = { actionId: "worker", kind: "execute", workItemId: "one", status: "pending", stage: "deliver", updatedAt: "2026-01-01T00:00:01.000Z", notices: [] } as WorkflowAction;
    expect(workItemProgress(item, [execute], undefined, []).shortLabel).toBe("等待调度续接");
    expect(workItemProgress(item, [execute], undefined, ["done"]).shortLabel).toBe("等待前置工单");
  });

  it("turns workflow history into readable events without internal stage names", () => {
    const item = { workItemId: "one", status: "closed", rejections: [{ reason: "Worker must commit its worktree before integration.", at: "2026-01-01T00:00:02.000Z" }], merge: { commit: "abcdef0123456789", diffStat: "", mergedAt: "2026-01-01T00:00:04.000Z" }, run: { sessionId: "worker" } } as WorkItem;
    const actions = [{ actionId: "merge-old", kind: "integration", workItemId: "one", status: "done", stage: "merge", updatedAt: "2026-01-01T00:00:04.000Z", history: [
      { at: "2026-01-01T00:00:01.000Z", event: "created", message: "验收通过" },
      { at: "2026-01-01T00:00:02.000Z", event: "failed:merge", message: "Worker must commit its worktree before integration." }
    ] }, { actionId: "merge-new", kind: "integration", workItemId: "one", status: "done", stage: "merge", updatedAt: "2026-01-01T00:00:04.000Z", history: [
      { at: "2026-01-01T00:00:03.000Z", event: "created", message: "重新提交，验收通过" }
    ] } as WorkflowAction];
    const events = workItemEvents(item, actions, []);
    expect(events.map((event) => event.title)).toEqual(["合入完成", "提交验收通过，开始合入", "合入检查未通过", "提交已退回", "提交验收通过，开始合入"]);
    expect(events.every((event) => !event.title.includes("stage") && !event.title.includes("done"))).toBe(true);
  });

  it("does not expose internal work-item stage messages in event details", () => {
    const item = { workItemId: "one", status: "closed", dependsOn: [], rejections: [], run: {} } as WorkItem;
    const actions = [{ actionId: "worker", kind: "execute", workItemId: "one", status: "done", stage: "execute", updatedAt: "2026-01-01T00:00:02.000Z", notices: [], history: [
      { at: "2026-01-01T00:00:01.000Z", event: "resolved", message: "工单已进入 merging" }
    ] } as WorkflowAction];
    expect(workItemEvents(item, actions, [])[0]?.detail).toBe("本轮执行已交接后续处理。");
    expect(workItemEvents(item, [], [{ runId: "run", sessionId: "worker", workItemId: "one", status: "done", turns: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:02.000Z", note: "工单已进入 merging" } as AgentRun])[0]?.detail).toBe("本轮执行已交接后续处理。");
  });

  it("labels a resolved handoff caused by a merge failure as a failed check", () => {
    const item = { workItemId: "one", status: "queued", dependsOn: [], rejections: [], run: {} } as WorkItem;
    const actions = [{ actionId: "merge", kind: "integration", workItemId: "one", status: "done", stage: "merge", updatedAt: "2026-01-01T00:00:02.000Z", history: [
      { at: "2026-01-01T00:00:01.000Z", event: "resolved", message: "转回原 Worker：Worker must commit its worktree before integration." }
    ] } as WorkflowAction];
    expect(workItemEvents(item, actions, [])[0]?.title).toBe("合入检查未通过");
  });

  it("puts the closed result, commit, and verification count in current progress", () => {
    const item = { workItemId: "one", status: "closed", dependsOn: [], acceptance: [{ text: "one" }, { text: "two" }], evidence: { summary: "成果摘要", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [], submittedAt: "2026-01-01T00:00:00.000Z" }, verify: { items: [{ index: 0, status: "pass", evidence: "ok" }], verdict: "pass", verifiedAt: "2026-01-01T00:00:00.000Z" }, merge: { commit: "abcdef0123456789", diffStat: "", mergedAt: "2026-01-01T00:00:01.000Z" }, rejections: [], run: {} } as WorkItem;
    const progress = workItemProgress(item, []);
    expect(progress.reason).toContain("成果摘要");
    expect(progress.reason).toContain("abcdef0123456789");
    expect(progress.reason).toContain("1 / 2 通过");
  });
});
