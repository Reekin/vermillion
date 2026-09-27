// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRendererStore } from "../src/store/store.js";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import { useSessionSidebar } from "../src/ui/app/use-session-sidebar.js";

afterEach(cleanup);

it("retains loaded rows and revisions when workspace order changes, while still applying filters", async () => {
  const list = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId, revision: "revision-1", items: [{
      sessionId: workspaceId, engineId: "codex", title: workspaceId,
      statusDot: "none", isActive: false, isPinned: false, subagents: []
    }]
  }));
  const changes = vi.fn(async ({ workspaceId }: { workspaceId: string; revision: string }) => ({
    workspaceId, revision: "revision-1", status: "unchanged"
  }));
  const transport = { sessionBrowser: { list, changes } } as unknown as DesktopTransport;
  const store = createRendererStore();
  const renders: string[][] = [];
  const view = renderHook(({ workspaceIds, kind }: { workspaceIds: string[]; kind?: "user" | "agent" }) => {
    const sidebar = useSessionSidebar({ transport, store, workspaceIds, kind });
    renders.push(sidebar.sessions.map((session) => session.sessionId));
    return sidebar;
  }, { initialProps: { workspaceIds: ["a", "b"], kind: undefined as "user" | "agent" | undefined } });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  const rows = view.result.current.sessions;
  expect(rows.map((row) => row.sessionId)).toEqual(["a", "b"]);
  list.mockClear();
  changes.mockClear();
  renders.length = 0;

  view.rerender({ workspaceIds: ["b", "a"], kind: undefined });
  await act(async () => { store.dispatch({ type: "store/sessionBrowserChanged" }); });
  await waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
  expect(list).not.toHaveBeenCalled();
  expect(view.result.current.sessions).toBe(rows);
  expect(renders.every((ids) => ids.join(",") === "a,b")).toBe(true);
  expect(changes).toHaveBeenCalledWith({ workspaceId: "a", revision: "revision-1", kind: undefined });
  expect(changes).toHaveBeenCalledWith({ workspaceId: "b", revision: "revision-1", kind: undefined });

  view.rerender({ workspaceIds: ["b"], kind: undefined });
  await waitFor(() => expect(view.result.current.sessions.map((row) => row.sessionId)).toEqual(["b"]));
  expect(list).toHaveBeenCalledTimes(1);
  list.mockClear();
  view.rerender({ workspaceIds: ["b"], kind: "agent" });
  await waitFor(() => expect(list).toHaveBeenCalledWith({ workspaceId: "b", kind: "agent" }));
});
