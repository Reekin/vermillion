import { z } from "zod";

const zSearchMatch = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive()
});

const zSearchContextLine = z.object({
  line: z.number().int().positive(),
  text: z.string(),
  matches: z.array(zSearchMatch)
});

export const zSearchQuery = z.object({
  query: z.string().trim().min(1).max(200),
  workspaceId: z.string().min(1).optional(),
  contextLines: z.number().int().min(0).max(8).optional(),
  maxResults: z.number().int().min(1).max(500).optional()
});

export const zSearchHit = z.object({
  id: z.string().min(1),
  kind: z.enum(["workItem", "session", "doc"]),
  workspaceId: z.string().min(1),
  workspaceLabel: z.string().min(1),
  title: z.string().min(1),
  treeId: z.string().min(1).optional(),
  treeTitle: z.string().min(1).optional(),
  treeActivityAt: z.string().min(1).optional(),
  sessionActivityAt: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  context: z.array(zSearchContextLine).min(1),
  workItemId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional()
});

export const zSearchStats = z.object({
  sourcesScanned: z.number().int().nonnegative(),
  bytesScanned: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export const zSearchResult = z.object({
  query: z.string().min(1),
  hits: z.array(zSearchHit),
  stats: zSearchStats
});

/** Streaming search: the caller receives hits as `search.hits` events until `search.completed`. */
export const zSearchStartResult = z.object({ queryId: z.string().min(1) });

export const zSearchCancel = z.object({ queryId: z.string().min(1) });

export const zSearchCancelResult = z.object({ cancelled: z.boolean() });

export type SearchQuery = z.infer<typeof zSearchQuery>;
export type SearchContextLine = z.infer<typeof zSearchContextLine>;
export type SearchHit = z.infer<typeof zSearchHit>;
export type SearchStats = z.infer<typeof zSearchStats>;
export type SearchResult = z.infer<typeof zSearchResult>;
