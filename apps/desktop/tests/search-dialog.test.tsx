// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchHit, WorkbenchClient, WorkbenchEvent } from "@vermillion/workbench/client";
import { SearchDialog } from "../src/ui/app/components/SearchDialog.js";

afterEach(cleanup);

// The result list is virtualized; jsdom has no layout, so give elements a viewport to render into.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 600, width: 400, height: 600, toJSON: () => ({})
  });
  HTMLElement.prototype.scrollIntoView = () => {};
});

const sessionHit = (line: number, source: "user" | "agent" | "tool", text: string, extra: Partial<SearchHit> = {}): SearchHit => {
  const start = text.indexOf("needle");
  return {
    id: `session:w:s:${line}`,
    kind: "session",
    workspaceId: "w",
    workspaceLabel: "vermillion",
    title: "树",
    treeId: "tree",
    treeTitle: "树",
    path: "rollout.jsonl",
    line,
    column: start + 1,
    sessionId: "s",
    turnId: "turn-1",
    source,
    turnNumber: 3,
    messageAt: new Date().toISOString(),
    context: [
      { line: line - 1, text: "前一条消息", matches: [], source: "user" },
      { line, text, matches: [{ start, end: start + 6 }], source },
      { line: line + 1, text: "后一条消息", matches: [], source: "agent" }
    ],
    ...extra
  };
};

const fakeClient = () => {
  let listener: ((event: WorkbenchEvent) => void) | undefined;
  const request = vi.fn(async (method: string) => method === "search.start" ? { queryId: "q1" } : { cancelled: true });
  const client = { request, subscribe: (next: (event: WorkbenchEvent) => void) => { listener = next; return () => { listener = undefined; }; } } as unknown as WorkbenchClient;
  const emit = (event: WorkbenchEvent) => act(() => { listener?.(event); });
  return { client, request, emit };
};

describe("SearchDialog", () => {
  it("lists session hits as messages, keeps the selection while results stream in, and opens with Enter", async () => {
    const { client, request, emit } = fakeClient();
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<SearchDialog client={client} onClose={vi.fn()} onOpenWorkItem={vi.fn()} onOpenDoc={vi.fn()} onOpenSession={onOpenSession} />);
    await user.type(screen.getByRole("textbox", { name: "搜索工单、会话和文档" }), "needle");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("search.start", expect.objectContaining({ query: "needle" })));

    const first = sessionHit(10, "user", "find the needle please");
    const second = sessionHit(20, "tool", "读取 needle.md · 3 行", { toolKind: "read" });
    emit({ type: "search.hits", queryId: "q1", hits: [first, second] } as WorkbenchEvent);

    const results = screen.getByLabelText("搜索结果");
    expect(within(results).getAllByText(/你 · 第 3 轮 · \d\d:\d\d/)).toHaveLength(1);
    expect(within(results).getByText(/工具调用 · 第 3 轮/)).toBeTruthy();
    expect(within(results).queryByText(/第 \d+ 行/)).toBeNull();

    await user.keyboard("{ArrowDown}");
    const preview = screen.getByLabelText("命中消息预览");
    expect(within(preview).getByText("前一条消息")).toBeTruthy();
    expect(preview.querySelector("[data-current] mark")?.textContent).toBe("needle");
    expect(preview.querySelector("[data-current]")?.textContent).toContain("读取 needle.md · 3 行");

    // A later batch does not move the selection.
    emit({ type: "search.hits", queryId: "q1", hits: [sessionHit(30, "agent", "another needle reply")] } as WorkbenchEvent);
    expect(screen.getByLabelText("命中消息预览").querySelector("[data-current]")?.textContent).toContain("读取 needle.md");
    emit({ type: "search.completed", queryId: "q1", stats: { sourcesScanned: 1, bytesScanned: 10, durationMs: 5, truncated: false } } as WorkbenchEvent);
    expect(screen.getByText(/3 条结果/)).toBeTruthy();

    await user.keyboard("{Enter}");
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }));

    // Enter on a focused button runs that button, not the selected result.
    onOpenSession.mockClear();
    const treeToggle = within(results).getByRole("button", { name: /树/ });
    treeToggle.focus();
    await user.keyboard("{Enter}");
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(treeToggle.getAttribute("aria-expanded")).toBe("false");
  });
});
