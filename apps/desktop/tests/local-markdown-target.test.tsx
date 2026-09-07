import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdownView } from "../src/ui/chat-shell/MessageMarkdownView.js";
import { localMarkdownFileUrl } from "../src/ui/chat-shell/local-markdown-target.js";
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
