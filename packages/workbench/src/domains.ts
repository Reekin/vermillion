import type { DomainConfig, DomainDefinition } from "./contracts.js";

export const DOMAINS_DIR = ".vermillion/docs/domains/";

export const domainIdFromPath = (path: string): string | undefined => {
  if (!path.startsWith(DOMAINS_DIR)) return undefined;
  const name = path.slice(DOMAINS_DIR.length);
  return name.endsWith(".md") && !name.slice(0, -3).includes("/") ? name.slice(0, -3) : undefined;
};

export const assertDomainId = (domainId: string): void => {
  if (!/^[a-z][a-z0-9-]*$/.test(domainId)) throw new Error("Invalid domain id: " + domainId);
};

const frontmatter = (content: string): string | undefined =>
  content.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m)?.[1];

export const parseStandards = (content: string): string[] => {
  const header = frontmatter(content);
  if (!header) return [];
  const lines = header.split(/\r?\n/);
  const start = lines.findIndex((line) => /^standards\s*:/.test(line));
  if (start < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/)?.[1];
    if (item) { paths.push(item.replace(/^("|')(.*)\1$/, "$2")); continue; }
    if (line.trim()) break;
  }
  return paths;
};

export const parseDomainDefinition = (path: string, content: string, config: DomainConfig): DomainDefinition => {
  const domainId = domainIdFromPath(path);
  if (!domainId) throw new Error("Domain definition must be a direct Markdown file under " + DOMAINS_DIR);
  const body = content.replace(/^---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m, "");
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || domainId;
  const afterTitle = body.replace(/^\s*#\s+.+\r?\n/, "");
  // The first paragraph of prose after the title, whatever heading it sits under.
  const summary = afterTitle.split(/\r?\n\s*\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join(" ").trim())
    .find(Boolean)?.replace(/\s+/g, " ") ?? "";
  return { domainId, title, summary, path, standards: parseStandards(content), config };
};

export const nextRunAt = (now: string, hours: number): string =>
  new Date(Date.parse(now) + hours * 60 * 60 * 1000).toISOString();

export const defaultDomainConfig = (domainId: string, now: string, lastCommit?: string): DomainConfig => ({
  domainId,
  enabled: true,
  changeTrigger: true,
  intervalHours: 6,
  triggerPaths: [],
  autoWorkEnabled: false,
  authorizationScope: [],
  lastCommit,
  nextRunAt: nextRunAt(now, 6),
  createdAt: now,
  updatedAt: now
});

export const pathMatches = (path: string, configured: string[]): boolean => configured.some((candidate) => {
  const prefix = candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return !!prefix && (path === prefix || path.startsWith(prefix + "/"));
});
