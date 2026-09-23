import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { createRendererStore } from "../src/store/store.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import {
  canDisplayCachedChatTree,
  hasExplicitChatTreeNavigation,
  useChatTreeController,
  type ChatTreeNavigationEntry
} from "../src/ui/chat-shell/use-chat-tree-controller.js";

const setup = (navigationEntry?: ChatTreeNavigationEntry) => {
  const calls: string[] = [];
  const tree = { treeId: "root", currentSessionId: "worker", currentNodeId: "latest", nodes: [], windows: [], visibleTurnIds: [] } as unknown as ChatTreeSnapshotRpc;
  const open = vi.fn(async () => { calls.push("open:worker"); });
  const activate = vi.fn(async () => { calls.push("activate:worker"); });
  const get = vi.fn(async (_sessionId: string, options?: { scope?: "tree" | "path" }) => {
    calls.push(`get:${options?.scope ?? "tree"}:worker`);
    return tree;
  });
  const jump = vi.fn(async ({ nodeId }: { nodeId: string }) => { calls.push(`jump:${nodeId}`); tree.currentNodeId = nodeId; });
  const transport = {
    sessionBrowser: { open, activate },
    chatTree: { get, jump, operations: vi.fn(async () => ({ operations: [] })) }
  } as unknown as DesktopTransport;
  let controller!: ReturnType<typeof useChatTreeController>;
  const store = createRendererStore();
  const Probe = () => {
    controller = useChatTreeController({ store, transport, sessionId: "worker", navigationEntry, refreshSignal: 0, onStatusNotice: vi.fn() });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return { controller, calls, open, activate, get, jump, store, tree };
};

describe("chat tree entry navigation", () => {
  it("applies a cold baseline with its in-flight tail without a second body read", async () => {
    const test = setup();
    test.store.ingestEnvelope({ eventId: "new", cursor: "1", occurredAt: "2026-09-22T00:00:00Z", event: { type: "session.created", sessionId: "worker", conversationId: "c", engineId: "e", status: "idle" } });
    let reads = 0;
    test.get.mockImplementation(async (_id, options) => {
      if (options?.scope !== "path") return test.tree;
      reads++;
      const snapshot = test.store.getDomainReadModel().getSnapshot();
      test.store.ingestEnvelope({ eventId: "tail", cursor: "2", occurredAt: "2026-09-22T00:00:01Z", event: {
        type: "message.delta", sessionId: "worker", turnId: "live", messageId: "m", delta: "continues"
      } });
      return { ...test.tree, windows: [{ sessionId: "worker", snapshot, cursor: "1", revision: "epoch", replaceSessionHistory: true, hasOlder: false, hasNewer: false }] } as ChatTreeSnapshotRpc;
    });
    await test.controller.refreshChatTree();
    expect(reads).toBe(1);
    expect(test.store.getKnownSessionWindows().worker).toEqual({ revision: "epoch", cursor: "2" });
    expect(test.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe("continues");
  });
  it("opens once and focuses the requested branch and turn before reading its tree", async () => {
    const test = setup({ focusTree: true, turnId: "historical" });
    expect(test.controller.isOpening).toBe(true);
    expect(test.controller.isChatTreeLoading).toBe(true);
    expect(test.controller.chatTreeError).toBeUndefined();
    await test.controller.refreshChatTree();
    // 路径先到达供消息区展示，整棵树随后到达。
    expect(test.calls).toEqual([
      "open:worker", "activate:worker", "jump:historical", "get:path:worker", "get:tree:worker"
    ]);
    expect(test.activate).toHaveBeenCalledWith("worker", { focusTree: true });
    expect(test.open).toHaveBeenCalledWith("worker", { includeWindow: false, signal: expect.any(AbortSignal), readId: expect.stringContaining("::open::") });
    await test.controller.refreshChatTree();
    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.activate).toHaveBeenCalledTimes(1);
    expect(test.jump).toHaveBeenCalledTimes(1);
    expect(test.get).toHaveBeenNthCalledWith(1, "worker", { scope: "path", knownWindows: {}, readId: expect.any(String), signal: expect.any(AbortSignal) });
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
    expect(test.get).toHaveBeenCalledTimes(2);
  });

  it("preserves the saved tree position for ordinary sidebar entry", async () => {
    const test = setup({});
    await test.controller.refreshChatTree();
    expect(test.calls).toEqual([
      "open:worker", "get:path:worker", "activate:worker", "get:tree:worker"
    ]);
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

describe("cached chat tree display", () => {
  const tree = {
    currentSessionId: "worker",
    currentNodeId: "turn-current",
    nodes: [{ nodeId: "turn-current", turnId: "turn-current" }]
  } as unknown as ChatTreeSnapshotRpc;

  it("accepts the cached position only when it matches an explicit target", () => {
    expect(hasExplicitChatTreeNavigation({})).toBe(false);
    expect(canDisplayCachedChatTree(tree, "worker", undefined)).toBe(true);
    expect(canDisplayCachedChatTree(tree, "worker", { focusTree: true })).toBe(true);
    expect(canDisplayCachedChatTree(tree, "other", { focusTree: true })).toBe(false);
    expect(canDisplayCachedChatTree(tree, "worker", { turnId: "turn-current" })).toBe(true);
    expect(canDisplayCachedChatTree(tree, "worker", { turnId: "turn-other" })).toBe(false);
  });
});
