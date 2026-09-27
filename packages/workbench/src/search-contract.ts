import { z } from "zod";

const zSearchMatch = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive()
});

/** Who a session hit belongs to: the user, the agent's reply, or a tool call shown in the process steps. */
export const zSearchSource = z.enum(["user", "agent", "tool"]);

const zToolStepResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running") }),
  z.object({ kind: z.literal("failed"), exitCode: z.number().int().optional() }),
  z.object({ kind: z.literal("output"), lines: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("agents"), errored: z.number().int().nonnegative(), completed: z.number().int().nonnegative() })
]);

/**
 * Tool-call lines carry the step's action and result as structure; `text` is only the object taken
 * from the record (file, command, query), which is all that search matches. The interface words
 * the action and result in its own language.
 */
const zSearchToolStep = z.object({
  kind: z.string().min(1),
  agentAction: z.string().min(1).optional(),
  result: zToolStepResult.optional()
});

/** Which part of the work item detail a line is (acceptance, review and results are 1-based). */
const zSearchWorkItemPart = z.object({
  kind: z.enum(["title", "objective", "inScope", "outOfScope", "acceptance", "acceptanceResult", "review", "decision", "summary"]),
  index: z.number().int().positive().optional()
});

/**
 * Session hits and their neighbours are messages (`line` is the rollout line the message sits on);
 * work item hits and neighbours are parts of the detail, `part` naming the place (acceptance 3).
 */
const zSearchContextLine = z.object({
  line: z.number().int().positive(),
  text: z.string(),
  matches: z.array(zSearchMatch),
  source: zSearchSource.optional(),
  part: zSearchWorkItemPart.optional(),
  toolStep: zSearchToolStep.optional()
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
  /** Empty for a session without a title of its own. */
  title: z.string(),
  treeId: z.string().min(1).optional(),
  treeTitle: z.string().optional(),
  treeActivityAt: z.string().min(1).optional(),
  sessionActivityAt: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  context: z.array(zSearchContextLine).min(1),
  workItemId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  /** Session hits only: message source, tool action kind, 1-based turn number and message time. */
  source: zSearchSource.optional(),
  toolKind: z.string().min(1).optional(),
  turnNumber: z.number().int().positive().optional(),
  messageAt: z.string().min(1).optional()
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
export type SearchSource = z.infer<typeof zSearchSource>;
export type SearchContextLine = z.infer<typeof zSearchContextLine>;
export type SearchToolStep = z.infer<typeof zSearchToolStep>;
export type SearchWorkItemPart = z.infer<typeof zSearchWorkItemPart>;
export type SearchHit = z.infer<typeof zSearchHit>;
export type SearchStats = z.infer<typeof zSearchStats>;
export type SearchResult = z.infer<typeof zSearchResult>;
