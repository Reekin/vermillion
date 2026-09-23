import { describe, expect, it } from "vitest";
import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { currentWorkStatus, workPhaseLabel, workSessionLabel, workRequestStatus } from "../src/ui/app/components/task-labels.js";

const request: WorkRequest = { formatVersion: 2, requestId: "work", sourceSessionId: "source", status: "preparing", createdAt: "2026-09-21", updatedAt: "2026-09-21" };
const item = (run: WorkItem["run"] = {}) => ({ status: "running", run } as WorkItem);

describe("task phase and live session facts", () => {
  it("does not paint an unfinished task as an active session", () => {
    expect(workPhaseLabel(item())).toBe("执行");
    expect(workSessionLabel(item())).toBe("会话已结束 · 尚未交付");
    expect(currentWorkStatus(item()).kind).not.toBe("running");
    expect(workRequestStatus({ ...request, status: "ready" }, [item()]).status).not.toBe("running");
  });
  it("distinguishes confirmed activity from an unconfirmed turn", () => {
    expect(currentWorkStatus(item({ activeTurnId: "turn", turnStatus: "active" })).kind).toBe("running");
    expect(currentWorkStatus(item({ activeTurnId: "turn", turnStatus: "unknown" })).kind).toBe("confirmation");
    expect(workSessionLabel(item({ activeTurnId: "turn", turnStatus: "unknown" }))).toBe("运行状态未确认");
  });
  it("keeps explicit pause, Stop, decisions and faults distinct", () => {
    expect(currentWorkStatus(item({ paused: true, lastFailure: "old failure" })).kind).toBe("paused");
    expect(currentWorkStatus(item({ userStopped: true, lastFailure: "interrupt" })).kind).toBe("stopped");
    expect(currentWorkStatus(item({ lastFailure: "connection lost" })).kind).toBe("interrupted");
    expect(currentWorkStatus(item({ lastFailure: "old failure" }), undefined, true).kind).toBe("decision");
    expect(workPhaseLabel(item({ userStopped: true }))).toBe("执行");
  });
  it("does not let an old fault obscure a live ordinary chat turn", () => {
    expect(workSessionLabel(item({ activeTurnId: "new", lastFailure: "old" }))).toBe("会话运行中");
    expect(currentWorkStatus(item({ activeTurnId: "new", lastFailure: "old" })).kind).toBe("running");
  });
  it("keeps preparation failures actionable without automatic retry state", () => {
    expect(currentWorkStatus(undefined, { ...request, status: "failed", failure: "offline" })).toEqual({ kind: "interrupted", label: "已中断" });
    expect(workPhaseLabel(undefined, { ...request, status: "failed" })).toBe("准备");
  });
});
