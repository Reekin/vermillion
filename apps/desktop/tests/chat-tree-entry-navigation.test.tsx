// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { createRendererStore } from "../src/store/store.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import {
  canDisplayCachedChatTree,
  hasExplicitChatTreeNavigation,
  useChatTreeController,
  type ChatTreeNavigationEntry
} from "../src/ui/chat-shell/use-chat-tree-controller.js";

afterEach(cleanup);

const setup = (navigationEntry?: ChatTreeNavigationEntry, metadataOnly = false) => {
  const calls: string[] = [];
  const tree = { treeId: "root", currentSessionId: "worker", currentNodeId: "latest", nodes: [], windows: [], visibleTurnIds: [] } as unknown as ChatTreeSnapshotRpc;
  let releaseOpen!: () => void;
  let rejectOpen!: (error: Error) => void;
  const opening = new Promise<void>((resolve, reject) => { releaseOpen = resolve; rejectOpen = reject; });
  const open = vi.fn(async (_id: string, _options?: { signal?: AbortSignal }) => { calls.push("open:worker"); await opening; });
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
  const store = createRendererStore();
  if (metadataOnly) store.ingestEnvelope({ eventId: "metadata", cursor: "1", occurredAt: "2026-09-22T00:00:00Z", event: {
    type: "session.created", sessionId: "worker", conversationId: "c", engineId: "e", status: "idle"
  } });
  const onStatusNotice = vi.fn();
  const view = renderHook(({ refreshSignal }) => useChatTreeController({
    store, transport, sessionId: "worker", navigationEntry, refreshSignal, onStatusNotice
  }), { initialProps: { refreshSignal: 0 } });
  const finishOpen = async () => {
    await act(async () => { releaseOpen(); });
    await waitFor(() => expect(view.result.current.isChatTreeLoading).toBe(false));
    expect(view.result.current.chatTreeError).toBeUndefined();
  };
  return { get controller() { return view.result.current; }, calls, open, activate, get, jump, store, tree,
    finishOpen, releaseOpen, rejectOpen, unmount: view.unmount, rerender: view.rerender, onStatusNotice };
};

describe("chat tree entry navigation", () => {
  it("keeps metadata-only sessions loading until their history is available", () => {
    const test = setup(undefined, true);
    expect(test.store.getDomainReadModel().getSession("worker")).toBeDefined();
    expect(test.controller.isOpening).toBe(true);
    expect(test.controller.openingStage).toBe("opening");
  });
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
    await test.finishOpen();
    expect(reads).toBe(1);
    expect(test.store.getKnownSessionWindows().worker).toEqual({ revision: "epoch", cursor: "2" });
    expect(test.store.getDomainReadModel().getMessageBlock("m:md")?.text).toBe("continues");
  });
  it("opens once and focuses the requested branch and turn before reading its tree", async () => {
    const test = setup({ focusTree: true, turnId: "historical" });
    expect(test.controller.isOpening).toBe(true);
    expect(test.controller.isChatTreeLoading).toBe(true);
    expect(test.controller.chatTreeError).toBeUndefined();
    await test.finishOpen();
    // 路径先到达供消息区展示，整棵树随后到达。
    expect(test.calls).toEqual([
      "open:worker", "activate:worker", "jump:historical", "get:path:worker", "get:tree:worker"
    ]);
    expect(test.activate).toHaveBeenCalledWith("worker", { focusTree: true });
    expect(test.open).toHaveBeenCalledWith("worker", { includeWindow: false, signal: expect.any(AbortSignal), readId: expect.stringContaining("::open::"), onProgress: expect.any(Function) });
    await act(async () => { await test.controller.refreshChatTree(); });
    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.activate).toHaveBeenCalledTimes(1);
    expect(test.jump).toHaveBeenCalledTimes(1);
    expect(test.get).toHaveBeenNthCalledWith(1, "worker", { scope: "path", knownWindows: {}, readId: expect.any(String), signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
  });

  it("shares the pending open across refresh notifications", async () => {
    const test = setup({ focusTree: true });
    test.rerender({ refreshSignal: 1 });
    test.rerender({ refreshSignal: 2 });
    expect(test.open).toHaveBeenCalledTimes(1);
    await test.finishOpen();
    expect(test.activate).toHaveBeenCalledTimes(1);
    expect(test.get).toHaveBeenCalledTimes(2);
  });

  it("preserves the saved tree position for ordinary sidebar entry", async () => {
    const test = setup({});
    await test.finishOpen();
    expect(test.calls).toEqual([
      "open:worker", "get:path:worker", "activate:worker", "get:tree:worker"
    ]);
    expect(test.activate).toHaveBeenCalledWith("worker");
    expect(test.jump).not.toHaveBeenCalled();
  });

  it("retries a failed entry without retaining its rejected open", async () => {
    const test = setup({ focusTree: true });
    await act(async () => { test.rejectOpen(new Error("rollout unavailable")); });
    await waitFor(() => expect(test.controller.chatTreeError).toContain("rollout unavailable"));
    expect(test.get).not.toHaveBeenCalled();
    expect(test.onStatusNotice).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("rollout unavailable") }));
    test.open.mockResolvedValueOnce(undefined);
    await act(async () => { await test.controller.refreshChatTree(); });
    expect(test.open).toHaveBeenCalledTimes(2);
    expect(test.activate).toHaveBeenCalledTimes(1);
    expect(test.controller.chatTreeError).toBeUndefined();
    expect(test.controller.isOpening).toBe(false);
  });

  it("cancels loading on unmount and ignores a late open result", async () => {
    const test = setup();
    const signal = test.open.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    test.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { test.releaseOpen(); });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.activate).not.toHaveBeenCalled();
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
