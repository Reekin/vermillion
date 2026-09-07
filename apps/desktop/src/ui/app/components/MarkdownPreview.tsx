import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Resolve document images independently of the renderer's own location. */
export const MarkdownPreview = ({ content, documentUrl }: { content: string; documentUrl: string }) => (
  <article className="vm-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => {
      if (key === "src" && !/^[a-z][a-z\d+.-]*:/i.test(url)) return new URL(url, documentUrl).href;
      return defaultUrlTransform(url);
    }} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>
      {content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, "")}
    </ReactMarkdown>
  </article>
);
