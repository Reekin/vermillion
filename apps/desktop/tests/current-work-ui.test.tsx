import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchClient, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { CurrentWorkBar } from "../src/ui/app/components/CurrentWorkBar.js";
import { SupervisorDetails } from "../src/ui/app/components/SupervisorDetails.js";
import { Button } from "../src/ui/app/components/ui.js";

const buttons = (node: ReactNode): Array<{ children: ReactNode; onClick: () => Promise<void> }> => {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children: ReactNode; onClick: () => Promise<void> }>(node)) return [];
  return node.type === Button ? [node.props] : buttons(node.props.children);
};

const setup = (run: WorkItem["run"]) => {
  const request = vi.fn(async () => ({}));
  const client = { request } as unknown as WorkbenchClient;
  let tree: ReactNode;
  const Probe = () => {
    tree = CurrentWorkBar({ client, workspaceId: "workspace", item: { workItemId: "item", title: "Task", status: "running", run } as WorkItem, onOpenSession: vi.fn() });
    return tree;
  };
  const html = renderToStaticMarkup(createElement(Probe));
  return { request, html, button: (label: string) => buttons(tree).find((button) => button.children === label)! };
};

describe("explicit task controls", () => {
  it("preserves phase while showing an ended unfinished session", async () => {
    const test = setup({});
    expect(test.html).toContain("执行");
    expect(test.html).toContain("会话已结束 · 尚未交付");
    expect(test.html).not.toMatch(/人工接管|从此处继续|等待发送|撤回|自动重试/);
    await test.button("暂停本工单").onClick();
    expect(test.request).toHaveBeenCalledExactlyOnceWith("workItem.pause", { workspaceId: "workspace", workItemId: "item" });
  });
  it.each([{ paused: true }, { userStopped: true }])("uses resume for user intent %j", async (run) => {
    const test = setup(run);
    await test.button("恢复任务").onClick();
    expect(test.request).toHaveBeenCalledExactlyOnceWith("workItem.resume", { workspaceId: "workspace", workItemId: "item" });
  });
  it("uses explicit retry for a fault", async () => {
    const test = setup({ lastFailure: "offline" });
    await test.button("继续").onClick();
    expect(test.request).toHaveBeenCalledExactlyOnceWith("workItem.retry", { workspaceId: "workspace", workItemId: "item" });
  });
  it("shows the supervisor session and persisted check schedule", () => {
    const request = { formatVersion: 2, supervisor: { sessionId: "supervisor", lastCheckedAt: "2026-09-23T01:00:00Z", nextCheckAt: "2026-09-23T01:05:00Z" } } as WorkRequest;
    const html = renderToStaticMarkup(createElement(SupervisorDetails, { request, client: {} as WorkbenchClient, workspaceId: "workspace", onOpenSession: vi.fn() }));
    expect(html).toContain("监工会话");
    expect(html).toContain("最近检查");
    expect(html).toContain("下次检查");
    expect(html).toContain("运行环境");
  });
});
