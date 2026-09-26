// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchClient, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { CurrentWorkBar } from "../src/ui/app/components/CurrentWorkBar.js";
import { SupervisorDetails } from "../src/ui/app/components/SupervisorDetails.js";
afterEach(cleanup);

const setup = (run: WorkItem["run"]) => {
  const request = vi.fn(async () => ({}));
  const client = { request } as unknown as WorkbenchClient;
  render(<CurrentWorkBar client={client} workspaceId="workspace"
    item={{ workItemId: "item", title: "Task", status: "running", run } as WorkItem} onOpenSession={vi.fn()} />);
  return { request, user: userEvent.setup() };
};

describe("explicit task controls", () => {
  it("preserves phase while showing an ended unfinished session", async () => {
    const test = setup({});
    expect(screen.getByText("执行")).toBeTruthy();
    expect(screen.getByText("会话已结束 · 尚未交付")).toBeTruthy();
    await test.user.click(screen.getByRole("button", { name: "暂停本工单" }));
    expect(test.request).toHaveBeenCalledExactlyOnceWith("workItem.pause", { workspaceId: "workspace", workItemId: "item" });
  });
  it.each([{ paused: true }, { userStopped: true }])("uses resume for user intent %j", async (run) => {
    const test = setup(run);
    await test.user.click(screen.getByRole("button", { name: "恢复任务" }));
    expect(test.request).toHaveBeenCalledExactlyOnceWith("workItem.resume", { workspaceId: "workspace", workItemId: "item" });
  });
  it("uses explicit retry for a fault", async () => {
    const test = setup({ lastFailure: "offline" });
    await test.user.click(screen.getByRole("button", { name: "继续" }));
    expect(test.request).toHaveBeenCalledExactlyOnceWith("workItem.retry", { workspaceId: "workspace", workItemId: "item" });
  });
  it("shows the supervisor session and persisted check schedule", () => {
    const request = { formatVersion: 2, supervisor: { sessionId: "supervisor", lastCheckedAt: "2026-09-23T01:00:00Z", nextCheckAt: "2026-09-23T01:05:00Z" } } as WorkRequest;
    render(<SupervisorDetails request={request} client={{} as WorkbenchClient} workspaceId="workspace" onOpenSession={vi.fn()} />);
    for (const text of ["监工会话", "最近检查", "下次检查", "运行环境"]) expect(screen.getByText(text)).toBeTruthy();
  });
  it("blocks duplicate clicks while pending and displays a rejected request", async () => {
    const test = setup({});
    let reject!: (error: Error) => void;
    test.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "暂停本工单" });
    await test.user.click(button);
    expect(button.disabled).toBe(true);
    await test.user.click(button);
    expect(test.request).toHaveBeenCalledOnce();
    reject(new Error("Unable to pause"));
    expect(await screen.findByText("Unable to pause")).toBeTruthy();
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
