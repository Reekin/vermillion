import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.useRealTimers());

describe("execution release", () => {
  it("waits for the matching close, retains identity/history and resumes on the next send", async () => {
    const { port, internals, rpc, emit } = setup();
    let released = false;
    const release = port.releaseSessionExecution("worker").then(() => { released = true; });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    emit("unrelated-thread");
    await Promise.resolve();
    expect(released).toBe(false);
    emit("thread-worker");
    await release;
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

  it("reports a bounded missing-close failure and removes its listener", async () => {
    vi.useFakeTimers();
    const { port, internals } = setup();
    const before = internals.rpcClient.notificationListeners.size;
    const release = expect(port.releaseThreadExecution("thread-worker", 50)).rejects.toThrow("thread/closed was not received");
    await vi.advanceTimersByTimeAsync(50);
    await release;
    expect(internals.rpcClient.notificationListeners.size).toBe(before);
  });

  it.each(["notLoaded", "notSubscribed", "rpcFailure"])("handles %s without waiting for a nonexistent close", async (status) => {
    const { port, rpc } = setup();
    if (status === "rpcFailure") rpc.mockRejectedValue(new Error("RPC failed"));
    else rpc.mockResolvedValue({ status });
    if (status === "notLoaded") await port.releaseSessionExecution("worker");
    else await expect(port.releaseSessionExecution("worker")).rejects.toThrow(status === "rpcFailure" ? "RPC failed" : "not subscribed");
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
