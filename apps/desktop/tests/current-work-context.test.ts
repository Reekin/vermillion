import { describe, expect, it } from "vitest";
import type { DecisionCard, WorkflowAction, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { currentWorkContext, decisionsForWork } from "../src/ui/app/current-work-context.js";

const request = { formatVersion: 2, requestId: "request", workerSessionId: "old", sourceSessionId: "design", status: "ready" } as WorkRequest;
const moved = { workItemId: "item", requestId: "request", status: "queued", run: { sessionId: "new" } } as WorkItem;

describe("current work ownership projection", () => {
  it("does not bind the source design discussion merely because it started work", () => {
    expect(currentWorkContext([moved], [request], "design")).toEqual({});
  });
  it("keeps ordinary forks unbound and preserves completed results", () => {
    const closed = { workItemId: "closed", status: "closed", run: { sessionId: "old" } } as WorkItem;
    expect(currentWorkContext([closed, moved], [request], "fork")).toEqual({});
    expect(currentWorkContext([closed, moved], [request], "old")).toEqual({ item: closed });
    expect(currentWorkContext([moved], [request], "new")).toMatchObject({ item: moved });
  });
  it("keeps active preparation ahead of its preregistered first item", () => {
    const preparing = { ...request, status: "preparing" as const };
    const child = { ...moved, status: "preparing" as const, run: { sessionId: "old" } };
    expect(currentWorkContext([child], [preparing], "old")).toEqual({ request: preparing, item: child });
  });
  it("shows a finished result when there is no active work", () => {
    const closed = { ...moved, status: "closed" as const, run: { sessionId: "old" } };
    expect(currentWorkContext([closed], [request], "old")).toEqual({ item: closed });
    expect(decisionsForWork([{ workItemId: closed.workItemId, sessionId: "old" } as DecisionCard], [], { item: closed }, "old")).toEqual([]);
  });
  it("keeps decisions on their owning work without absorbing sibling decisions", () => {
    const cards = [
      { decisionId: "own", workItemId: "item", requestId: "request", sessionId: "old" },
      { decisionId: "sibling", workItemId: "other", requestId: "request", sessionId: "old" },
      { decisionId: "action-only", actionId: "action", sessionId: "old" }
    ] as DecisionCard[];
    const actions = [{ actionId: "action", workItemId: "item" }] as WorkflowAction[];
    const context = currentWorkContext([moved], [request], "new");
    expect(decisionsForWork(cards, actions, context, "new").map((card) => card.decisionId)).toEqual(["own", "action-only"]);
    expect(decisionsForWork(cards, actions, currentWorkContext([moved], [request], "old"), "old")).toEqual([]);
  });
});
