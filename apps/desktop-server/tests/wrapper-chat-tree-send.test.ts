import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot, type ChatTreeSendInput, type CommandEnvelope } from "@vermillion/shared";
import { SessionIndexStore } from "../src/session-index.js";
import { WrapperChatTreeService } from "../src/wrapper-chat-tree.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const baseDir = await mkdtemp(join(tmpdir(), "wrapper-send-"));
  const index = new SessionIndexStore({ baseDir });
  await index.ready();
  const time = "2026-09-07T00:00:00Z";
  const snapshot = parseDomainSnapshot({
    conversations: [{ conversationId: "conversation", workspaceId: "workspace", participantEngineIds: ["codex"],
      sessionIds: ["root"], createdAt: time, updatedAt: time }],
    sessions: [{ sessionId: "root", conversationId: "conversation", engineId: "codex", status: "idle",
      createdAt: time, updatedAt: time }],
    turns: ["a", "b", "c"].map((turnId, i) => ({ turnId, sessionId: "root", status: "completed",
      startedAt: `2026-09-07T00:00:0${i}Z` }))
  });
  await index.upsertSession({ workspaceId: "workspace", session: snapshot.sessions[0]! });
  const load = vi.fn(async (_id: string) => true);
  const changed = vi.fn();
  const addBranch = async (sessionId: string, sourceTurnId: string) => {
    const session = { ...snapshot.sessions[0]!, sessionId };
    snapshot.sessions.push(session);
    await index.upsertSession({ workspaceId: "workspace", session });
    await index.upsertRelation({ workspaceId: "workspace", parentSessionId: "root", childSessionId: sessionId,
      relationType: "fork", sourceTurnId });
    return sessionId;
  };
  const fork = vi.fn(async (_source: string, nodeId: string) => addBranch(`branch-${nodeId}`, nodeId));
  const service = new WrapperChatTreeService({
    sessionIndexStore: index, reconciliation: { ensureSessionLoaded: load } as never,
    runtimeService: { getSnapshot: () => snapshot, getSession: (id: string) => snapshot.sessions.find((s) => s.sessionId === id),
      getRevision: () => "initial", subscribe: () => () => {}, notifyChatTreeChanged: changed } as never,
    fork
  });
  cleanups.push(async () => { service.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  await service.get("root");
  const send = vi.fn(async (_command: CommandEnvelope) => ({ accepted: true, turnId: "new-turn" }));
  const input: ChatTreeSendInput = { sessionId: "root", nodeId: "a", content: "branch question",
    attachments: [{ attachmentId: "attachment", mimeType: "image/png", uri: "file:///image.png", name: "image.png" }],
    execution: { modelId: "model", reasoningOptionId: "high", serviceTierId: null }, thinkMode: "execute" };
  return { service, index, snapshot, load, changed, fork, addBranch, send, input };
}

describe("asynchronous wrapper branch sends", () => {
  it("exposes the provider rejection reason and reuses the target on retry", async () => {
    const f = await fixture();
    const send = vi.fn().mockResolvedValueOnce({ accepted: false,
      error: { code: "quota_exceeded", message: "Usage limit reached. Try again at 15:00." }
    }).mockResolvedValue({ accepted: true, turnId: "retry-turn" });
    const operation = f.service.submit(f.input, send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]).toMatchObject({
      status: "failed", error: "Usage limit reached. Try again at 15:00.", targetSessionId: "branch-a"
    }));
    f.service.retry(operation.operationId, send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]).toMatchObject({ status: "sent", turnId: "retry-turn" }));
    expect(f.fork).toHaveBeenCalledTimes(1);
  });

  it("accepts immediately, snapshots the send, and preserves the viewing cursor during fork and send", async () => {
    const f = await fixture();
    const forkGate = deferred<string>();
    const sendGate = deferred<{ accepted: boolean; turnId: string }>();
    f.fork.mockImplementation(() => forkGate.promise);
    f.send.mockImplementation(() => sendGate.promise);
    const original = structuredClone(f.input);
    const accepted = f.service.submit(f.input, f.send);
    expect(accepted.status).toBe("creating");
    f.input.content = "edited draft";
    f.input.attachments[0]!.uri = "file:///edited.png";
    f.input.execution!.modelId = "different";
    accepted.content = "edited receipt";
    await vi.waitFor(() => expect(f.fork).toHaveBeenCalledWith("root", "a"));
    await f.service.jump("root", "b");
    expect((await f.service.get("root")).currentNodeId).toBe("b");
    forkGate.resolve(await f.addBranch("branch-a", "a"));
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(f.send.mock.calls[0]![0].command).toMatchObject({ sessionId: "branch-a", content: original.content,
      attachments: original.attachments, execution: original.execution, thinkMode: original.thinkMode });
    expect(f.service.listOperations("root")[0]!.status).toBe("sending");
    expect((await f.service.get("root")).currentNodeId).toBe("b");
    sendGate.resolve({ accepted: true, turnId: "new-turn" });
    await vi.waitFor(() => expect(f.service.listOperations("branch-a")[0]).toMatchObject({ status: "sent", turnId: "new-turn" }));
    expect(f.index.getTreeView("root")).toEqual({ sessionId: "root", nodeId: "b", followTip: false });
    expect(f.changed).toHaveBeenCalled();
    const operations = f.service.listOperations("root");
    operations[0]!.attachments[0]!.uri = "changed externally";
    expect(f.service.listOperations("root")[0]!.attachments).toEqual(original.attachments);
    expect(f.service.listOperations("unrelated")).toEqual([]);
  });

  it.each(["fork", "load"])("runs another branch while the first branch waits for %s, without blocking get or jump", async (stage) => {
    const f = await fixture();
    const loadGate = deferred<boolean>();
    const forkGate = deferred<string>();
    if (stage === "load") f.load.mockImplementation((id) => id === "branch-a" ? loadGate.promise : Promise.resolve(true));
    else f.fork.mockImplementation((_source, nodeId) => nodeId === "a" ? forkGate.promise : f.addBranch(`branch-${nodeId}`, nodeId));
    const first = f.service.submit(f.input, f.send);
    await vi.waitFor(() => expect(f.fork).toHaveBeenCalledWith("root", "a"));
    if (stage === "load") await vi.waitFor(() => expect(f.load).toHaveBeenCalledWith("branch-a", expect.anything()));
    const second = f.service.submit({ ...f.input, nodeId: "b", content: "second question" }, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root").find((op) => op.operationId === second.operationId)?.status).toBe("sent"));
    expect(f.service.listOperations("root").find((op) => op.operationId === first.operationId)?.status).toBe("creating");
    await f.service.jump("root", "c");
    expect((await f.service.get("root")).currentNodeId).toBe("c");
    expect(f.fork).toHaveBeenCalledTimes(2);
    if (stage === "load") loadGate.resolve(true);
    else forkGate.resolve(await f.addBranch("branch-a", "a"));
    await vi.waitFor(() => expect(f.service.listOperations("root").every((op) => op.status === "sent")).toBe(true));
    expect(f.index.getTreeView("root")?.nodeId).toBe("c");
    expect(f.send.mock.calls.map(([envelope]) => envelope.command).map((command) => "sessionId" in command && command.sessionId))
      .toEqual(["branch-b", "branch-a"]);
  });

  it.each(["load", "send"])("retains the target and original payload after %s failure, and retries only once", async (stage) => {
    const f = await fixture();
    if (stage === "load") f.load.mockRejectedValueOnce(new Error("branch load unavailable"));
    else f.send.mockRejectedValueOnce(new Error("provider disconnected"));
    const accepted = f.service.submit(f.input, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]!.status).toBe("failed"));
    const failed = f.service.listOperations("root")[0]!;
    expect(failed).toMatchObject({ targetSessionId: "branch-a", error: stage === "load" ? "branch load unavailable" : "provider disconnected" });
    const retry = f.service.retry(accepted.operationId, f.send);
    expect(retry).toMatchObject({ operationId: accepted.operationId, status: "creating", targetSessionId: "branch-a" });
    expect(retry.error).toBeUndefined();
    f.service.retry(accepted.operationId, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]!.status).toBe("sent"));
    expect(f.fork).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(stage === "load" ? 1 : 2);
    expect(f.send.mock.lastCall![0].command).toMatchObject({ content: f.input.content, attachments: f.input.attachments, execution: f.input.execution });
  });

  it("reports fork failure and creates the target on retry", async () => {
    const f = await fixture();
    f.fork.mockRejectedValueOnce(new Error("fork unavailable"));
    const accepted = f.service.submit(f.input, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]).toMatchObject({ status: "failed", error: "fork unavailable" }));
    expect(f.send).not.toHaveBeenCalled();
    f.service.retry(accepted.operationId, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]!.status).toBe("sent"));
    expect(f.fork).toHaveBeenCalledTimes(2);
  });

  it("keeps a rejected send retryable and prevents branching from a running turn", async () => {
    const f = await fixture();
    f.send.mockResolvedValueOnce({ accepted: false, turnId: "" });
    const accepted = f.service.submit(f.input, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]).toMatchObject({ status: "failed", error: "Branch message was not accepted." }));
    f.service.retry(accepted.operationId, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[0]!.status).toBe("sent"));
    expect(f.fork).toHaveBeenCalledTimes(1);
    f.snapshot.turns.find((turn) => turn.turnId === "b")!.status = "streaming";
    f.service.submit({ ...f.input, nodeId: "b" }, f.send);
    await vi.waitFor(() => expect(f.service.listOperations("root")[1]).toMatchObject({ status: "failed", error: expect.stringContaining("finish") }));
    expect(f.fork).toHaveBeenCalledTimes(1);
  });
});
