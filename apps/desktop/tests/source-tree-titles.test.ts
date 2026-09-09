import { describe, expect, it, vi } from "vitest";
import type { SessionBrowserPageRpc } from "@vermillion/shared";
vi.mock("xterm", () => ({ Terminal: class {} }));
import { loadSourceTreeTitles } from "../src/ui/app/components/WorkspacePages.js";

describe("source tree titles", () => {
  it("uses the indexed tree title through member aliases and stops once resolved", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ sessionId: "canonical", memberSessionIds: ["source-alias"], title: "真实讨论标题" }], hasMore: true, nextCursor: "unused" } as SessionBrowserPageRpc);
    expect(await loadSourceTreeTitles(list, "workspace", [{ treeId: "tree-alias", sourceSessionId: "source-alias" }])).toEqual({ "tree-alias": "真实讨论标题" });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ kind: "user", workspaceId: "workspace" }));
  });

  it("reads subsequent pages when the source tree is older", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ items: [], hasMore: true, nextCursor: "older", revision: "r1" })
      .mockResolvedValueOnce({ items: [{ sessionId: "tree", title: "旧讨论标题" }], hasMore: false });
    expect(await loadSourceTreeTitles(list, "workspace", [{ treeId: "tree" }])).toEqual({ tree: "旧讨论标题" });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: "older", expectedRevision: "r1" });
  });
});
