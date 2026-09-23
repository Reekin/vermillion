import { describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MessageMarkdownView,
  renderMessageMarkdown,
  splitStreamingMarkdown,
  splitUserMessageText
} from "../src/ui/chat-shell/MessageMarkdownView.js";
import { messageMarkdownAstCache } from "../src/ui/chat-shell/markdown-ast-cache.js";

const compiledElement = (tree: ReactNode, tag: string): ReactElement<any> | undefined => {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<{ node?: { tagName?: string }; children?: ReactNode }>(child)) continue;
    if (child.props.node?.tagName === tag) return child;
    const found = compiledElement(child.props.children, tag);
    if (found) return found;
  }
  return undefined;
};

describe("compiled Markdown reuse", () => {
  it("reuses compilation across independent mounts, including cloned blocks, and recompiles edits", () => {
    const block = { blockId: "reuse:md", messageId: "reuse", sessionId: "s", turnId: "t", role: "user" as const, kind: "markdown" as const, text: "Image\n\n![image](data:image/png;base64,AAAA)", startedAt: "2026-09-22T00:00:00Z", completedAt: "2026-09-22T00:00:00Z" };
    const read = vi.spyOn(messageMarkdownAstCache, "get");
    try {
      const first = renderToStaticMarkup(<MessageMarkdownView block={block} />);
      const second = renderToStaticMarkup(<MessageMarkdownView block={{ ...block }} />);
      expect(second).toBe(first);
      expect(read.mock.results[1]!.value).toBe(read.mock.results[0]!.value);
      const edited = renderToStaticMarkup(<MessageMarkdownView block={{ ...block, text: "Image\n\n![image](data:image/png;base64,BBBB)" }} />);
      expect(edited).toContain("BBBB");
      expect(edited).not.toContain("AAAA");
      expect(read.mock.results[2]!.value).not.toBe(read.mock.results[0]!.value);
    } finally {
      read.mockRestore();
    }
  });

  it("binds current preview and file menu callbacks when reusing a compiled tree", () => {
    const text = "![preview](file:///I:/image.png) [file](file:///I:/file.md)";
    const cacheKey = "callbacks:markdown:0";
    const oldPreview = vi.fn();
    const currentPreview = vi.fn();
    const oldMenu = vi.fn();
    const currentMenu = vi.fn();
    renderMessageMarkdown({ text, cacheKey, onPreviewImage: oldPreview, renderFileLinkContextMenu: oldMenu });
    const ast = messageMarkdownAstCache.get(cacheKey, text);
    const current = renderMessageMarkdown({ text, cacheKey, onPreviewImage: currentPreview, renderFileLinkContextMenu: currentMenu });
    expect(messageMarkdownAstCache.get(cacheKey, text)).toBe(ast);
    const image = compiledElement(current, "img")!;
    const button = (image.type as (props: unknown) => ReactElement<any>)(image.props);
    button.props.onClick();
    expect(currentPreview).toHaveBeenCalledWith(expect.objectContaining({ alt: "preview" }));
    expect(oldPreview).not.toHaveBeenCalled();
    const anchor = compiledElement(current, "a")!;
    const fileLink = (anchor.type as (props: unknown) => ReactElement<any>)(anchor.props);
    expect(fileLink.props.renderFileLinkContextMenu).toBe(currentMenu);
    expect(oldMenu).not.toHaveBeenCalled();
  });

  it("preserves GFM and safe URL handling on both cold and cached renders", () => {
    const text = "| a | b |\n| - | - |\n| x | y |\n\n- [x] checked\n\n~~removed~~ https://example.com\n\nFootnote[^1]\n\n[^1]: detail\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) ![bad](javascript:alert%281%29)";
    const render = () => renderToStaticMarkup(renderMessageMarkdown({ text, cacheKey: "safe:markdown:0" }));
    const first = render();
    expect(render()).toBe(first);
    expect(first).toContain("<table>");
    expect(first).toContain('type="checkbox"');
    expect(first).toContain("<del>removed</del>");
    expect(first).toContain("data-footnotes");
    expect(first).toContain('href="https://example.com"');
    expect(first).not.toContain("<script");
    expect(first).not.toContain('href="javascript:');
    expect(first).not.toContain('src="javascript:');
  });
});

describe("MessageMarkdownView", () => {
  it("renders markdown content into semantic HTML", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-1:md",
          messageId: "message-1",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "# Heading\n\n- item",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<li>item</li>");
    expect(html).not.toContain("awb-participant-badge");
  });

  it("splits streaming markdown at a stable block boundary", () => {
    expect(splitStreamingMarkdown("Stable paragraph\n\ncurrent tail")).toEqual({
      stableMarkdown: "Stable paragraph\n\n",
      tailText: "current tail"
    });
    expect(splitStreamingMarkdown("Stable paragraph\n\n```bash\necho hello")).toEqual({
      stableMarkdown: "Stable paragraph\n\n",
      tailText: "```bash\necho hello"
    });
    expect(splitStreamingMarkdown("Stable paragraph\n\n```bash\necho hello\n```\n")).toEqual({
      stableMarkdown: "Stable paragraph\n\n```bash\necho hello\n```\n",
      tailText: ""
    });
  });

  it("renders streaming tail as plain text instead of reparsing unstable markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-streaming:md",
          messageId: "message-streaming",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "Stable paragraph\n\n```bash\necho hello\n- still plain",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("<p>Stable paragraph</p>");
    expect(html).toContain('class="awb-message__streaming-tail"');
    expect(html).toContain("```bash");
    expect(html).toContain("echo hello");
    expect(html).toContain("- still plain");
    expect(html).not.toContain("language-bash");
    expect(html).not.toContain("<li>still plain</li>");
  });

  it("preserves user line breaks, Windows paths, and markdown punctuation verbatim", () => {
    const text =
      "1.Trim only checks the edges\n2.Keep this line separate\nI:\\GameDev\\Projects\\ConfigDatas\\.Json\\PlayPod\\1.json\n# literal heading\n**literal emphasis**";
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-user-plain:md",
          messageId: "message-user-plain",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text,
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('class="awb-message__user-text"');
    expect(html).toContain("1.Trim only checks the edges\n2.Keep this line separate");
    expect(html).toContain("I:\\GameDev\\Projects\\ConfigDatas\\.Json\\PlayPod\\1.json");
    expect(html).toContain("# literal heading\n**literal emphasis**");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<strong>");
  });

  it("splits local echo attachments from exact user text", () => {
    expect(
      splitUserMessageText(
        "line one\nline two\n\n![image](file:///C:/image.png)\n[Spec](file:///C:/spec.md)"
      )
    ).toEqual({
      text: "line one\nline two",
      attachmentMarkdown: "![image](file:///C:/image.png)\n[Spec](file:///C:/spec.md)"
    });
  });

  it("keeps every historical image section in the attachment block", () => {
    const firstImage = "![first](data:image/png;base64,AAAA)";
    const secondImage = "![second](data:image/png;base64,BBBB)";

    expect(
      splitUserMessageText(`Inspect both.\n\n${firstImage}\n\n${secondImage}`)
    ).toEqual({
      text: "Inspect both.",
      attachmentMarkdown: `${firstImage}\n${secondImage}`
    });
  });

  it("keeps a literal file link before historical image attachments in user text", () => {
    const literalLink = "[Spec](file:///C:/spec.md)";
    const firstImage = "![first](data:image/png;base64,AAAA)";
    const secondImage = "![second](data:image/png;base64,BBBB)";

    expect(
      splitUserMessageText(
        `Inspect the spec.\n\n${literalLink}\n\n${firstImage}\n\n${secondImage}`
      )
    ).toEqual({
      text: `Inspect the spec.\n\n${literalLink}`,
      attachmentMarkdown: `${firstImage}\n${secondImage}`
    });
  });

  it("sanitizes unsafe html fragments in markdown source", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-2:md",
          messageId: "message-2",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "safe<script>alert('xss')</script>",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("safe");
    expect(html).not.toContain("<script>");
  });

  it("preserves local file images in markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-3:md",
          messageId: "message-3",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "![image](file:///C:/Users/TestUser/Pictures/cat.png)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain(
      'src="file:///C:/Users/TestUser/Pictures/cat.png?awb_image_cache=message-3%3Amd%3Aattachments"'
    );
  });

  it("renders Windows path links as local file targets", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-3b:md",
          messageId: "message-3b",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "[recovery](I:\\repo\\recovery\\awb-session-index-20260830)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).not.toContain('class="awb-message__unsupported-link"');
    expect(html).toContain(">recovery<");
    expect(html).toContain(
      'href="file:///I:/repo/recovery/awb-session-index-20260830"'
    );
  });

  it("renders web links as external browser targets", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-3d:md",
          messageId: "message-3d",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "[OpenAI](https://openai.com/)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('href="https://openai.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("wraps inline images in a preview button when image opening is enabled", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        onPreviewImage={() => undefined}
        block={{
          blockId: "message-3c:md",
          messageId: "message-3c",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "![Diagram](file:///C:/repo/assets/diagram.png)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<button");
    expect(html).toContain('class="awb-inline-image-button"');
    expect(html).toContain(
      'src="file:///C:/repo/assets/diagram.png?awb_image_cache=message-3c%3Amd%3Aattachments"'
    );
  });

  it("preserves data-url images in markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-4:md",
          messageId: "message-4",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "![image](data:image/png;base64,AAAA)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("renders closed mermaid fences as diagram containers with code fallback", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-4b:md",
          messageId: "message-4b",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "Before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("Before");
    expect(html).toContain("awb-message--contains-mermaid");
    expect(html).toContain('class="awb-mermaid"');
    expect(html).toContain("graph TD");
    expect(html).toContain("A --&gt; B");
    expect(html).toContain("After");
    expect(html).not.toContain("language-mermaid");
  });

  it("keeps incomplete mermaid fences as normal markdown code", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-4c:md",
          messageId: "message-4c",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "```mermaid\ngraph TD\n  A --> B",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("language-mermaid");
    expect(html).toContain("graph TD");
    expect(html).not.toContain('class="awb-mermaid"');
  });

  it("renders code review findings as a readable card instead of raw directive text", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-5:md",
          messageId: "message-5",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: '::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="I:/repo/src/foo.ts" start=10 end=11 priority=2}',
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('class="awb-code-comment"');
    expect(html).toContain("Finding");
    expect(html).toContain("[P2] Off-by-one");
    expect(html).toContain("Loop iterates past the end when length is 0.");
    expect(html).toContain("I:/repo/src/foo.ts:10-11");
    expect(html).toContain("P2");
    expect(html).not.toContain("::code-comment{");
  });

  it("renders finding inline code and keeps Windows paths separate from locations", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-6:md",
          messageId: "message-6",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: '::code-comment{title="[P2] \`finalMessageId\` drift" body="When \`turn.completed\` lands before \`message.completed\`, the fallback can stick." file="I:\\\\gpt-projects\\\\agent-wrappers\\\\vermillion\\\\packages\\\\core\\\\src\\\\domain-projector.ts" start=326 end=434 priority=2 confidence=0.84}',
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<code>finalMessageId</code>");
    expect(html).toContain("<code>turn.completed</code>");
    expect(html).toContain("<code>message.completed</code>");
    expect(html).toContain("I:\\gpt-projects\\agent-wrappers\\vermillion\\packages\\core\\src\\domain-projector.ts:326-434");
    expect(html).not.toContain("start=326");
  });
});

describe("message file links", () => {
  const renderText = (text: string): string => renderToStaticMarkup(
    <MessageMarkdownView
      block={{
        blockId: "message-link:md",
        messageId: "message-link",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        kind: "markdown",
        text,
        actor: {
          participantId: "participant-1",
          engineId: "agent-codex"
        },
        startedAt: "2026-04-17T00:00:00.000Z",
        completedAt: "2026-04-17T00:00:01.000Z"
      }}
    />
  );

  it("keeps the location out of the opened path and shows the full target on hover", () => {
    const html = renderText("[domain-service.ts:397](I:\\repo\\src\\domain-service.ts:397)");
    expect(html).toContain('href="file:///I:/repo/src/domain-service.ts:397"');
    expect(html).toContain('title="I:\\repo\\src\\domain-service.ts:397"');
    expect(html).not.toContain("awb-message__unsupported-link");
  });

  it("accepts a stray leading slash and hash line references", () => {
    const html = renderText(
      "[orchestrator.ts:381](/I:/repo/src/orchestrator.ts:381) [state.rs](I:/repo/src/state.rs#L47)"
    );
    expect(html).toContain('href="file:///I:/repo/src/orchestrator.ts:381"');
    expect(html).toContain('title="I:\\repo\\src\\orchestrator.ts:381"');
    expect(html).toContain('href="file:///I:/repo/src/state.rs%23L47"');
    expect(html).toContain('title="I:\\repo\\src\\state.rs#L47"');
  });

  it("keeps relative targets readable instead of linking them", () => {
    const html = renderText("[PRD](.vermillion/docs/Workbench/Think/PRD.md)");
    expect(html).toContain('class="awb-message__unsupported-link"');
    expect(html).toContain(".vermillion/docs/Workbench/Think/PRD.md");
    expect(html).toContain("无法直接打开");
    expect(html).not.toContain('href=".vermillion');
  });

  it("treats an anchor target as one path and still shows it in full", () => {
    const html = renderText("[手工](<I:/repo/manual.md#角色部件对位-sop>)");
    expect(html).toContain('title="I:\\repo\\manual.md#角色部件对位-sop"');
    expect(html).not.toContain("awb-message__unsupported-link");
  });

  it("keeps file URLs outside the drive-path shapes openable", () => {
    const html = renderText("[script](file:///home/repo/run.sh)");
    expect(html).toContain('href="file:///home/repo/run.sh"');
    expect(html).toContain('title="/home/repo/run.sh"');
    expect(html).not.toContain("awb-message__unsupported-link");
  });
});
