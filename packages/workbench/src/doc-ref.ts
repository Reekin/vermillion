export type MarkdownSection = {
  path: string[];
  text: string;
  startLine: number;
  endLine: number;
};

export class DocumentSectionError extends Error {
  constructor(readonly section: string, message: string) {
    super(`文档段落“${section}”${message}`);
  }
}

type Heading = { index: number; level: number; text: string; path: string[] };

const sectionPath = (section: string): string[] => {
  const parts = section.split(/\s+\/\s+/).map((part) => part.trim());
  if (!parts.length || parts.some((part) => !part)) {
    throw new DocumentSectionError(section, "不是有效的标题路径；请使用实际标题，重复标题用完整祖先路径区分。");
  }
  return parts;
};

const markdownHeadings = (content: string): { lines: string[]; headings: Heading[] } => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const headings: Heading[] = [];
  const ancestors: Heading[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1]!.length;
    const text = match[2]!.replace(/\s+#+\s*$/, "").trim();
    while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
    const heading = { index, level, text, path: [...ancestors.map((entry) => entry.text), text] };
    headings.push(heading);
    ancestors.push(heading);
  }
  return { lines, headings };
};

const samePath = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

/** Resolve an exact Markdown heading. A bare unique title is allowed; duplicate titles need the full ancestor path. */
export const locateMarkdownSection = (content: string, section: string): MarkdownSection => {
  const requested = sectionPath(section);
  const { lines, headings } = markdownHeadings(content);
  const matches = requested.length === 1
    ? headings.filter((heading) => heading.text === requested[0])
    : headings.filter((heading) => samePath(heading.path, requested));
  if (!matches.length) throw new DocumentSectionError(section, "不存在；section 必须使用文档中的实际标题。");
  if (matches.length > 1) throw new DocumentSectionError(section, "不唯一；请使用完整祖先标题路径区分。");
  const heading = matches[0]!;
  const end = headings.find((next) => next.index > heading.index && next.level <= heading.level)?.index ?? lines.length;
  return {
    path: heading.path,
    text: lines.slice(heading.index, end).join("\n").trimEnd(),
    startLine: heading.index + 1,
    endLine: end
  };
};

/** A scoped notice needs only the referenced block, not unrelated changes from the same file. */
export const sectionDiff = (path: string, section: string, before: string, after: string): string => {
  const header = `--- ${path}#${section}\n+++ ${path}#${section}`;
  return [header, ...before.split("\n").map((line) => "-" + line), ...after.split("\n").map((line) => "+" + line)].join("\n");
};
