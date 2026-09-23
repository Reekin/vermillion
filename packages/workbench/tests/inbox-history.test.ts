import { expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup, submission } from "./workflow-fixture.js";

it("queries durable processed messages without returning them to the pending Inbox", async () => {
  const f = await setup();
  const service = new WorkbenchService({ ...f.options, sessionSteerer: async ({ sessionId }) => ({ sessionId, accepted: true, turnId: "decision-answer" }) });
  try {
    const card = await service.createDecision(f.workspaceId, {
      sessionId: "decision-session", question: "选哪个？", context: "选择展示方式", options: [{ key: "go", label: "继续" }]
    });
    const item = await service.createWorkItem(f.workspaceId, { ...contract, sessionId: "worker" });
    await service.startWorkItem(f.workspaceId, item.workItemId, { sessionId: "worker" });
    await service.submitWorkItem(f.workspaceId, item.workItemId, { ...submission, sessionId: "worker" });
    expect(await f.client.request("inbox.list", {})).toHaveLength(2);
    await service.answerDecision(f.workspaceId, card.decisionId, { key: "go", note: "按此处理" });
    await f.service.acknowledgeWorkItem(f.workspaceId, item.workItemId);
    expect(await f.client.request("inbox.list", {})).toEqual([]);
    const history = await f.client.request("inbox.list", { includeProcessed: true });
    expect(history).toMatchObject([
      { kind: "decision", card: { answer: { key: "go", note: "按此处理" } } },
      { kind: "merged", workItem: { evidence: { summary: "Result available" }, merge: { acknowledgedAt: expect.any(String) } } }
    ]);
    await f.service.dispose();
    const restarted = new WorkbenchService(f.options);
    try {
      expect(await restarted.listInbox()).toEqual([]);
      expect(await restarted.listInbox(true)).toEqual(history);
    } finally { await restarted.dispose(); }
  } finally { await service.dispose(); await f.cleanup(); }
});
