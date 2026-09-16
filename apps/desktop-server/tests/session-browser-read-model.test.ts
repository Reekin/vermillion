import { describe, expect, it } from "vitest";
import {
  diffRowDeltas,
  resolveRowDelta,
  SessionBrowserReadModel,
  type SessionBrowserReadModelSeed,
  type SessionBrowserRowDelta
} from "../src/session-browser-read-model.js";

const seed = (
  input: Partial<SessionBrowserReadModelSeed> & Pick<SessionBrowserReadModelSeed, "sessionId" | "sortAt">
): SessionBrowserReadModelSeed => ({
  workspaceId: "workspace-1",
  engineId: "codex",
  title: input.sessionId,
  statusDot: "none",
  isActive: false,
  isPinned: false,
  ...input
});

const delta = (
  from: string,
  to: string,
  changedIds: string[],
  removedIds: string[]
): SessionBrowserRowDelta => ({ workspaceId: "workspace-1", from, to, changedIds, removedIds });

describe("SessionBrowserReadModel", () => {
  it("returns every row of the workspace, pinned first then most recent", () => {
    const model = new SessionBrowserReadModel([
      seed({ sessionId: "s-1", sortAt: "2026-07-19T03:00:00Z" }),
      seed({ sessionId: "s-2", sortAt: "2026-07-19T02:00:00Z" }),
      seed({ sessionId: "s-3", sortAt: "2026-07-19T01:00:00Z", isPinned: true }),
      seed({ sessionId: "s-4", sortAt: "2026-07-19T04:00:00Z" })
    ]);

    const snapshot = model.snapshot({ workspaceId: "workspace-1" });
    expect(snapshot.items.map((item) => item.sessionId)).toEqual(["s-3", "s-4", "s-1", "s-2"]);
    expect(model.get("s-2")?.title).toBe("s-2");
    expect(model.get("missing")).toBeUndefined();
  });

  it("nests subagent sessions under their parent and keeps them out of the root rows", () => {
    const model = new SessionBrowserReadModel([
      seed({ sessionId: "worker", sortAt: "2026-07-19T01:00:00Z" }),
      seed({ sessionId: "reviewer", sortAt: "2026-07-19T02:00:00Z", parentSessionId: "worker" }),
      seed({ sessionId: "verifier", sortAt: "2026-07-19T03:00:00Z", parentSessionId: "worker" }),
      seed({ sessionId: "orphan", sortAt: "2026-07-19T04:00:00Z", parentSessionId: "missing" })
    ]);

    const snapshot = model.snapshot({ workspaceId: "workspace-1" });
    expect(snapshot.items.map((item) => item.sessionId)).toEqual(["orphan", "worker"]);
    expect(snapshot.items[1]?.subagents.map((item) => item.sessionId)).toEqual(["verifier", "reviewer"]);
    expect(snapshot.items[1]?.subagents[0]).toMatchObject({ parentSessionId: "worker", subagents: [] });
    expect(model.get("reviewer")?.parentSessionId).toBe("worker");
  });

  it("uses the newest activity across members of a fork tree", () => {
    const model = new SessionBrowserReadModel([
      seed({
        sessionId: "root",
        sortAt: "2026-07-19T01:00:00Z",
        activityAt: "2026-07-19T01:00:00Z",
        lastCompletedTurnAt: "2026-07-19T01:00:00Z"
      }),
      seed({
        sessionId: "branch",
        sortAt: "2026-07-19T03:00:00Z",
        activityAt: "2026-07-19T03:00:00Z",
        lastCompletedTurnAt: "2026-07-19T01:30:00Z",
        forkParentSessionId: "root"
      })
    ]);

    const snapshot = model.snapshot({ workspaceId: "workspace-1" });

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      sessionId: "root",
      activityAt: "2026-07-19T03:00:00Z",
      lastCompletedTurnAt: "2026-07-19T01:30:00Z",
      memberSessionIds: ["root", "branch"]
    });
  });

  it("keeps user sessions and agent sessions apart when the caller asks for one kind", () => {
    const model = new SessionBrowserReadModel([
      seed({ sessionId: "user-session", sortAt: "2026-07-19T02:00:00Z" }),
      seed({ sessionId: "worker-session", sortAt: "2026-07-19T01:00:00Z", role: "worker" })
    ]);

    expect(model.snapshot({ workspaceId: "workspace-1", kind: "user" }).items.map((item) => item.sessionId))
      .toEqual(["user-session"]);
    expect(model.snapshot({ workspaceId: "workspace-1", kind: "agent" }).items.map((item) => item.sessionId))
      .toEqual(["worker-session"]);
  });

  it("keeps the revision stable while the rows do not move", () => {
    const first = new SessionBrowserReadModel([seed({ sessionId: "s-1", sortAt: "2026-07-19T02:00:00Z" })]);
    const same = new SessionBrowserReadModel([seed({ sessionId: "s-1", sortAt: "2026-07-19T02:00:00Z" })]);
    const titled = new SessionBrowserReadModel([seed({ sessionId: "s-1", sortAt: "2026-07-19T02:00:00Z", title: "renamed" })]);

    expect(first.revision("workspace-1")).toBe(same.revision("workspace-1"));
    expect(diffRowDeltas(first, same)).toEqual([]);
    expect(diffRowDeltas(first, titled)).toHaveLength(1);
  });

  it("reports the rows that changed and disappeared between two revisions", () => {
    const before = new SessionBrowserReadModel([
      seed({ sessionId: "s-1", sortAt: "2026-07-19T02:00:00Z" }),
      seed({ sessionId: "s-2", sortAt: "2026-07-19T01:00:00Z" })
    ]);
    const after = new SessionBrowserReadModel([
      seed({ sessionId: "s-1", sortAt: "2026-07-19T02:00:00Z", title: "renamed" }),
      seed({ sessionId: "s-3", sortAt: "2026-07-19T03:00:00Z" })
    ]);

    const [moved] = diffRowDeltas(before, after);
    expect(moved).toMatchObject({
      workspaceId: "workspace-1",
      from: before.revision("workspace-1"),
      to: after.revision("workspace-1")
    });
    expect([...(moved?.changedIds ?? [])].sort()).toEqual(["s-1", "s-3"]);
    expect(moved?.removedIds).toEqual(["s-2"]);
  });

  it("walks a delta chain and reports when a full snapshot is required", () => {
    const chain = [
      delta("a", "b", ["s-1"], []),
      delta("b", "c", [], ["s-2"]),
      delta("c", "d", ["s-2"], [])
    ];

    expect(resolveRowDelta(chain, "a", "d")).toEqual({ changedIds: ["s-1", "s-2"], removedIds: [] });
    expect(resolveRowDelta(chain, "b", "d")).toEqual({ changedIds: ["s-2"], removedIds: [] });
    expect(resolveRowDelta(chain, "unknown", "d")).toBeUndefined();
    expect(resolveRowDelta(chain, "a", "e")).toBeUndefined();
  });
});
