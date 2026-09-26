// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineModelRpc } from "@vermillion/shared";
import type { DomainDefinition, PatrolRun, RoleFile, WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import { RolesSection, describeRoles, roleModelLabel } from "../src/ui/app/components/RolesSection.js";
import { DomainsSection, groupPatrolRuns, resolveDocLink, skippedSummary } from "../src/ui/app/components/DomainsSection.js";

afterEach(cleanup);

const run = (id: string, startedAt: string, status: PatrolRun["status"], extra: Partial<PatrolRun> = {}): PatrolRun => ({
  patrolRunId: id, domainId: "work-execution", trigger: "scheduled", status, changedPaths: [], requirementRefs: [],
  issueIds: [], workItemIds: [], startedAt, updatedAt: startedAt, ...extra
});

const offlineTransport = {
  settings: { get: () => Promise.reject(new Error("offline")) },
  engine: { list: () => Promise.resolve([]), listModels: () => Promise.resolve([]) }
} as unknown as DesktopTransport;

describe("role list presentation", () => {
  it("orders known roles by the work loop and names effective models with their reasoning", () => {
    const roles: RoleFile[] = [
      { roleId: "zeta", title: "Zeta Role", source: "global", mode: "global" },
      { roleId: "worker", title: "Worker", source: "workspace", mode: "append" },
      { roleId: "design-partner", title: "设计伙伴", source: "global", mode: "global" }
    ];
    expect(describeRoles(roles).map((role) => role.name)).toEqual(["设计伙伴", "Worker", "Zeta Role"]);
    const models = [{ modelId: "gpt-x", displayName: "GPT-X", reasoningOptions: [{ optionId: "high", displayName: "High" }] }] as unknown as EngineModelRpc[];
    expect(roleModelLabel({ modelId: "gpt-x", reasoningOptionId: "high" }, models)).toEqual({ model: "GPT-X", reasoning: "High" });
    expect(roleModelLabel({ modelId: "unknown-model" }, models)).toEqual({ model: "unknown-model" });
    expect(roleModelLabel(undefined, models)).toEqual({ model: "沿用输入器配置" });
  });

  it("shows mode names, opens the editor on row click and resets a customized role from its menu", async () => {
    const request = vi.fn().mockResolvedValue({});
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<RolesSection client={{ request } as unknown as WorkbenchClient} transport={offlineTransport} workspaceId="ws" onEdit={onEdit} roles={[
      { roleId: "worker", title: "Worker", source: "workspace", mode: "append", modelConfig: { modelId: "opus-5", reasoningOptionId: "medium" } },
      { roleId: "verifier", title: "Verifier", source: "workspace", mode: "override" },
      { roleId: "liaison", title: "Liaison", source: "global", mode: "global" }
    ]} />);
    expect(screen.getByText("3 个角色 · 2 个在本 workspace 有定制")).toBeTruthy();
    const worker = screen.getByRole("button", { name: "编辑角色：Worker" });
    expect(within(worker).getByText("追加正文")).toBeTruthy();
    expect(worker.textContent).toContain("opus-5 · medium");
    expect(within(screen.getByRole("button", { name: "编辑角色：Verifier" })).getByText("覆盖正文")).toBeTruthy();
    await user.click(worker);
    expect(onEdit).toHaveBeenCalledWith("worker");
    await user.click(screen.getByRole("button", { name: "更多操作：Worker" }));
    await user.click(await screen.findByRole("menuitem", { name: "恢复全局" }));
    expect(request).toHaveBeenCalledWith("role.reset", { workspaceId: "ws", roleId: "worker" });
    await user.click(screen.getByRole("button", { name: "更多操作：Liaison" }));
    expect((await screen.findByRole<HTMLButtonElement>("menuitem", { name: "恢复全局" })).disabled).toBe(true);
  });
});

describe("domain patrol records", () => {
  it("collapses consecutive skipped patrols and keeps findings between them", () => {
    const runs = [
      run("a", "2026-09-15T09:00:00.000Z", "skipped"),
      run("b", "2026-09-14T21:00:00.000Z", "skipped"),
      run("c", "2026-09-14T09:00:00.000Z", "skipped"),
      run("d", "2026-09-13T09:00:00.000Z", "completed", { issueIds: ["i1", "i2"] }),
      run("e", "2026-09-12T09:00:00.000Z", "skipped")
    ];
    const entries = groupPatrolRuns(runs);
    expect(entries.map((entry) => entry.kind === "skipped" ? entry.runs.map((item) => item.patrolRunId) : entry.run.patrolRunId)).toEqual([["a", "b", "c"], "d", ["e"]]);
    const first = entries[0]!;
    expect(first.kind === "skipped" && skippedSummary(first.runs)).toMatch(/^9月1[45]日 至 9月1[56]日 连续 3 次无新变更，已跳过$/);
  });

  it("resolves relative document links inside .vermillion/docs only", () => {
    const path = ".vermillion/docs/domains/work-execution.md";
    expect(resolveDocLink(path, "../Foundation/Development/PRD.md#准备")).toBe(".vermillion/docs/Foundation/Development/PRD.md");
    expect(resolveDocLink(path, "../../../docs/development.md")).toBeUndefined();
    expect(resolveDocLink(path, "https://example.com")).toBeUndefined();
  });
});

describe("DomainsSection", () => {
  const domain: DomainDefinition = {
    domainId: "work-execution", title: "工单执行与恢复", summary: "", path: ".vermillion/docs/domains/work-execution.md",
    standards: [".vermillion/docs/Workbench/Missions/Standards.md"],
    config: { domainId: "work-execution", enabled: false, changeTrigger: true, intervalHours: 6, triggerPaths: [], autoWorkEnabled: false, authorizationScope: [],
      nextRunAt: "2026-09-26T12:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }
  };

  it("renders the definition as Markdown, opens linked docs and states every patrol setting", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "docs.read") return { content: "---\nstandards: []\n---\n# 工单执行与恢复\n\n也覆盖[隔离实例准备](../Foundation/Acceptance/PRD.md)。\n" };
      if (method === "domain.config.set") return { ...domain.config, ...(params.value as object) };
      return {};
    });
    const onOpenDoc = vi.fn();
    const onOpenIssues = vi.fn();
    const user = userEvent.setup();
    render(<DomainsSection client={{ request } as unknown as WorkbenchClient} workspaceId="ws" workspaceRoot="I:/project" domains={[domain]}
      issues={[]} onOpenDoc={onOpenDoc} onOpenInstruction={vi.fn()} onOpenSession={vi.fn()} onOpenIssues={onOpenIssues}
      patrolRuns={[run("a", "2026-09-15T09:00:00.000Z", "skipped"), run("b", "2026-09-14T09:00:00.000Z", "skipped"), run("c", "2026-09-13T09:00:00.000Z", "completed", { issueIds: ["i1"], summary: "发现 1 个问题" })]} />);
    const link = await screen.findByRole("link", { name: "隔离实例准备" });
    expect(screen.queryByText(/\]\(/)).toBeNull();
    await user.click(link);
    expect(onOpenDoc).toHaveBeenCalledWith(".vermillion/docs/Foundation/Acceptance/PRD.md");
    expect(screen.getByText("自动巡检未启用")).toBeTruthy();
    expect(screen.getByText("当前关闭")).toBeTruthy();
    expect(screen.getByText("已开启 · 0 个触发目录")).toBeTruthy();
    expect(screen.getByText("当前关闭 · 授权范围 0 项")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "自动巡检" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("domain.config.set", expect.objectContaining({ value: expect.objectContaining({ enabled: true }) })));
    expect(screen.getByText(/连续 2 次无新变更，已跳过/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "1 个 Issue" }));
    expect(onOpenIssues).toHaveBeenCalledWith("work-execution");
  });
});
