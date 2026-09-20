import { describe, expect, it } from "vitest";
import type { WorkRequest } from "@vermillion/workbench/client";
import { currentWorkStatus } from "../src/ui/app/components/task-labels.js";

const request: WorkRequest = { requestId: "work", sourceSessionId: "source", status: "preparing", createdAt: "2026-09-21", updatedAt: "2026-09-21" };

describe("current work status", () => {
  it.each(["quota exceeded", "connection reset", "429 Too Many Requests"])("uses interruption for %s rather than a cause-specific state", (failure) => {
    expect(currentWorkStatus(undefined, { ...request, status: "failed", failure, control: "manual" })).toEqual({ kind: "interrupted", label: "已中断" });
  });
  it("keeps pause and explicit decisions ahead of a previous failure", () => {
    expect(currentWorkStatus(undefined, { ...request, failure: "quota exceeded", control: "paused" }).kind).toBe("paused");
    expect(currentWorkStatus(undefined, { ...request, status: "failed", failure: "quota exceeded" }, true).kind).toBe("decision");
  });
  it("does not confuse delivery uncertainty or manual continuation with a failure", () => {
    expect(currentWorkStatus(undefined, { ...request, control: "manual", pendingMessageId: "message", waitReason: "受理状态不明" }).kind).toBe("confirmation");
    expect(currentWorkStatus(undefined, { ...request, control: "manual" }).kind).toBe("manual");
    expect(currentWorkStatus(undefined, { ...request, control: "manual", activeTurnId: "new-turn", failure: "old failure" }).kind).toBe("manual");
  });
});
