import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxItem, WorkbenchClient, WorkbenchEvent, WorkItem } from "@vermillion/workbench/client";
import { createWorkbenchStore } from "../src/ui/app/workbench-store.js";

const item = (workItemId: string, status: WorkItem["status"], treeId?: string) => ({ workItemId, title: workItemId, status, treeId }) as WorkItem;

const setup = (data: Record<string, { items: WorkItem[] }>) => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  let listener: ((event: WorkbenchEvent) => void) | undefined;
  const request = vi.fn(async (method: string, params: { workspaceId?: string }) => {
    if (method === "workspace.list") return Object.keys(data).map((workspaceId) => ({ workspaceId, label: workspaceId }));
    if (method === "workItem.list") return data[params.workspaceId!]!.items;
    return [];
  });
  const store = createWorkbenchStore({ request, subscribe: (fn) => {
    listener = fn;
    return () => { if (listener === fn) listener = undefined; };
  } } as WorkbenchClient);
  const disconnect = store.getState().connect();
  return { store, request, disconnect, emit: (event: WorkbenchEvent) => listener?.(event) };
};

afterEach(() => vi.unstubAllGlobals());

it("refreshes pending counts and durable Inbox history together after processing", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  let listener!: (event: WorkbenchEvent) => void;
  let inbox = [
    { kind: "decision", workspaceId: "a", card: { decisionId: "d" } },
    { kind: "merged", workspaceId: "a", workItem: { workItemId: "m", merge: {} } }
  ] as InboxItem[];
  const request = vi.fn(async (method: string) => method === "inbox.list" ? inbox : []);
  const store = createWorkbenchStore({ request, subscribe: (fn) => { listener = fn; return () => {}; } } as WorkbenchClient);
  const disconnect = store.getState().connect();
  await vi.waitFor(() => expect(store.getState().inbox).toHaveLength(2));
  inbox = inbox.map((entry) => entry.kind === "decision"
    ? { ...entry, card: { ...entry.card, answer: { key: "go", at: "now" } } }
    : { ...entry, workItem: { ...entry.workItem, merge: { ...entry.workItem.merge!, acknowledgedAt: "now" } } });
  listener({ type: "decisions.changed", workspaceId: "a" });
  await vi.waitFor(() => expect(store.getState().inbox).toEqual([]));
  expect(store.getState().inboxHistory).toEqual(inbox);
  expect(request).toHaveBeenCalledWith("inbox.list", { includeProcessed: true });
  disconnect();
});

describe("global task summary", () => {
  it("counts every unfinished work item across source trees and workspaces", async () => {
    const { store, request } = setup({
      a: { items: [item("p", "preparing", "tree-a"), item("q", "queued", "tree-a"), item("r", "running", "tree-a"), item("closed", "closed")] },
      b: { items: [item("m", "merging"), item("d", "decision"), item("cancel", "cancelled")] }
    });
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(5));
    expect(store.getState().tasks.map((task) => task.id)).toEqual(["p", "q", "r", "m", "d"]);
    expect(request.mock.calls.some(([method]) => method.startsWith("mission."))).toBe(false);
  });

  it("refreshes other workspaces from events and drops a superseded summary response", async () => {
    const data = { a: { items: [] as WorkItem[] }, b: { items: [item("b", "running")] } };
    const { store, request, emit } = setup(data);
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(1));
    expect(store.getState().browsingWorkspaceId).toBe("a");
    let release!: (value: WorkItem[]) => void;
    request.mockImplementationOnce(() => new Promise<WorkItem[]>((resolve) => { release = resolve; }));
    emit({ type: "workItems.changed", workspaceId: "b" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    data.b.items = [];
    emit({ type: "workItems.changed", workspaceId: "b" });
    release([item("stale", "queued")]);
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(0));
  });

  it("opens a task in its workspace without losing global commit feedback", async () => {
    const { store } = setup({ a: { items: [] }, b: { items: [] } });
    await vi.waitFor(() => expect(store.getState().workspaces).toHaveLength(2));
    store.getState().setDocCommit({ kind: "commit", commit: "abc", message: "说明" });
    store.getState().showTask({ workspaceId: "b", kind: "workItem", id: "target" });
    expect(store.getState()).toMatchObject({ panel: "workbench", workspaceSection: "workItems", overlay: undefined, browsingWorkspaceId: "b", taskTarget: { id: "target" }, docCommit: { message: "说明" } });
  });
});

describe("workspace view invalidation", () => {
  it("updates decisions without waiting for a pending document request", async () => {
    const { store, request, emit, disconnect } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    let release!: (value: unknown[]) => void;
    request.mockImplementation(async (method: string) => {
      if (method === "docs.list") return new Promise<unknown[]>((resolve) => { release = resolve; });
      if (method === "decision.list") return [{ decisionId: "new" }];
      return [];
    });
    try {
      emit({ type: "docs.changed", workspaceId: "a" });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      emit({ type: "decisions.changed", workspaceId: "a" });
      await vi.waitFor(() => expect(store.getState().view?.decisions).toEqual([{ decisionId: "new" }]));
    } finally {
      release?.([]);
      disconnect();
    }
  });

  it("does not restore removed workspace tasks from an in-flight response", async () => {
    const data: Record<string, { items: WorkItem[] }> = { a: { items: [] }, b: { items: [] } };
    const { store, request, emit, disconnect } = setup(data);
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    let release!: (value: WorkItem[]) => void;
    request.mockImplementationOnce(() => new Promise<WorkItem[]>((resolve) => { release = resolve; }));
    try {
      emit({ type: "workItems.changed", workspaceId: "b" });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      delete data.b;
      emit({ type: "workspaces.changed" });
      await vi.waitFor(() => expect(store.getState().workspaces).toHaveLength(1));
      release([item("removed", "running")]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.getState().tasks).toEqual([]);
    } finally {
      release?.([]);
      disconnect();
    }
  });

  it("retains successful initial fields when only the failed field is retried", async () => {
    const { store, request, emit, disconnect } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    let fail = true;
    request.mockImplementation(async (method: string) => {
      if (method === "docs.list" && fail) throw new Error("documents unavailable");
      if (method === "decision.list") return [{ decisionId: "initial" }];
      return [];
    });
    store.getState().setDocsSessionId("new-session");
    await vi.waitFor(() => expect(store.getState().viewError).toBe("documents unavailable"));
    request.mockClear();
    fail = false;
    emit({ type: "docs.changed", workspaceId: "a" });
    await vi.waitFor(() => expect(store.getState().view?.decisions).toEqual([{ decisionId: "initial" }]));
    expect(request.mock.calls.map(([method]) => method).sort()).toEqual(["docs.list", "docs.pending"]);
    expect(store.getState().viewError).toBeUndefined();
    disconnect();
  });

  it("coalesces a docs burst and refreshes only document data", async () => {
    const { store, request, emit } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    request.mockClear();

    for (let index = 0; index < 10; index += 1) {
      emit({ type: "docs.changed", workspaceId: "a" });
    }
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([method]) => method).sort()).toEqual([
      "docs.list",
      "docs.pending"
    ]);
  });

  it("reruns a category once when it changes during an in-flight request", async () => {
    const { store, request, emit } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    request.mockClear();
    let release!: (value: unknown[]) => void;
    request.mockImplementationOnce(() => new Promise<unknown[]>((resolve) => { release = resolve; }));

    emit({ type: "docs.changed", workspaceId: "a" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    emit({ type: "docs.changed", workspaceId: "a" });
    release([]);

    await vi.waitFor(() => {
      const methods = request.mock.calls.map(([method]) => method);
      expect(methods.filter((method) => method === "docs.list")).toHaveLength(2);
      expect(methods.filter((method) => method === "docs.pending")).toHaveLength(2);
    });
  });

  it("loads a newly selected workspace without waiting for the old workspace", async () => {
    const { store, request, emit } = setup({ a: { items: [] }, b: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view?.workspaceId).toBe("a"));
    request.mockClear();
    let release!: (value: unknown[]) => void;
    request.mockImplementationOnce(() => new Promise<unknown[]>((resolve) => { release = resolve; }));

    emit({ type: "docs.changed", workspaceId: "a" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    store.getState().browseWorkspace("b");

    await vi.waitFor(() => expect(store.getState().view?.workspaceId).toBe("b"));
    expect(request.mock.calls.some(([method, params]) =>
      method === "docs.list" && (params as { workspaceId?: string }).workspaceId === "b"
    )).toBe(true);
    release([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().view?.workspaceId).toBe("b");
  });

  it("commits successful categories when another category in the batch fails", async () => {
    const { store, request, emit } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    request.mockImplementation(async (method: string) => {
      if (method === "docs.list") throw new Error("docs unavailable");
      if (method === "decision.list") return [{ decisionId: "decision-new" }];
      return [];
    });

    emit({ type: "docs.changed", workspaceId: "a" });
    emit({ type: "decisions.changed", workspaceId: "a" });

    await vi.waitFor(() => expect(store.getState().view?.decisions).toEqual([
      { decisionId: "decision-new" }
    ]));
    expect(store.getState().viewError).toBe("docs unavailable");
  });

  it("keeps task, view, and Inbox refreshes while avoiding unrelated view queries", async () => {
    const { store, request, emit } = setup({ a: { items: [] }, b: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    request.mockClear();

    emit({ type: "workItems.changed", workspaceId: "b" });
    await vi.waitFor(() => {
      const methods = request.mock.calls.map(([method]) => method);
      expect(methods).toContain("workItem.list");
      expect(methods).toContain("inbox.list");
    });
    expect(request.mock.calls.filter(([method, params]) =>
      method === "workItem.list" && (params as { workspaceId?: string }).workspaceId === "b"
    )).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => [
      "docs.list",
      "docs.pending",
      "role.list",
      "scheduler.get"
    ].includes(method))).toBe(false);
  });

  it("recovers a failed category on its next invalidation", async () => {
    const { store, request, emit } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    request.mockClear();
    request.mockImplementationOnce(async () => { throw new Error("docs unavailable"); });

    emit({ type: "docs.changed", workspaceId: "a" });
    await vi.waitFor(() => expect(store.getState().viewError).toBe("docs unavailable"));
    emit({ type: "docs.changed", workspaceId: "a" });
    await vi.waitFor(() => expect(store.getState().viewError).toBeUndefined());
  });

  it("does not query after its subscription is disconnected", async () => {
    const { store, request, disconnect, emit } = setup({ a: { items: [] } });
    await vi.waitFor(() => expect(store.getState().view).toBeDefined());
    request.mockClear();
    disconnect();

    emit({ type: "docs.changed", workspaceId: "a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).not.toHaveBeenCalled();
  });

  it("does not start view or task queries from a late workspace response after disconnect", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    let release!: (value: Array<{ workspaceId: string; label: string }>) => void;
    const request = vi.fn((method: string) => {
      if (method === "workspace.list") {
        return new Promise<Array<{ workspaceId: string; label: string }>>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve([]);
    });
    const store = createWorkbenchStore({
      request,
      subscribe: () => () => undefined
    } as unknown as WorkbenchClient);
    const disconnect = store.getState().connect();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    disconnect();
    release([{ workspaceId: "a", label: "a" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(request.mock.calls.map(([method]) => method).sort()).toEqual([
      "inbox.list",
      "workspace.list"
    ]);
    expect(store.getState().workspaces).toEqual([]);
  });

  it("starts a new Inbox request after reconnect without waiting for the old connection", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    let releaseOld!: (value: InboxItem[]) => void;
    let inboxCalls = 0;
    const request = vi.fn((method: string) => {
      if (method === "workspace.list") return Promise.resolve([]);
      if (method === "inbox.list") {
        inboxCalls += 1;
        if (inboxCalls === 1) {
          return new Promise<InboxItem[]>((resolve) => { releaseOld = resolve; });
        }
      }
      return Promise.resolve([]);
    });
    const store = createWorkbenchStore({
      request,
      subscribe: () => () => undefined
    } as unknown as WorkbenchClient);

    const disconnectOld = store.getState().connect();
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    disconnectOld();
    const disconnectNew = store.getState().connect();
    await vi.waitFor(() => expect(inboxCalls).toBe(2));
    releaseOld([]);
    disconnectNew();
  });

  it("starts a new task summary request after reconnect without waiting for the old connection", async () => {
    const data = { a: { items: [item("old", "running")] } };
    const { store, request, emit, disconnect } = setup(data);
    await vi.waitFor(() => expect(store.getState().tasks.map((task) => task.id)).toEqual(["old"]));
    let releaseOld!: (value: WorkItem[]) => void;
    request.mockImplementationOnce(() => new Promise<WorkItem[]>((resolve) => {
      releaseOld = resolve;
    }));
    emit({ type: "workItems.changed", workspaceId: "a" });
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));

    disconnect();
    data.a.items = [item("new", "running")];
    const disconnectNew = store.getState().connect();
    await vi.waitFor(() => expect(store.getState().tasks.map((task) => task.id)).toEqual(["new"]));
    releaseOld([item("stale", "running")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().tasks.map((task) => task.id)).toEqual(["new"]);
    disconnectNew();
  });
});
