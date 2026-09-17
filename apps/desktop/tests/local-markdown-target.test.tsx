import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdownView } from "../src/ui/chat-shell/MessageMarkdownView.js";
import {
  localMarkdownFileUrl,
  parseLocalFileTarget
} from "../src/ui/chat-shell/local-markdown-target.js";
import { fileUriToPath } from "@vermillion/shared";

const render = (text: string) => renderToStaticMarkup(<MessageMarkdownView
  block={{ blockId: "b", messageId: "m", sessionId: "s", turnId: "t", role: "assistant",
    kind: "markdown", text, actor: { participantId: "p", engineId: "e" },
    startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z" }}
  onPreviewImage={() => undefined}
/>);

describe("local Markdown destinations", () => {
  it("renders Windows delivery links and the existing image preview", () => {
    const html = render("[页面](I:/demo/page.html) [启动](I:/demo/open.bat) ![示意](I:/demo/image.png)");
    expect(html).toContain('href="file:///I:/demo/page.html"');
    expect(html).toContain('href="file:///I:/demo/open.bat"');
    expect(html).toContain('src="file:///I:/demo/image.png?awb_image_cache=');
    expect(html).toContain('class="awb-inline-image-button"');
    expect(html).not.toContain("unsupported-link");
  });

  it("decodes parser-encoded Chinese, spaces and Windows separators", () => {
    const path = "I:\\演示 文件\\页面.html";
    expect(fileUriToPath(localMarkdownFileUrl(encodeURI(path))!)).toBe(path);
    expect(render("[页面](<I:/演示 文件/页面.html>)")).toContain('href="file:///I:/%E6%BC%94%E7%A4%BA%20%E6%96%87%E4%BB%B6/');
  });

  it("keeps external links and file/data images without admitting dangerous protocols", () => {
    const html = render("[web](https://example.com) [http](http://example.com) [bad](javascript:alert%281%29) ![bad](javascript:alert%281%29) ![file](file:///I:/image.png) ![data](data:image/png;base64,AAAA)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="http://example.com"');
    expect(html).toContain('src="file:///I:/image.png?');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="javascript:');
    expect(localMarkdownFileUrl("custom:thing")).toBeUndefined();
  });
});

describe("local file targets", () => {
  it("strips the location shapes agents write", () => {
    expect(parseLocalFileTarget("I:\\repo\\src\\x.ts:397")).toEqual({
      path: "I:\\repo\\src\\x.ts",
      location: ":397",
      target: "I:\\repo\\src\\x.ts:397"
    });
    expect(parseLocalFileTarget("I:/repo/src/x.ts:10-11")).toEqual({
      path: "I:/repo/src/x.ts",
      location: ":10-11",
      target: "I:/repo/src/x.ts:10-11"
    });
    expect(parseLocalFileTarget("I:/repo/app/assets/index.js:12:5")).toEqual({
      path: "I:/repo/app/assets/index.js",
      location: ":12:5",
      target: "I:/repo/app/assets/index.js:12:5"
    });
    expect(parseLocalFileTarget("I:/repo/src/x.ts#L42")).toEqual({
      path: "I:/repo/src/x.ts",
      location: "#L42",
      target: "I:/repo/src/x.ts#L42"
    });
    expect(parseLocalFileTarget("I:/repo/src/x.ts#L42-L50")).toEqual({
      path: "I:/repo/src/x.ts",
      location: "#L42-L50",
      target: "I:/repo/src/x.ts#L42-L50"
    });
  });

  it("keeps targets without a location, anchors and relative targets as one path", () => {
    expect(parseLocalFileTarget("I:/repo/docs/x.md")).toEqual({
      path: "I:/repo/docs/x.md",
      target: "I:/repo/docs/x.md"
    });
    expect(parseLocalFileTarget("I:/repo/skills/manual.md#角色部件对位-sop")).toEqual({
      path: "I:/repo/skills/manual.md#角色部件对位-sop",
      target: "I:/repo/skills/manual.md#角色部件对位-sop"
    });
    expect(parseLocalFileTarget("I:/repo/src/x.ts::12")).toEqual({
      path: "I:/repo/src/x.ts::12",
      target: "I:/repo/src/x.ts::12"
    });
    expect(parseLocalFileTarget(".vermillion/docs/Workbench/Think/PRD.md")).toBeUndefined();
    expect(parseLocalFileTarget("https://example.com/src/x.ts:12")).toBeUndefined();
  });

  it("accepts a drive path with a stray leading slash and parser-encoded targets", () => {
    expect(parseLocalFileTarget("/I:/repo/src/x.ts:381")).toEqual({
      path: "I:/repo/src/x.ts",
      location: ":381",
      target: "I:/repo/src/x.ts:381"
    });
    expect(parseLocalFileTarget(encodeURI("I:\\演示 文件\\页面.html"))).toEqual({
      path: "I:\\演示 文件\\页面.html",
      target: "I:\\演示 文件\\页面.html"
    });
    expect(localMarkdownFileUrl("/I:/repo/src/x.ts:381")).toBe("file:///I:/repo/src/x.ts:381");
  });

  it("keeps an escaped hash in a file name openable and hands the location to the link menu", () => {
    const hashed = localMarkdownFileUrl("I:/repo/a/b%23c.txt");
    expect(fileUriToPath(hashed!)).toBe("I:\\repo\\a\\b#c.txt");
    expect(parseLocalFileTarget(fileUriToPath(hashed!)!)).toEqual({
      path: "I:\\repo\\a\\b#c.txt",
      target: "I:\\repo\\a\\b#c.txt"
    });

    const located = localMarkdownFileUrl("I:/repo/src/x.ts#L42");
    expect(parseLocalFileTarget(fileUriToPath(located!)!)).toEqual({
      path: "I:\\repo\\src\\x.ts",
      location: "#L42",
      target: "I:\\repo\\src\\x.ts#L42"
    });
  });
});
