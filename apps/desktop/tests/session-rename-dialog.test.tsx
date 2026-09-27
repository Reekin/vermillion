// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/i18n/index.js";
import { SessionRenameDialog } from "../src/ui/app/components/SessionRenameDialog.js";

afterEach(() => {
  cleanup();
  setLocale("zh");
});

describe("SessionRenameDialog", () => {
  it("blocks unchanged and blank titles, then submits a trimmed edited title", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<SessionRenameDialog title="当前标题" busy={false} error={undefined} onSubmit={onSubmit} onClose={vi.fn()} />);
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "会话标题" });
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "保存" });
    expect(input.value).toBe("当前标题");
    expect(save.disabled).toBe(true);
    await user.click(save);
    await user.clear(input);
    await user.type(input, "   ");
    await user.keyboard("{Enter}");
    expect(save.disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "  新标题  ");
    expect(save.disabled).toBe(false);
    await user.click(save);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("新标题");
  });

  it("disables editing during save and retains the error when saving finishes", () => {
    const props = { title: "当前标题", onSubmit: vi.fn(), onClose: vi.fn(), error: undefined };
    const view = render(<SessionRenameDialog {...props} busy={true} />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "会话标题" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "保存中…" }).disabled).toBe(true);
    view.rerender(<SessionRenameDialog {...props} busy={false} error="Save failed" />);
    expect(screen.getByText("Save failed")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "会话标题" }).disabled).toBe(false);
  });

  it("switches its labels when the interface language changes", () => {
    render(<SessionRenameDialog title="当前标题" busy={false} error={undefined} onSubmit={vi.fn()} onClose={vi.fn()} />);
    act(() => setLocale("en"));
    expect(screen.getByRole("dialog", { name: "Rename session" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Session title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
