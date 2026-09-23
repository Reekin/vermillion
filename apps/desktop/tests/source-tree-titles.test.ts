import { describe, expect, it, vi } from "vitest";
import type { SessionBrowserSnapshotRpc } from "@vermillion/shared";
vi.mock("xterm", () => ({ Terminal: class {} }));
import { loadSourceTreeTitles } from "../src/ui/app/components/WorkspacePages.js";

const snapshot = (items: SessionBrowserSnapshotRpc["items"]): SessionBrowserSnapshotRpc => ({
  workspaceId: "workspace",
  revision: "revision-1",
  items
});

describe("source tree titles", () => {
  it("uses the indexed design-partner tree title through member aliases", async () => {
    const indexed = snapshot([
      {
        sessionId: "canonical",
        memberSessionIds: ["source-alias"],
        engineId: "codex",
        role: "design-partner",
        title: "真实讨论标题",
        statusDot: "none",
        isActive: false,
        isPinned: false,
        subagents: []
      }
    ]);
    const list = vi.fn(async (input: { kind?: string }) => input.kind === "user" ? snapshot([]) : indexed);
    expect(await loadSourceTreeTitles(list, "workspace", [{ treeId: "tree-alias", sourceSessionId: "source-alias" }]))
      .toEqual({ "tree-alias": "真实讨论标题" });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ workspaceId: "workspace" });
  });

  it("resolves an older tree from the single full snapshot", async () => {
    const list = vi.fn().mockResolvedValue(snapshot([
      {
        sessionId: "other",
        engineId: "codex",
        title: "别的会话",
        statusDot: "none",
        isActive: false,
        isPinned: false,
        subagents: []
      },
      {
        sessionId: "tree",
        engineId: "codex",
        title: "旧讨论标题",
        statusDot: "none",
        isActive: false,
        isPinned: false,
        subagents: []
      }
    ]));
    expect(await loadSourceTreeTitles(list, "workspace", [{ treeId: "tree" }])).toEqual({ tree: "旧讨论标题" });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
