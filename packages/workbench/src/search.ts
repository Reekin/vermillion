import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DocFile, WorkItem } from "./contracts.js";
import { zSearchResult } from "./search-contract.js";
import type { SearchContextLine, SearchHit, SearchQuery, SearchResult } from "./search-contract.js";
export type { SearchContextLine, SearchHit, SearchQuery, SearchResult } from "./search-contract.js";

export type SearchSessionEntry = {
  sessionId: string;
  providerSessionId?: string;
  workspaceId: string;
  engineId?: string;
  providerKind?: string;
  title?: string;
  rolloutPath?: string;
};

export type SessionSearchSource = () =>
  | SearchSessionEntry[]
  | Promise<SearchSessionEntry[]>;

type SearchWorkspace = {
  workspaceId: string;
  rootPath: string;
  label: string;
};

type TextDocument = {
  kind: "workItem" | "doc";
  id: string;
  workspaceId: string;
  workspaceLabel: string;
  title: string;
  path?: string;
  text: string;
  workItemId?: string;
};

type SearchAccumulator = {
  hits: SearchHit[];
  maxResults: number;
  truncated: boolean;
};

type SearchStats = {
  sourcesScanned: number;
  bytesScanned: number;
  durationMs: number;
  truncated: boolean;
};

const MAX_CONTEXT_LINE_CHARS = 4_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const findMatches = (text: string, query: string): Array<{ start: number; end: number }> => {
  const matches: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from < text.length) {
    const start = text.toLowerCase().indexOf(query, from);
    if (start < 0) break;
    matches.push({ start, end: start + query.length });
    from = start + Math.max(1, query.length);
  }
  return matches;
};

const toContextLine = (
  line: number,
  rawText: string,
  query: string
): SearchContextLine => {
  const matches = findMatches(rawText, query);
  if (rawText.length <= MAX_CONTEXT_LINE_CHARS) {
    return { line, text: rawText, matches };
  }

  if (matches.length === 0) {
    return {
      line,
      text: rawText.slice(0, MAX_CONTEXT_LINE_CHARS) + "…",
      matches: []
    };
  }

  const firstMatch = matches[0]!;
  const start = Math.max(
    0,
    Math.min(firstMatch.start - 1_800, rawText.length - MAX_CONTEXT_LINE_CHARS)
  );
  const end = Math.min(rawText.length, start + MAX_CONTEXT_LINE_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < rawText.length ? "…" : "";
  return {
    line,
    text: prefix + rawText.slice(start, end) + suffix,
    matches: matches
      .filter((match) => match.start >= start && match.end <= end)
      .map((match) => ({
        start: match.start - start + prefix.length,
        end: match.end - start + prefix.length
      }))
  };
};

const contextForLines = (
  lines: string[],
  index: number,
  query: string,
  contextLines: number
): SearchContextLine[] => {
  const start = Math.max(0, index - contextLines);
  const end = Math.min(lines.length, index + contextLines + 1);
  return lines
    .slice(start, end)
    .map((text, offset) => toContextLine(start + offset + 1, text, query));
};

const addHit = (accumulator: SearchAccumulator, hit: SearchHit): boolean => {
  if (accumulator.hits.length >= accumulator.maxResults) {
    accumulator.truncated = true;
    return false;
  }
  accumulator.hits.push(hit);
  return true;
};

const searchTextDocument = (
  document: TextDocument,
  query: string,
  contextLines: number,
  accumulator: SearchAccumulator,
  stats: SearchStats
): boolean => {
  const lines = document.text.split(/\r?\n/);
  stats.sourcesScanned += 1;
  stats.bytesScanned += Buffer.byteLength(document.text, "utf8");
  for (let index = 0; index < lines.length; index += 1) {
    const matches = findMatches(lines[index]!, query);
    if (matches.length === 0) continue;
    const hit = {
      id: `${document.kind}:${document.workspaceId}:${document.id}:${index + 1}`,
      kind: document.kind,
      workspaceId: document.workspaceId,
      workspaceLabel: document.workspaceLabel,
      title: document.title,
      ...(document.path ? { path: document.path } : {}),
      line: index + 1,
      column: matches[0]!.start + 1,
      context: contextForLines(lines, index, query, contextLines),
      ...(document.workItemId ? { workItemId: document.workItemId } : {})
    } satisfies SearchHit;
    if (!addHit(accumulator, hit)) return false;
  }
  return true;
};

const extractTurnId = (line: string): string | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const item = payload && isRecord(payload.item) ? payload.item : undefined;
  const metadata = isRecord(value.internal_chat_message_metadata_passthrough)
    ? value.internal_chat_message_metadata_passthrough
    : isRecord(payload?.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
  return (
    asNonEmptyString(value.turn_id) ??
    asNonEmptyString(payload?.turn_id) ??
    asNonEmptyString(payload?.turnId) ??
    asNonEmptyString(item?.turn_id) ??
    asNonEmptyString(item?.turnId) ??
    asNonEmptyString(metadata?.turn_id)
  );
};

const isVermillionRollout = (line: string): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(value) || value.type !== "session_meta") return false;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return (
    asNonEmptyString(payload?.originator) === "vermillion" ||
    asNonEmptyString(value.originator) === "vermillion"
  );
};

type PendingFileHit = {
  line: number;
  column: number;
  turnId?: string;
  context: SearchContextLine[];
  remainingAfter: number;
};

type RolloutSearchResult = {
  readable: boolean;
  bytesScanned: number;
};

const searchRolloutFile = async (
  path: string,
  entry: SearchSessionEntry,
  workspaceLabel: string,
  query: string,
  contextLines: number,
  accumulator: SearchAccumulator,
  stats: SearchStats
): Promise<RolloutSearchResult> => {
  let fileInfo: Awaited<ReturnType<typeof stat>>;
  try {
    fileInfo = await stat(path);
    if (!fileInfo.isFile()) return { readable: false, bytesScanned: 0 };
  } catch {
    return { readable: false, bytesScanned: 0 };
  }

  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const before: string[] = [];
  const pending: PendingFileHit[] = [];
  let lineNumber = 0;
  let bytesScanned = 0;
  let stopped = false;

  const emitPending = (pendingHit: PendingFileHit): void => {
    const hit = {
      id: `session:${entry.workspaceId}:${entry.sessionId}:${pendingHit.line}`,
      kind: "session" as const,
      workspaceId: entry.workspaceId,
      workspaceLabel,
      title: entry.title?.trim() || basename(path),
      path,
      line: pendingHit.line,
      column: pendingHit.column,
      context: pendingHit.context,
      sessionId: entry.sessionId,
      ...(pendingHit.turnId ? { turnId: pendingHit.turnId } : {})
    } satisfies SearchHit;
    if (!addHit(accumulator, hit)) stopped = true;
  };

  try {
    for await (const line of reader) {
      lineNumber += 1;
      bytesScanned += Buffer.byteLength(line, "utf8") + 1;
      if (lineNumber === 1 && !isVermillionRollout(line)) {
        return { readable: false, bytesScanned };
      }

      for (const pendingHit of pending) {
        if (pendingHit.remainingAfter > 0) {
          pendingHit.context.push(toContextLine(lineNumber, line, query));
          pendingHit.remainingAfter -= 1;
        }
      }

      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const pendingHit = pending[index]!;
        if (pendingHit.remainingAfter > 0) continue;
        pending.splice(index, 1);
        emitPending(pendingHit);
      }
      if (stopped) break;

      const matches = findMatches(line, query);
      if (matches.length > 0) {
        pending.push({
          line: lineNumber,
          column: matches[0]!.start + 1,
          turnId: extractTurnId(line),
          context: [
            ...before.map((text, offset) =>
              toContextLine(lineNumber - before.length + offset, text, query)
            ),
            toContextLine(lineNumber, line, query)
          ],
          remainingAfter: contextLines
        });
        if (contextLines === 0) {
          const pendingHit = pending.pop()!;
          emitPending(pendingHit);
        }
      }

      before.push(line);
      if (before.length > contextLines) before.shift();
      if (stopped) break;
    }

    if (!stopped) {
      for (const pendingHit of pending) emitPending(pendingHit);
    }
  } catch {
    return { readable: false, bytesScanned };
  } finally {
    reader.close();
    stream.destroy();
  }

  stats.sourcesScanned += 1;
  stats.bytesScanned += bytesScanned;
  return { readable: true, bytesScanned };
};

const listRolloutFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  };
  await walk(root);
  return files;
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const resolveRolloutPath = async (
  entry: SearchSessionEntry,
  rolloutsDir: string | undefined,
  discoveredFiles: Promise<string[]> | undefined
): Promise<{ path?: string; discoveredFiles?: Promise<string[]> }> => {
  const isInsideRolloutsDir = (path: string): boolean => {
    if (!rolloutsDir) return true;
    const pathRelativeToRollouts = relative(resolve(rolloutsDir), resolve(path));
    return Boolean(pathRelativeToRollouts) &&
      !isAbsolute(pathRelativeToRollouts) &&
      pathRelativeToRollouts !== ".." &&
      !pathRelativeToRollouts.startsWith(".." + (process.platform === "win32" ? "\\" : "/"));
  };
  if (entry.rolloutPath && isInsideRolloutsDir(entry.rolloutPath) && await isFile(entry.rolloutPath)) {
    return { path: entry.rolloutPath, discoveredFiles };
  }
  if (!rolloutsDir) return { discoveredFiles };
  const providerId = entry.providerSessionId ??
    (entry.sessionId.startsWith("codex-thread:")
      ? entry.sessionId.slice("codex-thread:".length)
      : undefined);
  if (!providerId) return { discoveredFiles };
  const filesPromise = discoveredFiles ?? listRolloutFiles(rolloutsDir);
  const path = (await filesPromise).find((candidate) =>
    basename(candidate).includes(providerId)
  );
  return { path, discoveredFiles: filesPromise };
};

const readFileSessionEntries = async (baseDir: string): Promise<SearchSessionEntry[]> => {
  let raw: string;
  try {
    raw = await readFile(join(baseDir, "session-index.json"), "utf8");
  } catch {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  return value.entries.flatMap((rawEntry): SearchSessionEntry[] => {
    if (!isRecord(rawEntry)) return [];
    const sessionId = asNonEmptyString(rawEntry.sessionId);
    const workspaceId = asNonEmptyString(rawEntry.workspaceId);
    if (!sessionId || !workspaceId) return [];
    const metadata = isRecord(rawEntry.metadata) ? rawEntry.metadata : undefined;
    return [{
      sessionId,
      workspaceId,
      ...(asNonEmptyString(rawEntry.providerSessionId)
        ? { providerSessionId: asNonEmptyString(rawEntry.providerSessionId) }
        : {}),
      ...(asNonEmptyString(rawEntry.engineId)
        ? { engineId: asNonEmptyString(rawEntry.engineId) }
        : {}),
      ...(asNonEmptyString(rawEntry.providerKind)
        ? { providerKind: asNonEmptyString(rawEntry.providerKind) }
        : {}),
      ...(asNonEmptyString(rawEntry.title) ? { title: asNonEmptyString(rawEntry.title) } : {}),
      ...(asNonEmptyString(metadata?.rolloutPath)
        ? { rolloutPath: asNonEmptyString(metadata?.rolloutPath) }
        : {})
    }];
  });
};

export const createFileSessionSearchSource = (baseDir: string): SessionSearchSource =>
  () => readFileSessionEntries(baseDir);

export const defaultCodexRolloutsDir = (
  env: NodeJS.ProcessEnv = process.env
): string => join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");

export const searchWorkbench = async (input: {
  query: SearchQuery;
  workspaces: SearchWorkspace[];
  listWorkItems: (workspaceId: string) => Promise<WorkItem[]>;
  listDocs: (workspaceId: string) => Promise<DocFile[]>;
  readDoc: (workspaceId: string, path: string) => Promise<string>;
  sessionSearch?: SessionSearchSource;
  rolloutsDir?: string;
}): Promise<SearchResult> => {
  const startedAt = Date.now();
  const query = input.query.query.trim().toLowerCase();
  const contextLines = input.query.contextLines ?? 3;
  const accumulator: SearchAccumulator = {
    hits: [],
    maxResults: input.query.maxResults ?? 200,
    truncated: false
  };
  const stats: SearchStats = {
    sourcesScanned: 0,
    bytesScanned: 0,
    durationMs: 0,
    truncated: false
  };
  const workspaces = input.workspaces.filter((workspace) =>
    !input.query.workspaceId || workspace.workspaceId === input.query.workspaceId
  );
  const workspaceLabelById = new Map(
    workspaces.map((workspace) => [workspace.workspaceId, workspace.label])
  );

  const workspaceData = await Promise.all(workspaces.map(async (workspace) => {
    const [workItems, docs] = await Promise.all([
      input.listWorkItems(workspace.workspaceId),
      input.listDocs(workspace.workspaceId)
    ]);
    const textDocs: Array<TextDocument | undefined> = await Promise.all(docs
      .filter((doc) => doc.isText !== false)
      .map(async (doc) => {
        try {
          return {
            kind: "doc" as const,
            id: doc.path,
            workspaceId: workspace.workspaceId,
            workspaceLabel: workspace.label,
            title: doc.path.replace(/^\.vermillion\/docs\//, ""),
            path: doc.path,
            text: await input.readDoc(workspace.workspaceId, doc.path)
          } satisfies TextDocument;
        } catch {
          return undefined;
        }
      }));
    return {
      workspace,
      workItems,
      textDocs: textDocs.filter((doc): doc is TextDocument => Boolean(doc))
    };
  }));

  for (const { workspace, workItems, textDocs } of workspaceData) {
    for (const workItem of workItems) {
      const document: TextDocument = {
        kind: "workItem",
        id: workItem.workItemId,
        workspaceId: workspace.workspaceId,
        workspaceLabel: workspace.label,
        title: workItem.title,
        text: JSON.stringify(workItem, null, 2),
        workItemId: workItem.workItemId
      };
      if (!searchTextDocument(document, query, contextLines, accumulator, stats)) break;
    }
    if (accumulator.truncated) break;
    for (const document of textDocs) {
      if (!searchTextDocument(document, query, contextLines, accumulator, stats)) break;
    }
    if (accumulator.truncated) break;
  }

  let discoveredFiles: Promise<string[]> | undefined;
  if (!accumulator.truncated && input.sessionSearch) {
    const entries = (await input.sessionSearch()).filter((entry) =>
      workspaceLabelById.has(entry.workspaceId) &&
      entry.engineId === "codex" &&
      entry.providerKind === "codex-thread"
    );
    for (const entry of entries) {
      const resolved = await resolveRolloutPath(entry, input.rolloutsDir, discoveredFiles);
      discoveredFiles = resolved.discoveredFiles;
      if (!resolved.path) continue;
      await searchRolloutFile(
        resolved.path,
        entry,
        workspaceLabelById.get(entry.workspaceId)!,
        query,
        contextLines,
        accumulator,
        stats
      );
      if (accumulator.truncated) break;
    }
  }

  stats.durationMs = Math.max(0, Date.now() - startedAt);
  stats.truncated = accumulator.truncated;
  return zSearchResult.parse({
    query: input.query.query.trim(),
    hits: accumulator.hits,
    stats
  });
};
