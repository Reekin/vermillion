import { describe, expect, it } from "vitest";
import {
  SessionBrowserCursorStaleError,
  SessionBrowserReadModel,
  type SessionBrowserReadModelSeed
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

describe("SessionBrowserReadModel", () => {
  it("returns bounded stable pages, pinned first then most recent", () => {
    const model = new SessionBrowserReadModel([
      seed({ sessionId: "s-1", sortAt: "2026-07-19T03:00:00Z" }),
      seed({ sessionId: "s-2", sortAt: "2026-07-19T02:00:00Z" }),
      seed({ sessionId: "s-3", sortAt: "2026-07-19T01:00:00Z", isPinned: true }),
      seed({ sessionId: "s-4", sortAt: "2026-07-19T04:00:00Z" })
    ]);

    const first = model.list({ workspaceId: "workspace-1", limit: 2 });
    expect(first.items.map((item) => item.sessionId)).toEqual(["s-3", "s-4"]);
    expect(first).toMatchObject({ hasMore: true, totalCount: 4 });
    const second = model.list({ workspaceId: "workspace-1", limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.sessionId)).toEqual(["s-1", "s-2"]);
    expect(second.hasMore).toBe(false);
    expect(model.get("s-2")?.title).toBe("s-2");
    expect(model.get("missing")).toBeUndefined();
  });

  it("nests subagent sessions under their parent and keeps them out of the root page", () => {
    const model = new SessionBrowserReadModel([
      seed({ sessionId: "worker", sortAt: "2026-07-19T01:00:00Z" }),
      seed({ sessionId: "reviewer", sortAt: "2026-07-19T02:00:00Z", parentSessionId: "worker" }),
      seed({ sessionId: "verifier", sortAt: "2026-07-19T03:00:00Z", parentSessionId: "worker" }),
      seed({ sessionId: "orphan", sortAt: "2026-07-19T04:00:00Z", parentSessionId: "missing" })
    ]);

    const page = model.list({ workspaceId: "workspace-1" });
    expect(page.items.map((item) => item.sessionId)).toEqual(["orphan", "worker"]);
    expect(page.totalCount).toBe(2);
    expect(page.items[1]?.subagents.map((item) => item.sessionId)).toEqual(["verifier", "reviewer"]);
    expect(page.items[1]?.subagents[0]).toMatchObject({ parentSessionId: "worker", subagents: [] });
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

    const page = model.list({ workspaceId: "workspace-1" });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sessionId: "root",
      activityAt: "2026-07-19T03:00:00Z",
      lastCompletedTurnAt: "2026-07-19T01:30:00Z",
      memberSessionIds: ["root", "branch"]
    });
  });

  it("rejects cursors from another revision", () => {
    const original = new SessionBrowserReadModel([
      seed({ sessionId: "older", sortAt: "2026-07-18T01:00:00Z" }),
      seed({ sessionId: "root", sortAt: "2026-07-19T01:00:00Z" })
    ]);
    const cursor = original.list({ workspaceId: "workspace-1", limit: 1 }).nextCursor;
    const changed = new SessionBrowserReadModel([
      seed({ sessionId: "new", sortAt: "2026-07-19T03:00:00Z" }),
      seed({ sessionId: "root", sortAt: "2026-07-19T01:00:00Z" })
    ]);
    expect(() => changed.list({ workspaceId: "workspace-1", cursor })).toThrow(SessionBrowserCursorStaleError);
    expect(() =>
      changed.list({
        workspaceId: "workspace-1",
        expectedRevision: original.list({ workspaceId: "workspace-1" }).revision
      })
    ).toThrow(SessionBrowserCursorStaleError);
  });
});
