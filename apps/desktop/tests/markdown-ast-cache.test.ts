import { describe, expect, it } from "vitest";
import { createMarkdownAstCache } from "../src/ui/chat-shell/markdown-ast-cache.js";

describe("message Markdown AST cache", () => {
  it("reuses unchanged block segments and retains only their current input", () => {
    const cache = createMarkdownAstCache();
    const first = cache.get("block:markdown:0", "**first**");
    expect(cache.get("block:markdown:0", "**first**")).toBe(first);
    const edited = cache.get("block:markdown:0", "**edited**");
    expect(edited).not.toBe(first);
    expect(cache.get("block:markdown:0", "**edited**")).toBe(edited);
    expect(cache.get("block:markdown:0", "**first**")).not.toBe(first);
  });

  it("evicts the least recently used segment at the entry bound", () => {
    const cache = createMarkdownAstCache({ maxEntries: 2 });
    const a = cache.get("a", "a");
    const b = cache.get("b", "b");
    expect(cache.get("a", "a")).toBe(a);
    cache.get("c", "c");
    expect(cache.get("a", "a")).toBe(a);
    expect(cache.get("b", "b")).not.toBe(b);
  });

  it("accounts for UTF-8 input bytes and releases edited input's cost", () => {
    const cache = createMarkdownAstCache({ maxBytes: 6 });
    const a = cache.get("a", "中");
    const b = cache.get("b", "文");
    expect(cache.get("a", "中")).toBe(a);
    const edited = cache.get("a", "a");
    const c = cache.get("c", "cd");
    expect(cache.get("a", "a")).toBe(edited);
    expect(cache.get("b", "文")).toBe(b);
    expect(cache.get("c", "cd")).toBe(c);
    cache.get("d", "d");
    expect(cache.get("a", "a")).not.toBe(edited);
  });

  it("does not retain an oversized input or evict unrelated reusable segments for it", () => {
    const cache = createMarkdownAstCache({ maxBytes: 8 });
    const a = cache.get("a", "a");
    const oversized = cache.get("large", "0123456789");
    expect(cache.get("large", "0123456789")).not.toBe(oversized);
    expect(cache.get("a", "a")).toBe(a);
  });
});
