import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRenameDialog } from "../src/ui/app/components/SessionRenameDialog.js";

const saveButton = (markup: string): string =>
  markup.match(/<button[^>]*>(?:保存|保存中…)<\/button>/)?.[0] ?? "";

const renderDialog = (props: { title: string; busy?: boolean; error?: string }) =>
  renderToStaticMarkup(
    <SessionRenameDialog
      title={props.title}
      busy={props.busy ?? false}
      error={props.error}
      onSubmit={() => {}}
      onClose={() => {}}
    />
  );

describe("SessionRenameDialog", () => {
  it("prefills the current title and blocks saving while it is unchanged", () => {
    const markup = renderDialog({ title: "当前标题" });

    expect(markup).toContain("重命名会话");
    expect(markup).toContain('value="当前标题"');
    expect(saveButton(markup)).toContain("disabled");
  });

  it("blocks saving for a blank title and keeps a save error visible", () => {
    const markup = renderDialog({ title: "   ", error: "Session title must not be blank." });

    expect(saveButton(markup)).toContain("disabled");
    expect(markup).toContain("Session title must not be blank.");
  });
});
