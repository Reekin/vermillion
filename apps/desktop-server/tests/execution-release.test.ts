import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";

const setup = () => {
  const port = createCodexAppServerRuntimePort({ commandPath: process.execPath, commandArgs: [] });
  vi.spyOn(port, "start").mockResolvedValue();
  const internals = port as unknown as {
    rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    rpcClient: { notificationListeners: Set<(event: { method: string; params: unknown }) => void> };
    handleNotification: (method: string, params: Record<string, unknown>) => void;
    activeTurnByThreadId: Map<string, unknown>;
    childThreadIdsByParentThreadId: Map<string, Set<string>>;
    ensureThreadForSession: (sessionId: string) => Promise<string>;
  };
  const emit = (threadId: string) => {
    for (const listener of internals.rpcClient.notificationListeners) {
      listener({ method: "thread/closed", params: { threadId } });
    }
  };
  const rpc = vi.spyOn(internals, "rpc").mockResolvedValue({ status: "unsubscribed" });
  port.attachThreadToSession("worker", "thread-worker");
  return { port, internals, rpc, emit };
};

describe("execution release", () => {
  it("returns after unsubscribe without waiting for closure, retains history and resumes on the next send", async () => {
    const { port, internals, rpc } = setup();
    const events: unknown[] = [];
    port.subscribe((event) => events.push(event));
    const listenersBefore = internals.rpcClient.notificationListeners.size;
    await port.releaseSessionExecution("worker");
    expect(rpc).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "thread-worker" });
    expect(internals.rpcClient.notificationListeners.size).toBe(listenersBefore);
    expect(events).toContainEqual(expect.objectContaining({ method: "session.updated", params: expect.objectContaining({ sessionId: "worker", status: "idle" }) }));
    const eventCount = events.length;
    internals.handleNotification("thread/status/changed", { threadId: "thread-worker", status: { type: "active" } });
    expect(events).toHaveLength(eventCount);
    expect(port.getThreadIdForSession("worker")).toBe("thread-worker");
    rpc.mockResolvedValue({ thread: { id: "thread-worker", turns: [{ id: "completed-turn" }] } });
    expect((await port.readThread("thread-worker", true)).turns).toEqual([{ id: "completed-turn" }]);
    await internals.ensureThreadForSession("worker");
    expect(rpc).toHaveBeenLastCalledWith("thread/resume", expect.objectContaining({ threadId: "thread-worker" }), {});
  });

  it("observes thread/closed sent before the unsubscribe response", async () => {
    const { port, rpc, emit } = setup();
    rpc.mockImplementation(async () => { emit("thread-worker"); return { status: "unsubscribed" }; });
    await port.releaseSessionExecution("worker");
    await port.releaseSessionExecution("worker");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each(["notLoaded", "notSubscribed", "rpcFailure"])("handles %s without waiting for a nonexistent close", async (status) => {
    const { port, rpc } = setup();
    if (status === "rpcFailure") rpc.mockRejectedValue(new Error("RPC failed"));
    else rpc.mockResolvedValue({ status });
    if (status !== "rpcFailure") {
      await port.releaseSessionExecution("worker");
      await port.releaseSessionExecution("worker");
      expect(rpc).toHaveBeenCalledTimes(1);
    } else {
      await expect(port.releaseSessionExecution("worker")).rejects.toThrow("RPC failed");
      expect(port.isThreadExecutionReleased("thread-worker")).toBe(false);
    }
  });

  it("releases owned idle descendants first and refuses any active execution tree", async () => {
    const { port, internals, rpc, emit } = setup();
    internals.childThreadIdsByParentThreadId.set("thread-worker", new Set(["child"]));
    internals.activeTurnByThreadId.set("child", {});
    await expect(port.releaseSessionExecution("worker")).rejects.toThrow("turn is active");
    expect(rpc).not.toHaveBeenCalled();
    internals.activeTurnByThreadId.clear();
    rpc.mockImplementation(async (_method, params) => { emit(String(params.threadId)); return { status: "unsubscribed" }; });
    await port.releaseSessionExecution("worker");
    expect(rpc.mock.calls.map(([, params]) => params.threadId)).toEqual(["child", "thread-worker"]);
  });

  it("owns native subagents but not sibling Worker forks", () => {
    const { internals } = setup();
    internals.handleNotification("thread/started", { thread: { id: "native-child", parentThreadId: "thread-worker", source: "vscode" } });
    internals.handleNotification("thread/started", { thread: { id: "sibling-worker", parentThreadId: null, forkedFromId: "thread-worker", source: "vscode" } });
    expect([...internals.childThreadIdsByParentThreadId.get("thread-worker")!]).toEqual(["native-child"]);
  });
});
