// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scheduler, WorkbenchClient, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { WorkItemsSection } from "../src/ui/app/components/WorkItemsSection.js";
import { workItem } from "./workbench-fixtures.js";
afterEach(cleanup);

const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`;
const archived = "session 01a0 is archived. Run `codex unarchive 01a0` to unarchive it first.";
const requests: WorkRequest[] = [
  { formatVersion: 2, requestId: "stuck", sourceSessionId: "src-1", treeId: "tree-1", scope: "修改 Worker 规范", status: "failed", paused: true, failure: archived, createdAt: day(11), updatedAt: day(11) },
  { formatVersion: 2, requestId: "moving", sourceSessionId: "src-2", treeId: "tree-2", scope: "引擎配置警告", status: "ready", createdAt: day(20), updatedAt: day(20) }
];
const merged = workItem({
  workItemId: "merged", title: "隔离会话树实例", status: "closed", risk: "R2", sourceSessionId: "src-3", treeId: "tree-3", updatedAt: day(12),
  acceptance: [{ text: "单次返回可连接实例" }, { text: "父会话可展开" }],
  verify: { verdict: "pass", verifiedAt: day(12), items: [{ index: 0, status: "pass", evidence: "真实 CLI 单次返回 pid" }, { index: 1, status: "pass", evidence: "展开可见子会话" }] },
  evidence: { summary: "`app.start` 现在支持 fixture", commands: [], assumptions: [], untested: [], outOfScopeFindings: [], attachments: [], submittedAt: day(12) },
  merge: { commit: "5cb9327e11d47bb3adbfac8a", diffStat: "", mergedAt: day(12) }
});
const items: WorkItem[] = [
  workItem({ workItemId: "running", requestId: "moving", title: "显示引擎配置警告", status: "running", risk: "R2", updatedAt: day(21), run: { sessionId: "worker", activeTurnId: "t" } }),
  merged,
  ...Array.from({ length: 6 }, (_, index) => workItem({ workItemId: "old-" + index, title: "历史工单 " + index, status: "closed", updatedAt: day(1 + index) }))
];

const setup = () => {
  const request = vi.fn(async (method: string) => method === "decision.list" ? [] : {});
  const client = { request, subscribe: () => () => undefined } as unknown as WorkbenchClient;
  const onOpenSession = vi.fn();
  render(<WorkItemsSection client={client} workspaceId="ws" scheduler={{ enabled: true, maxWorkers: 2 } as Scheduler} workItems={items} workRequests={requests}
    runs={[]} actions={[]} decisions={[]} sourceTitles={{ "tree-1": "Worker 规范讨论", "tree-2": "通知整理" }} onOpenSession={onOpenSession}
    expandedWorkGroups={{}} setWorkGroupExpanded={vi.fn()} />);
  return { request, onOpenSession, user: userEvent.setup() };
};

describe("work board", () => {
  it("puts the stuck work first with a readable cause and working controls", async () => {
    const test = setup();
    const attention = screen.getByRole("region", { name: "需要你处理" });
    expect(within(attention).getByText("修改 Worker 规范")).toBeTruthy();
    expect(within(attention).getByText("会话已被 Codex 归档，无法继续。")).toBeTruthy();
    expect(within(attention).getByText("取消归档后点恢复即可继续。")).toBeTruthy();
    expect(attention.textContent).not.toContain("is archived");
    await test.user.click(within(attention).getByRole("button", { name: "恢复" }));
    expect(test.request).toHaveBeenCalledWith("work.resume", { workspaceId: "ws", requestId: "stuck" });
    await test.user.click(within(attention).getByRole("button", { name: /Worker 规范讨论/ }));
    expect(test.onOpenSession).toHaveBeenCalledWith("src-1", undefined);
  });

  it("shows counts, merge progress and a trimmed ended group that expands through the filters", async () => {
    const test = setup();
    expect(screen.getByRole("button", { name: "1 需要处理" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 进行中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "7 已结束" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "进行中" })).getByText("0 / 1 已合入")).toBeTruthy();
    const ended = screen.getByRole("region", { name: "已结束" });
    expect(ended.querySelectorAll(".vm-board-row")).toHaveLength(5);
    expect(within(ended).getByText("5cb9327")).toBeTruthy();
    await test.user.click(within(ended).getByRole("button", { name: "查看全部" }));
    expect(screen.queryByRole("region", { name: "需要你处理" })).toBeNull();
    expect(screen.getByRole("region", { name: "已结束" }).querySelectorAll(".vm-board-row")).toHaveLength(7);
    await test.user.click(screen.getByRole("button", { name: "1 需要处理" }));
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["需要你处理"]);
    await test.user.type(screen.getByRole("textbox", { name: "筛选标题" }), "没有这个");
    expect(screen.getByText("没有匹配的工作")).toBeTruthy();
  });

  it("opens a closed item with one state, lifecycle steps, counted tabs and a folded checklist", async () => {
    const test = setup();
    await test.user.click(screen.getByRole("button", { name: "隔离会话树实例" }));
    const dialog = screen.getByRole("dialog", { name: "隔离会话树实例" });
    expect(within(dialog).getAllByText("已合入")).toHaveLength(1);
    expect(within(dialog).queryByText("已关闭", { selector: ".vm-pill span" })).toBeNull();
    expect(within(dialog).getByRole("list", { name: "工单进度" }).querySelectorAll("[data-state=done]")).toHaveLength(4);
    expect(within(dialog).getByText("5cb9327")).toBeTruthy();
    expect(within(dialog).getByText("app.start").tagName).toBe("CODE");
    expect(dialog.textContent).not.toMatch(/`app\.start`|done|turn/);
    const tabs = within(dialog).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["进展", "任务要求", "验收2/2", "检查与附件"]);
    await test.user.click(within(dialog).getByRole("tab", { name: /^验收/ }));
    expect(within(dialog).getByText("2 条全部通过", { exact: false })).toBeTruthy();
    expect(within(dialog).queryByText("真实 CLI 单次返回 pid")).toBeNull();
    await test.user.click(within(dialog).getAllByRole("button", { name: "证据" })[0]!);
    expect(within(dialog).getByText("真实 CLI 单次返回 pid")).toBeTruthy();
  });
});
