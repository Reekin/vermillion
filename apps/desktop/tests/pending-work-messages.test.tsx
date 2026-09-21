import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchClient, WorkbenchEvent, WorkbenchRpcResult, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { CurrentWorkBar, PendingWorkMessages } from "../src/ui/app/components/CurrentWorkBar.js";
import { continueWorkFrom } from "../src/ui/app/continue-work-from.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, cleanups: [] as Array<(() => void) | void> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next; }];
  },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => { hooks.cleanups[index]?.(); hooks.cleanups[index] = effect(); });
  }
}));
type Pending = WorkbenchRpcResult<"session.messages.pending">;
const message = (content: string): Pending => [{ state: "queued", sessionId: "worker", messageId: "message", content, reason: "等待前置工单", workItemId: "item", blockerWorkItemIds: ["dependency"],
  attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png", name: "参考图.png" }], createdAt: "2026-01-01" }];
const elements = (node: ReactNode): Array<{ props: Record<string, any> }> => Children.toArray(node).flatMap((child) => {
  if (!isValidElement<{ children?: ReactNode }>(child)) return [];
  return [child, ...elements(child.props.children)];
});
const setup = () => {
  const listeners = new Set<(event: WorkbenchEvent) => void>();
  const request = vi.fn<WorkbenchClient["request"]>();
  const client = { request, subscribe: (listener: (event: WorkbenchEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as WorkbenchClient;
  const onOpenWorkItem = vi.fn();
  const onConfirm = vi.fn(async () => {});
  const render = (sessionId = "worker") => {
    hooks.cursor = 0;
    const tree = PendingWorkMessages({ client, workspaceId: "workspace", sessionId, onOpenWorkItem, onConfirm });
    hooks.effects.splice(0).forEach((effect) => effect());
    return elements(tree);
  };
  const flush = async (sessionId = "worker") => { await Promise.resolve(); await Promise.resolve(); return render(sessionId); };
  const emit = (sessionId: string) => listeners.forEach((listener) => listener({ type: "session.messages.changed", workspaceId: "workspace", sessionId }));
  return { request, render, flush, emit, onOpenWorkItem, onConfirm, listeners };
};
beforeEach(() => { hooks.cleanups.forEach((cleanup) => cleanup?.()); hooks.slots = []; hooks.effects = []; hooks.cleanups = []; hooks.cursor = 0; });

describe("server pending messages", () => {
  it("offers confirmation instead of withdrawal when delivery may already be accepted", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce(message("uncertain message").map((entry) => ({ ...entry, state: "unknown", reason: "消息受理状态等待确认" })));
    h.render();
    const rows = await h.flush();
    expect(rows.some((row) => row.props["aria-label"] === "等待确认")).toBe(true);
    expect(rows.some((row) => row.props.children === "撤回")).toBe(false);
    rows.find((row) => row.props.children === "确认状态")!.props.onClick();
    expect(h.onConfirm).toHaveBeenCalledExactlyOnceWith();
  });

  it("uses the newest server result when matching events race", async () => {
    const h = setup();
    let resolveOld!: (messages: Pending) => void;
    h.request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve as typeof resolveOld; }));
    h.render();
    h.request.mockResolvedValueOnce([]);
    h.emit("worker");
    await h.flush();
    resolveOld(message("already delivered"));
    expect((await h.flush()).some((row) => row.props["aria-label"] === "等待发送")).toBe(false);
  });
  it("shows server content and reason, withdraws the exact message and refreshes", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce(message("queued text"));
    h.render();
    const rows = await h.flush();
    expect(rows.some((row) => row.props.children === "queued text")).toBe(true);
    expect(rows.some((row) => row.props.children === "等待前置工单")).toBe(true);
    expect(rows.some((row) => row.props.children === "参考图.png")).toBe(true);
    rows.find((row) => row.props.onClick && Array.isArray(row.props.children) && row.props.children[0] === "查看阻塞工单")!.props.onClick();
    expect(h.onOpenWorkItem).toHaveBeenCalledWith("dependency");
    h.request.mockResolvedValueOnce({ cancelled: true }).mockResolvedValueOnce([]);
    rows.find((row) => row.props.children === "撤回")!.props.onClick();
    await h.flush();
    expect(h.request).toHaveBeenCalledWith("session.messages.cancel", { sessionId: "worker", messageId: "message" });
    expect((await h.flush()).some((row) => row.props["aria-label"] === "等待发送")).toBe(false);
  });

  it("ignores other branches and isolates late responses after a branch switch", async () => {
    const h = setup();
    let resolveOld!: (messages: Pending) => void;
    h.request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve as typeof resolveOld; }));
    h.render();
    h.emit("unrelated");
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValueOnce(message("new branch text"));
    h.render("new-worker");
    await h.flush("new-worker");
    resolveOld(message("stale old text"));
    const rows = await h.flush("new-worker");
    expect(rows.some((row) => row.props.children === "new branch text")).toBe(true);
    expect(rows.some((row) => row.props.children === "stale old text")).toBe(false);
    expect(h.listeners.size).toBe(1);
    h.request.mockResolvedValueOnce([]);
    h.emit("new-worker");
    expect((await h.flush("new-worker")).some((row) => row.props["aria-label"] === "等待发送")).toBe(false);
  });

  it("reports a withdrawal racing with delivery without claiming it was cancelled", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce(message("queued text"));
    h.render();
    const rows = await h.flush();
    h.request.mockResolvedValueOnce({ cancelled: false });
    rows.find((row) => row.props.children === "撤回")!.props.onClick();
    expect((await h.flush()).some((row) => row.props.children === "消息已开始发送，无法撤回。")).toBe(true);
  });
});

describe("current work historical execution action", () => {
  const item = { workItemId: "item", title: "Bound work", status: "queued", run: { sessionId: "worker", control: "manual" } } as WorkItem;
  it.each([
    ["auto", "暂停准备", "work.pause"],
    ["paused", "恢复准备", "work.resume"],
    ["manual", "恢复自动推进", "work.resume"]
  ] as const)("routes %s preparation control to the request despite its registered first item", async (control, label, method) => {
    const h = setup();
    const request = { requestId: "preparation", status: "preparing", workerSessionId: "preparation-session", control } as WorkRequest;
    h.request.mockResolvedValueOnce(request);
    const rows = elements(CurrentWorkBar({ client: { request: h.request } as WorkbenchClient, workspaceId: "workspace", request, item: { ...item, status: "preparing" } }));
    rows.find((row) => row.props.children === label)!.props.onClick();
    await Promise.resolve();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(method, { workspaceId: "workspace", requestId: "preparation" });
    expect(rows.find((row) => row.props.sessionId)?.props.sessionId).toBe("preparation-session");
  });
  it.each([false, true])("uses the same bound target for historical migration after handoff=%s", async (handedOff) => {
    const h = setup();
    const request = { requestId: "preparation", status: handedOff ? "ready" : "preparing", workerSessionId: "preparation-session", control: "manual" } as WorkRequest;
    const client = { request: h.request } as WorkbenchClient;
    h.request.mockResolvedValueOnce(handedOff ? { ...item, run: { sessionId: "new-worker" } } : { ...request, workerSessionId: "new-preparation" });
    const rows = elements(CurrentWorkBar({ client, workspaceId: "workspace", request, item: { ...item, status: handedOff ? "queued" : "preparing" },
      onContinueFrom: (target) => continueWorkFrom({ client, transport: {} as DesktopTransport,
        workspaceId: "workspace", target, sessionId: "selected-branch", turnId: "history", open: vi.fn(async () => {}) }) }));
    rows.find((row) => row.props.children === "从此处继续执行")!.props.onClick();
    await Promise.resolve();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(handedOff ? "workItem.continueFrom" : "work.continueFrom", {
      workspaceId: "workspace", ...(handedOff ? { workItemId: "item" } : { requestId: "preparation" }), sessionId: "selected-branch", turnId: "history"
    });
  });
  it("does not render execution controls without a bound target", () => {
    const h = setup();
    expect(CurrentWorkBar({ client: { request: h.request } as WorkbenchClient, workspaceId: "workspace" })).toBeNull();
  });
  it("offers history continuation for preparation before any item is registered", () => {
    const h = setup();
    const request = { requestId: "preparation", status: "preparing", workerSessionId: "worker", control: "manual" } as WorkRequest;
    const rows = elements(CurrentWorkBar({ client: { request: h.request } as WorkbenchClient, workspaceId: "workspace", request, onContinueFrom: vi.fn() }));
    expect(rows.some((row) => row.props.children === "从此处继续执行")).toBe(true);
  });
  it("invokes the dedicated history action and displays a transfer failure", async () => {
    const h = setup();
    const onContinueFrom = vi.fn(async () => { throw new Error("原执行尚未退出"); });
    const render = () => { hooks.cursor = 0; return elements(CurrentWorkBar({ client: { request: h.request } as WorkbenchClient, workspaceId: "workspace", item, onContinueFrom })); };
    const rows = render();
    rows.find((row) => row.props.children === "从此处继续执行")!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(onContinueFrom).toHaveBeenCalledOnce();
    expect(render().some((row) => row.props.children === "原执行尚未退出")).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("does not offer migration for finished work", () => {
    const h = setup();
    const rows = elements(CurrentWorkBar({ client: { request: h.request } as WorkbenchClient, workspaceId: "workspace", item: { ...item, status: "closed" }, onContinueFrom: vi.fn() }));
    expect(rows.some((row) => row.props.children === "从此处继续执行")).toBe(false);
  });
});
