import type { Root, RootContent } from "hast";
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { localMarkdownFileUrl } from "./local-markdown-target.js";

export const unsupportedLinkHrefPrefix = "#awb-unsupported-link:";
const externalLinkProtocols = new Set(["http:", "https:", "mailto:"]);
export const isExternalLinkHref = (href: string): boolean => {
  try {
    return externalLinkProtocols.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

const protectUnsupportedLinkTargets: Plugin<[], Root> = () => {
  const visit = (node: Root | RootContent): void => {
    if (node.type === "element") {
      const href = node.tagName === "a" ? node.properties.href : undefined;
      const src = node.tagName === "img" ? node.properties.src : undefined;
      if (typeof src === "string") node.properties.src = localMarkdownFileUrl(src) ?? src;
      const localHref = typeof href === "string" ? localMarkdownFileUrl(href) : undefined;
      if (localHref) {
        node.properties.href = localHref;
      } else if (typeof href === "string" && href.length > 0 && !isExternalLinkHref(href)) {
        node.properties.href = `${unsupportedLinkHrefPrefix}${encodeURIComponent(href)}`;
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  return visit;
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(protectUnsupportedLinkTargets)
  .use(rehypeSanitize, {
    ...defaultSchema,
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), "file"],
      src: [...(defaultSchema.protocols?.src ?? []), "file", "data"]
    }
  });

/** Only sanitized syntax is retained; UI callbacks and response snapshots never enter this cache. */
export const createMarkdownAstCache = ({
  maxBytes = 64 * 1024 * 1024,
  maxEntries = 512
}: { maxBytes?: number; maxEntries?: number } = {}) => {
  const entries = new Map<string, { text: string; tree: Root; bytes: number }>();
  let inputBytes = 0;
  const remove = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    inputBytes -= entry.bytes;
    entries.delete(key);
  };

  return {
    get(key: string, text: string): Root {
      const existing = entries.get(key);
      if (existing?.text === text) {
        entries.delete(key);
        entries.set(key, existing);
        return existing.tree;
      }
      // One current parse per block segment, including edits with the same ID.
      remove(key);
      const tree = processor.runSync(processor.parse(text)) as Root;
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes <= maxBytes && maxEntries > 0) {
        while (entries.size >= maxEntries || inputBytes + bytes > maxBytes) {
          remove(entries.keys().next().value!);
        }
        entries.set(key, { text, tree, bytes });
        inputBytes += bytes;
      }
      return tree;
    }
  };
};

export const messageMarkdownAstCache = createMarkdownAstCache();
