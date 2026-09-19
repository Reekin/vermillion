import { describe, expect, it } from "vitest";
import { locateMarkdownSection } from "../src/doc-ref.js";

describe("Markdown document references", () => {
  const content = [
    "# Spec",
    "root",
    "## Alpha",
    "alpha",
    "### Detail",
    "detail",
    "## Group A",
    "### Item",
    "first",
    "## Group B",
    "### Item",
    "second",
    "```md",
    "## Alpha",
    "ignored",
    "```"
  ].join("\n");

  it("uses exact headings and includes descendant sections", () => {
    expect(locateMarkdownSection(content, "Alpha").text).toBe("## Alpha\nalpha\n### Detail\ndetail");
    expect(locateMarkdownSection(content, "Spec / Group B / Item").text).toBe("### Item\nsecond\n```md\n## Alpha\nignored\n```");
    expect(locateMarkdownSection("# UI/UX 规范\n\n正文", "UI/UX 规范").text).toBe("# UI/UX 规范\n\n正文");
  });

  it("requires a full path for duplicate headings and rejects descriptive labels", () => {
    expect(() => locateMarkdownSection(content, "Item")).toThrow("不唯一");
    expect(() => locateMarkdownSection(content, "Alpha（L3）")).toThrow("不存在");
    expect(() => locateMarkdownSection(content, "Spec / Missing")).toThrow("不存在");
  });
});
