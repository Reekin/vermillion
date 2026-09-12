import { afterEach, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkbenchService, type IssueDiscussionStarter } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const fixture = async () => { const value = await setup(); fixtures.push(value); return value; };
afterEach(async () => { for (const value of fixtures.splice(0)) await value.cleanup(); });

it("persists issue triage, evidence, resolutions and workspace isolation", async () => {
  const f = await fixture();
  const otherRoot = join(f.root, "other");
  await mkdir(otherRoot);
  const other = await f.service.addWorkspace({ rootPath: otherRoot, label: "Other" });
  const issue = await f.client.request("issue.create", {
    workspaceId: f.workspaceId, title: "Draft disappears", summary: "Switching pages clears the draft", domainId: "ui-ux",
    source: "maintainer", requirement: { text: "Keep the draft", path: ".vermillion/docs/PRD.md", commit: "abc" },
    evidence: [{ kind: "reproduced", text: "Typed, switched pages, returned to an empty input" }]
  });
  expect(issue).toMatchObject({ status: "open", unread: true, source: "maintainer" });
  await f.client.request("issue.update", { workspaceId: f.workspaceId, issueId: issue.issueId, status: "investigating",
    appendEvidence: [{ kind: "static", text: "Composer unmounts with the page" }] });
  await expect(f.client.request("issue.update", { workspaceId: f.workspaceId, issueId: issue.issueId, status: "closed" })).rejects.toThrow("处理原因");
  const closed = await f.client.request("issue.update", { workspaceId: f.workspaceId, issueId: issue.issueId, status: "closed", resolutionReason: "Fixed and verified" });
  expect(closed).toMatchObject({ status: "closed", resolutionReason: "Fixed and verified", evidence: [{ kind: "reproduced" }, { kind: "static" }] });
  expect(await f.client.request("issue.list", { workspaceId: other.workspaceId })).toEqual([]);

  const restarted = new WorkbenchService(f.options);
  try { expect(await restarted.getIssue(f.workspaceId, issue.issueId)).toMatchObject({ status: "closed", workItemIds: [] }); }
  finally { await restarted.dispose(); }
});

it("reuses an issue discussion and links work created from that session", async () => {
  const f = await fixture();
  const start: IssueDiscussionStarter = vi.fn(async () => ({ sessionId: "issue-discussion", turnId: "turn-1" }));
  const service = new WorkbenchService({ ...f.options, issueDiscussionStarter: start });
  try {
    const issue = await service.createIssue(f.workspaceId, { title: "Known mismatch", summary: "Observed behavior differs", domainId: "ui-ux",
      requirement: { text: "Expected behavior" }, evidence: [{ kind: "reproduced", text: "Observed mismatch" }] });
    expect(await service.discussIssue(f.workspaceId, issue.issueId)).toMatchObject({ discussionSessionId: "issue-discussion", discussionTurnId: "turn-1" });
    await service.discussIssue(f.workspaceId, issue.issueId);
    expect(start).toHaveBeenCalledTimes(1);

    const item = await service.createWorkItem(f.workspaceId, { ...contract, sourceSessionId: "issue-discussion" });
    expect(item.issueId).toBe(issue.issueId);
    expect(await service.getIssue(f.workspaceId, issue.issueId)).toMatchObject({ status: "started", unread: true, workItemIds: [item.workItemId] });
  } finally { await service.dispose(); }
});

it("does not infer an issue without a real source session or allow a fake started state", async () => {
  const f = await fixture();
  const issue = await f.service.createIssue(f.workspaceId, { title: "Unrelated", summary: "Open issue", domainId: "ui-ux" });
  await expect(f.service.updateIssue(f.workspaceId, issue.issueId, { status: "started" })).rejects.toThrow("实际工单");
  await expect(f.service.createIssue(f.workspaceId, { title: "Fake start", summary: "No work", domainId: "ui-ux", status: "started" })).rejects.toThrow("实际工单");
  const item = await f.service.createWorkItem(f.workspaceId, contract);
  expect(item.issueId).toBeUndefined();
  expect(await f.service.getIssue(f.workspaceId, issue.issueId)).toMatchObject({ status: "open", workItemIds: [] });
});

it("requires a real duplicate target and records the original issue", async () => {
  const f = await fixture();
  const original = await f.service.createIssue(f.workspaceId, { title: "Original", summary: "First", domainId: "ui-ux" });
  const duplicate = await f.service.createIssue(f.workspaceId, { title: "Duplicate", summary: "Second", domainId: "ui-ux" });
  await expect(f.service.updateIssue(f.workspaceId, duplicate.issueId, { status: "duplicate", resolutionReason: "Same problem", duplicateOf: "missing" })).rejects.toThrow("Unknown issue");
  expect(await f.service.updateIssue(f.workspaceId, duplicate.issueId, { status: "duplicate", resolutionReason: "Same problem", duplicateOf: original.issueId }))
    .toMatchObject({ status: "duplicate", duplicateOf: original.issueId });
});
