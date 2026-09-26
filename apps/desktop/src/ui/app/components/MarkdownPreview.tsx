import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Resolve document images independently of the renderer's own location.
 * `onOpenLink` handles in-app links (e.g. relative document paths); it returns false to fall back to the browser.
 */
export const MarkdownPreview = ({ content, documentUrl, onOpenLink }: { content: string; documentUrl: string; onOpenLink?: (href: string) => boolean }) => (
  <article className="vm-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => {
      if (key === "src" && !/^[a-z][a-z\d+.-]*:/i.test(url)) return new URL(url, documentUrl).href;
      return defaultUrlTransform(url);
    }} components={{ a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" onClick={(event) => {
      if (props.href && onOpenLink?.(props.href)) event.preventDefault();
    }}>{children}</a> }}>
      {content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, "")}
    </ReactMarkdown>
  </article>
);
