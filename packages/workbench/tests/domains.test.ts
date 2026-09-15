import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocsService } from "../src/docs.js";
import { Orchestrator, type AgentRunner } from "../src/orchestrator.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { git, setup } from "./workflow-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });

const createDomain = async (fixture: Awaited<ReturnType<typeof setup>>, id = "ui-ux") => {
  await fixture.client.request("docs.write", { workspaceId: fixture.workspaceId, path: `.vermillion/docs/domains/${id}.md`, content: `---
standards:
  - .vermillion/docs/Foundation/UIUX/Standards.md
---
# UI/UX

桌面界面和交互。
` });
  await fixture.client.request("docs.write", { workspaceId: fixture.workspaceId, path: ".vermillion/docs/Foundation/UIUX/Standards.md", content: "# UI/UX 规范\n\n保留草稿。\n" });
  await fixture.client.request("docs.commit", { workspaceId: fixture.workspaceId, message: "Add domain" });
};

describe("domain owner patrols", () => {
  it("lists only direct domain definitions and persists independent configuration and instructions", async () => {
    const fixture = await setup(); fixtures.push(fixture);
    await createDomain(fixture);
    await fixture.client.request("docs.write", { workspaceId: fixture.workspaceId, path: ".vermillion/docs/domains/acceptance/Standards.md", content: "# Not a domain\n" });
    const recursiveList = vi.spyOn(DocsService.prototype, "list");
    const directList = vi.spyOn(DocsService.prototype, "listDirectMarkdown");
    const [domain] = await fixture.client.request("domain.list", { workspaceId: fixture.workspaceId });
    expect(directList).toHaveBeenCalledWith(".vermillion/docs/domains");
    expect(recursiveList).not.toHaveBeenCalled();
    directList.mockRestore();
    recursiveList.mockRestore();
    expect(domain).toMatchObject({ domainId: "ui-ux", title: "UI/UX", summary: "桌面界面和交互。",
      standards: [".vermillion/docs/Foundation/UIUX/Standards.md"], config: { enabled: true, intervalHours: 6, autoWorkEnabled: false } });
    expect(await fixture.client.request("domain.list", { workspaceId: fixture.workspaceId })).toHaveLength(1);

    const value = { ...domain!.config, intervalHours: 12, triggerPaths: ["apps/desktop/src/ui/"], autoWorkEnabled: true,
      authorizationScope: ["恢复规范已明确的草稿保留行为"] };
    const saved = await fixture.client.request("domain.config.set", { workspaceId: fixture.workspaceId, domainId: "ui-ux", value });
    expect(saved).toMatchObject({ intervalHours: 12, triggerPaths: ["apps/desktop/src/ui"], autoWorkEnabled: true });
    await fixture.client.request("domain.instruction.write", { workspaceId: fixture.workspaceId, domainId: "ui-ux", content: "# UI 巡检\n\n检查草稿。\n" });
    expect(await fixture.client.request("domain.instruction.read", { workspaceId: fixture.workspaceId, domainId: "ui-ux" }))
      .toEqual({ content: "# UI 巡检\n\n检查草稿。\n" });
    expect((await fixture.service.resolveMaintainer(fixture.workspaceId, "ui-ux")).content).toContain("检查草稿");

    const restarted = new WorkbenchService(fixture.options);
    try {
      expect(await restarted.getDomainConfig(fixture.workspaceId, "ui-ux")).toMatchObject({ intervalHours: 12, autoWorkEnabled: true });
      expect(await restarted.readMaintainerInstruction(fixture.workspaceId, "ui-ux")).toContain("检查草稿");
    } finally { await restarted.dispose(); }
  });

  it("detects relevant committed changes and records a scheduled skip when nothing needs review", async () => {
    let clock = "2026-09-12T00:00:00.000Z";
    const fixture = await setup(() => clock); fixtures.push(fixture);
    await createDomain(fixture);
    const domain = (await fixture.client.request("domain.list", { workspaceId: fixture.workspaceId }))[0]!;
    await fixture.client.request("domain.config.set", { workspaceId: fixture.workspaceId, domainId: domain.domainId, value: {
      ...domain.config, triggerPaths: ["src"], intervalHours: 6
    } });
    await mkdir(join(fixture.root, "src"));
    await writeFile(join(fixture.root, "src", "change.ts"), "export const changed = true;\n", "utf8");
    await git(fixture.root, "add", "src/change.ts");
    await git(fixture.root, "commit", "-qm", "Change source");
    const [change] = await fixture.client.request("domain.patrol.scan", { workspaceId: fixture.workspaceId });
    expect(change).toMatchObject({ domainId: domain.domainId, trigger: "change", status: "queued", changedPaths: ["src/change.ts"] });
    await fixture.service.startPatrolRun(fixture.workspaceId, change!.patrolRunId, "maintainer-session");
    await fixture.service.failPatrolRun(fixture.workspaceId, change!.patrolRunId, "Engine unavailable");
    const failedConfig = await fixture.client.request("domain.config.get", { workspaceId: fixture.workspaceId, domainId: domain.domainId });
    expect(failedConfig.lastCommit).toBe(domain.config.lastCommit);
    expect(failedConfig.retryAt).toBe("2026-09-12T00:01:00.000Z");
    expect(await fixture.client.request("domain.patrol.scan", { workspaceId: fixture.workspaceId })).toEqual([]);

    clock = "2026-09-12T00:02:00.000Z";
    const [retry] = await fixture.client.request("domain.patrol.scan", { workspaceId: fixture.workspaceId });
    expect(retry).toMatchObject({ trigger: "change", status: "queued", changedPaths: ["src/change.ts"] });
    await fixture.service.startPatrolRun(fixture.workspaceId, retry!.patrolRunId, "maintainer-session-2");
    await fixture.client.request("domain.patrol.complete", { workspaceId: fixture.workspaceId, patrolRunId: retry!.patrolRunId,
      sessionId: "maintainer-session-2", issueIds: [], summary: "No issues" });

    clock = "2026-09-12T07:00:00.000Z";
    const [skipped] = await fixture.client.request("domain.patrol.scan", { workspaceId: fixture.workspaceId });
    expect(skipped).toMatchObject({ trigger: "scheduled", status: "skipped", summary: "无新变更或待复查问题，跳过。" });
  });

  it("only creates automatic work from the active authorized patrol with fixed requirements and evidence", async () => {
    const fixture = await setup(); fixtures.push(fixture);
    await createDomain(fixture);
    const domain = (await fixture.client.request("domain.list", { workspaceId: fixture.workspaceId }))[0]!;
    const run = await fixture.client.request("domain.patrol.run", { workspaceId: fixture.workspaceId, domainId: domain.domainId });
    await fixture.service.startPatrolRun(fixture.workspaceId, run.patrolRunId, "maintainer-session");
    const head = await git(fixture.root, "rev-parse", "HEAD");
    const issue = await fixture.client.request("issue.create", { workspaceId: fixture.workspaceId, title: "Draft disappears", summary: "Observed mismatch",
      domainId: domain.domainId, source: "maintainer", sourceSessionId: "maintainer-session",
      requirement: { text: "Keep the draft", path: ".vermillion/docs/Foundation/UIUX/Standards.md", section: "Draft", commit: head },
      evidence: [{ kind: "reproduced", text: "Draft cleared after tab switch", path: "Session -> Domain -> Session" }] });
    const work = { workspaceId: fixture.workspaceId, patrolRunId: run.patrolRunId, sessionId: "maintainer-session", issueId: issue.issueId,
      authorizationReason: "The configured permission covers restoring draft retention", expectedBehavior: "Draft remains after switching tabs",
      title: "Restore draft retention", objective: "Restore the documented behavior", risk: "R2" as const,
      refs: [{ path: issue.requirement!.path!, section: issue.requirement!.section, commit: head }],
      scope: { inScope: ["Retain the current draft"], outOfScope: ["Cross-device drafts"], allowedPaths: ["apps/desktop/src/ui/"] },
      acceptance: [{ text: "Type a draft, switch tabs, and return; the draft remains." }], needs: [], dependsOn: [] };
    await expect(fixture.client.request("domain.issue.workItem.create", work)).rejects.toThrow("未启用自动开单");
    await fixture.client.request("domain.config.set", { workspaceId: fixture.workspaceId, domainId: domain.domainId, value: {
      ...domain.config, autoWorkEnabled: true, authorizationScope: ["恢复规范已明确的草稿保留行为"]
    } });
    const moving = await fixture.client.request("issue.create", { workspaceId: fixture.workspaceId, title: "Moving requirement", summary: "Bad ref",
      domainId: domain.domainId, source: "maintainer", requirement: { text: "Keep the draft", path: issue.requirement!.path, commit: "HEAD" },
      evidence: [{ kind: "static", text: "Known mismatch" }] });
    await expect(fixture.client.request("domain.issue.workItem.create", { ...work, issueId: moving.issueId,
      refs: [{ path: issue.requirement!.path!, commit: "HEAD" }] })).rejects.toThrow("不可漂移");
    const item = await fixture.client.request("domain.issue.workItem.create", work);
    expect(item).toMatchObject({ issueId: issue.issueId, sourceSessionId: "maintainer-session", status: "queued", owner: { domainId: domain.domainId, patrolRunId: run.patrolRunId,
      expectedBehavior: "Draft remains after switching tabs" } });
    expect(item.run.sessionId).toBeUndefined();
    expect(await fixture.client.request("issue.get", { workspaceId: fixture.workspaceId, issueId: issue.issueId }))
      .toMatchObject({ status: "started", workItemIds: [item.workItemId] });
    expect(await fixture.client.request("domain.patrol.get", { workspaceId: fixture.workspaceId, patrolRunId: run.patrolRunId }))
      .toMatchObject({ workItemIds: [item.workItemId] });
  });

  it("opens a real maintainer role session through the orchestrator and requires explicit completion", async () => {
    const fixture = await setup(); fixtures.push(fixture);
    await createDomain(fixture);
    await fixture.client.request("domain.instruction.write", { workspaceId: fixture.workspaceId, domainId: "ui-ux", content: "Check UI draft retention." });
    const sent: string[] = [];
    let completed: ((event: { sessionId: string; turnId: string; finishReason: "completed" | "interrupted" | "failed"; failure?: string }) => void) | undefined;
    const runner: AgentRunner = {
      open: vi.fn(async (input) => { expect(input.metadata).toEqual(expect.objectContaining({ role: "maintainer", domainId: "ui-ux" })); return { sessionId: "patrol-session" }; }),
      fork: vi.fn(), resume: vi.fn(async () => true), steer: vi.fn(), interrupt: vi.fn(), release: vi.fn(),
      send: vi.fn(async (_sessionId, content) => { sent.push(content); return { turnId: "turn-1" }; }),
      isActive: vi.fn(() => false), onTurnCompleted: (listener) => { completed = listener; return () => { completed = undefined; }; }
    };
    const orchestrator = new Orchestrator({ service: fixture.service, roles: fixture.roles, runner, patrolIntervalMs: 60_000 });
    expect(await fixture.service.resolveSessionInstructions(fixture.workspaceId, { role: "maintainer", domainId: "ui-ux" }))
      .toContain("Check UI draft retention.");
    orchestrator.start();
    const run = await fixture.client.request("domain.patrol.run", { workspaceId: fixture.workspaceId, domainId: "ui-ux" });
    await vi.waitFor(() => expect(sent[0]).toContain("domain.patrol.complete"));
    expect(await fixture.client.request("domain.patrol.get", { workspaceId: fixture.workspaceId, patrolRunId: run.patrolRunId }))
      .toMatchObject({ status: "running", sessionId: "patrol-session", turnId: "turn-1" });
    await fixture.client.request("domain.patrol.complete", { workspaceId: fixture.workspaceId, patrolRunId: run.patrolRunId,
      sessionId: "patrol-session", issueIds: [], summary: "Checked" });
    completed?.({ sessionId: "patrol-session", turnId: "turn-1", finishReason: "completed" });
    await vi.waitFor(() => expect(runner.release).toHaveBeenCalledWith("patrol-session"));
    expect((await fixture.client.request("domain.patrol.get", { workspaceId: fixture.workspaceId, patrolRunId: run.patrolRunId })).status).toBe("completed");
    await orchestrator.dispose();
  });
});
