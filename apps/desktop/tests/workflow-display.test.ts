import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowAction } from "@vermillion/workbench/client";
import { formatDuration } from "../src/i18n/format.js";
import { setLocale } from "../src/i18n/index.js";
import { actionRoleLabel, actionStatusText, executionDuration, integrationFailureSummary, integrationProgress, integrationShortStatus, readableFailure, waitingActions, workItemEvents, workItemProgress, workItemSteps } from "../src/ui/app/components/workflow-display.js";
import { agentRun, execution, integration, workItem } from "./workbench-fixtures.js";

afterEach(() => setLocale("zh"));

describe("execution and integration presentation", () => {
  it("associates blocked actions with their single work item", () => {
    const actions: WorkflowAction[] = [
      execution({ actionId: "worker", workItemId: "one", status: "decision", updatedAt: "2" }),
      integration({ actionId: "merge", workItemId: "one", status: "decision", updatedAt: "3" }),
      execution({ actionId: "running", workItemId: "one", status: "running", updatedAt: "4" }),
      integration({ actionId: "elsewhere", workItemId: "two", status: "decision", updatedAt: "5" })
    ];
    expect(waitingActions(actions, workItem({ workItemId: "one" })).map((action) => action.actionId)).toEqual(["merge", "worker"]);
    expect(actionRoleLabel(actions[0]!)).toBe("Worker");
    expect(actionRoleLabel(actions[1]!)).toBe("工作台");
  });

  it("shows blocked integration and the delegated worker state", () => {
    const retry = integration({ actionId: "merge", workItemId: "one", status: "decision", updatedAt: "3" });
    const delegated = integration({ ...retry, status: "running", agent: { sessionId: "worker", requestedAt: "now" } });
    expect(integrationProgress(retry)).toBe("合入受阻");
    expect(integrationShortStatus(retry)).toBe("待处置");
    expect(integrationFailureSummary({ ...retry, failure: "Command failed\nerror: Your local changes to the following files would be overwritten by merge:\n\tresult.txt\nPlease commit" })).toBe("主工作区有未提交修改：result.txt");
    expect(actionStatusText(delegated)).toBe("等待 Worker 处理合入");
    expect(actionRoleLabel(delegated)).toBe("Worker");
  });

  it("explains the distinct returned-work stages from durable execution facts", () => {
    const item = workItem({ workItemId: "one", status: "queued", rejections: [{ reason: "Worker must commit its worktree before integration.", at: "2026-01-01T00:00:00.000Z" }], run: { sessionId: "worker" } });
    const execute = execution({ actionId: "worker", workItemId: "one", status: "pending", stage: "deliver", updatedAt: "2026-01-01T00:00:01.000Z" });
    const activeRun = agentRun({ runId: "run", sessionId: "worker", workItemId: "one", status: "running", turns: 1, startedAt: "2026-01-01T00:00:00.000Z" });
    const returned = workItemProgress(item, [execute], activeRun);
    expect(returned.shortLabel).toBe("退回待续做");
    expect(returned.title).toBe("提交已退回");
    expect(returned.next).toContain("当前一轮结束");

    const waiting = workItemProgress(item, [execute], { ...activeRun, status: "done", endedAt: "2026-01-01T00:00:02.000Z" });
    expect(waiting.shortLabel).toBe("等待调度续接");
    expect(waiting.handler).toBe("工作台");

    const activeReturn = workItemProgress(item, [execution({ ...execute, status: "running", stage: "execute" })], activeRun, []);
    expect(activeReturn.shortLabel).toBe("退回待续做");
    expect(activeReturn.handler).toBe("当前 Worker 会话");
  });

  it("does not let closed dependencies hide the current queued reason", () => {
    const item = workItem({ workItemId: "one", status: "queued", dependsOn: ["done"], rejections: [{ reason: "合入发生冲突，需要处理后继续。", at: "2026-01-01T00:00:00.000Z" }], run: { sessionId: "worker" } });
    const execute = execution({ actionId: "worker", workItemId: "one", status: "pending", stage: "deliver", updatedAt: "2026-01-01T00:00:01.000Z" });
    expect(workItemProgress(item, [execute], undefined, []).shortLabel).toBe("等待调度续接");
    expect(workItemProgress(item, [execute], undefined, ["done"]).shortLabel).toBe("等待前置工单");
  });

  it("turns workflow history into readable events without internal stage names", () => {
    const item = workItem({ workItemId: "one", status: "closed", rejections: [{ reason: "Worker must commit its worktree before integration.", at: "2026-01-01T00:00:02.000Z" }], merge: { commit: "abcdef0123456789", diffStat: "", mergedAt: "2026-01-01T00:00:04.000Z" }, run: { sessionId: "worker" } });
    const actions = [integration({ actionId: "merge-old", workItemId: "one", status: "done", stage: "merge", updatedAt: "2026-01-01T00:00:04.000Z", history: [
      { at: "2026-01-01T00:00:01.000Z", event: "created", message: "验收通过" },
      { at: "2026-01-01T00:00:02.000Z", event: "failed:merge", message: "Worker must commit its worktree before integration." }
    ] }), integration({ actionId: "merge-new", workItemId: "one", status: "done", stage: "merge", updatedAt: "2026-01-01T00:00:04.000Z", history: [
      { at: "2026-01-01T00:00:03.000Z", event: "created", message: "重新提交，验收通过" }
    ] })];
    const events = workItemEvents(item, actions, []);
    expect(events.map((event) => event.title)).toEqual(["合入完成", "提交验收通过，开始合入", "合入检查未通过", "提交已退回", "提交验收通过，开始合入"]);
    expect(events.every((event) => !event.title.includes("stage") && !event.title.includes("done"))).toBe(true);
  });

  it("does not expose internal work-item stage messages in event details", () => {
    const item = workItem({ workItemId: "one", status: "closed" });
    const actions = [execution({ actionId: "worker", workItemId: "one", status: "done", stage: "execute", updatedAt: "2026-01-01T00:00:02.000Z", history: [
      { at: "2026-01-01T00:00:01.000Z", event: "resolved", message: { code: "workItem.closedAs", params: { status: "merging" } } }
    ] })];
    expect(workItemEvents(item, actions, [])[0]?.detail).toBe("本轮执行已交接后续处理。");
  });

  it("labels a merge voided by a newer contract as a failed check", () => {
    const item = workItem({ workItemId: "one", status: "queued" });
    const actions = [integration({ actionId: "merge", workItemId: "one", status: "done", stage: "merge", updatedAt: "2026-01-01T00:00:02.000Z", history: [
      { at: "2026-01-01T00:00:01.000Z", event: "resolved", message: { code: "merge.voided", params: { current: 2, basis: 1 } } }
    ] })];
    expect(workItemEvents(item, actions, [])[0]?.title).toBe("合入检查未通过");
    expect(workItemEvents(item, actions, [])[0]?.detail).toContain("合入作废：合同已更新为修订 2");
  });

  it("puts the closed result, commit, and verification count in current progress", () => {
    const item = workItem({ workItemId: "one", status: "closed", acceptance: [{ text: "one" }, { text: "two" }], evidence: { summary: "成果摘要", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [], submittedAt: "2026-01-01T00:00:00.000Z" }, verify: { items: [{ index: 0, status: "pass", evidence: "ok" }], verdict: "pass", verifiedAt: "2026-01-01T00:00:00.000Z" }, merge: { commit: "abcdef0123456789", diffStat: "", mergedAt: "2026-01-01T00:00:01.000Z" } });
    const progress = workItemProgress(item, []);
    expect(progress.reason).toContain("成果摘要");
    expect(progress.reason).toContain("abcdef0123456789");
    expect(progress.reason).toContain("1 / 2 通过");
  });

  it("maps raw failures to a cause and next step without engine wording", () => {
    expect(readableFailure("turn interrupted")).toEqual({ title: "本轮执行被中断", next: "重试后从原会话继续。" });
    expect(readableFailure({ code: "turn.executionFailed" })).toEqual({ title: "执行轮失败", next: "打开详情查看原始原因。" });
    expect(readableFailure('turn failed: {"error":{"type":"invalid_request_error","message":"The reasoning_content is missing"}}').title).toBe("模型请求失败：The reasoning_content is missing");
    expect(readableFailure("Command failed: git worktree remove x\n fatal: busy").title).toBe("Git 操作失败");
    expect(readableFailure("something odd")).toEqual({ title: "执行遇到问题", next: "打开详情查看原始原因。" });
  });

  it("drops internal run notes and turn wording from events", () => {
    const item = workItem({ workItemId: "one", status: "closed", merge: { commit: "abcdef0123456789", diffStat: "", mergedAt: "2026-01-01T00:00:04.000Z" } });
    const events = workItemEvents(item, [], [agentRun({ runId: "run", sessionId: "worker", workItemId: "one", status: "done", turns: 2, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:02.000Z", note: "done" })]);
    expect(events.map((event) => event.detail)).toEqual(["成果已进入主分支 · abcdef0", undefined, "共 2 轮"]);
    expect(JSON.stringify(events)).not.toMatch(/turn|done/);
  });

  it("draws the lifecycle with passed-stage times and the current wait on the current stage", () => {
    const actions = [execution({ actionId: "exec", workItemId: "one", createdAt: "2026-01-01T01:00:00.000Z", startedAt: "2026-01-01T01:00:00.000Z" }), integration({ actionId: "merge", workItemId: "one", createdAt: "2026-01-01T02:00:00.000Z" })];
    const closed = workItemSteps(workItem({ workItemId: "one", status: "closed", merge: { diffStat: "", mergedAt: "2026-01-01T03:00:00.000Z" } }), actions, []);
    expect(closed.map((step) => [step.label, step.state])).toEqual([["排队", "done"], ["执行", "done"], ["待合入", "done"], ["已关闭", "done"]]);
    expect(closed.every((step) => step.time)).toBe(true);
    const waiting = workItemSteps(workItem({ workItemId: "one", status: "running" }), actions.slice(0, 1), [], { title: "已暂停", next: "", action: "resume" });
    expect(waiting.map((step) => step.state)).toEqual(["done", "current", "pending", "pending"]);
    expect(waiting[1]).toMatchObject({ tone: "attention", note: "已暂停" });
    const running = workItemSteps(workItem({ workItemId: "one", status: "running" }), actions.slice(0, 1), [], undefined, "执行");
    expect(running[1]).toMatchObject({ state: "current", tone: "running", note: undefined });
    expect(workItemSteps(workItem({ workItemId: "one", status: "queued" }), [], [], undefined, "等待前置工单")[0]!.note).toBe("等待前置工单");
    const cancelled = workItemSteps(workItem({ workItemId: "one", status: "cancelled" }), actions.slice(0, 1), []);
    expect(cancelled[1]).toMatchObject({ state: "current", tone: "failed", note: "已取消" });
  });

  it("times execution from the first accepted delivery to the last submission, without the queue wait", () => {
    const actions = [
      execution({ actionId: "exec", workItemId: "one", createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T01:00:00.000Z", deliveredAt: "2026-01-01T01:50:00.000Z" }),
      integration({ actionId: "merge-1", workItemId: "one", createdAt: "2026-01-01T01:30:00.000Z" }),
      integration({ actionId: "merge-2", workItemId: "one", createdAt: "2026-01-01T02:00:00.000Z" })
    ];
    const closed = workItem({ workItemId: "one", status: "closed", merge: { diffStat: "", mergedAt: "2026-01-01T02:05:00.000Z" } });
    expect(executionDuration(closed, actions, [])).toBe(60 * 60 * 1000);
    const running = workItem({ workItemId: "one", status: "running" });
    expect(executionDuration(running, actions.slice(0, 1), [], Date.parse("2026-01-01T01:10:00.000Z"))).toBe(10 * 60 * 1000);
    expect(executionDuration(workItem({ workItemId: "one", status: "queued" }), [], [])).toBeUndefined();
  });

  it("writes durations in readable Chinese units", () => {
    expect(formatDuration(45_000)).toBe("45秒");
    expect(formatDuration(87_000)).toBe("1分钟27秒");
    expect(formatDuration(52 * 60_000)).toBe("52分钟");
    expect(formatDuration(185 * 60_000)).toBe("3小时5分钟");
  });

  it("follows the interface language", () => {
    setLocale("en");
    expect(integrationProgress(integration({ actionId: "merge", workItemId: "one", status: "decision" }))).toBe("Merge blocked");
    expect(readableFailure("turn interrupted")).toEqual({ title: "This turn was interrupted", next: "Retry to continue in the original session." });
    expect(workItemSteps(workItem({ workItemId: "one", status: "queued" }), [], [])[0]!.label).toBe("Queued");
  });
});
