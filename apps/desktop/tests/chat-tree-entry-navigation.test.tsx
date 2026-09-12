import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { createRendererStore } from "../src/store/store.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import { useChatTreeController, type ChatTreeNavigationEntry } from "../src/ui/chat-shell/use-chat-tree-controller.js";

const setup = (navigationEntry?: ChatTreeNavigationEntry) => {
  const calls: string[] = [];
  const tree = { treeId: "root", currentSessionId: "worker", currentNodeId: "latest", nodes: [], windows: [], visibleTurnIds: [] } as unknown as ChatTreeSnapshotRpc;
  const open = vi.fn(async () => { calls.push("open:worker"); });
  const activate = vi.fn(async () => { calls.push("activate:worker"); });
  const get = vi.fn(async () => { calls.push("get:worker"); return tree; });
  const jump = vi.fn(async ({ nodeId }: { nodeId: string }) => { calls.push(`jump:${nodeId}`); tree.currentNodeId = nodeId; });
  const transport = {
    sessionBrowser: { open, activate },
    chatTree: { get, jump, operations: vi.fn(async () => ({ operations: [] })) }
  } as unknown as DesktopTransport;
  let controller!: ReturnType<typeof useChatTreeController>;
  const Probe = () => {
    controller = useChatTreeController({ store: createRendererStore(), transport, sessionId: "worker", navigationEntry, refreshSignal: 0, onStatusNotice: vi.fn() });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return { controller, calls, open, activate, get, jump };
};

describe("chat tree entry navigation", () => {
  it("opens once and focuses the requested branch and turn before reading its tree", async () => {
    const test = setup({ focusTree: true, turnId: "historical" });
    expect(test.controller.isOpening).toBe(true);
    await test.controller.refreshChatTree();
    expect(test.calls).toEqual(["open:worker", "activate:worker", "jump:historical", "get:worker"]);
    expect(test.activate).toHaveBeenCalledWith("worker", { focusTree: true });
    await test.controller.refreshChatTree();
    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.activate).toHaveBeenCalledTimes(1);
    expect(test.jump).toHaveBeenCalledTimes(1);
  });

  it("shares the pending open across refresh notifications", async () => {
    const test = setup({ focusTree: true });
    let finish!: () => void;
    test.open.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = test.controller.refreshChatTree();
    const second = test.controller.refreshChatTree();
    expect(test.open).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(test.activate).toHaveBeenCalledTimes(1);
    expect(test.get).toHaveBeenCalledTimes(1);
  });

  it("preserves the saved tree position for ordinary sidebar entry", async () => {
    const test = setup({});
    await test.controller.refreshChatTree();
    expect(test.calls).toEqual(["open:worker", "get:worker", "activate:worker"]);
    expect(test.activate).toHaveBeenCalledWith("worker");
    expect(test.jump).not.toHaveBeenCalled();
  });

  it("retries a failed entry without retaining its rejected open", async () => {
    const test = setup({ focusTree: true });
    test.open.mockRejectedValueOnce(new Error("rollout unavailable"));
    await expect(test.controller.refreshChatTree()).rejects.toThrow("rollout unavailable");
    expect(test.get).not.toHaveBeenCalled();
    await test.controller.refreshChatTree();
    expect(test.open).toHaveBeenCalledTimes(2);
    expect(test.activate).toHaveBeenCalledTimes(1);
  });
});
