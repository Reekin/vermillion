import { spawn } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocFile, WorkItem } from "./contracts.js";
import { zSearchResult } from "./search-contract.js";
import type { SearchContextLine, SearchHit, SearchQuery, SearchResult, SearchStats } from "./search-contract.js";
export type { SearchContextLine, SearchHit, SearchQuery, SearchResult } from "./search-contract.js";

export type SearchSessionEntry = {
  sessionId: string;
  providerSessionId?: string;
  workspaceId: string;
  engineId?: string;
  providerKind?: string;
  title?: string;
  treeId?: string;
  treeTitle?: string;
  treeActivityAt?: string;
  activityAt?: string;
  createdAt?: string;
  lastCompletedTurnAt?: string;
  lastUserMessageAt?: string;
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
  pending: SearchHit[];
  truncated: boolean;
  onHits?: (hits: SearchHit[]) => void;
};

const MAX_CONTEXT_LINE_CHARS = 4_000;
/** Windows caps a command line around 32k characters, so rollout paths go to ripgrep in batches. */
const MAX_BATCH_ARGV_CHARS = 24_000;
/** Keeps incremental search events small enough for the UI to stay responsive on dense matches. */
const HIT_EVENT_BATCH_SIZE = 100;
/** Bytes read around a hit to rebuild its context without loading a multi-megabyte rollout line. */
const CONTEXT_WINDOW_BYTES = 32_768;
/** A session_meta header carries the originator; this covers it without reading the whole file. */
const HEADER_PROBE_BYTES = 262_144;
/** Prefix decoded to place a hit that sits beyond the context window of an oversized line. */
const COLUMN_PREFIX_LIMIT = 4_194_304;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const displaySessionTitle = (title: string | undefined): string => {
  const value = title?.trim();
  if (!value || /^codex-thread:[0-9a-f-]+$/i.test(value) || /^rollout-.*\.jsonl$/i.test(value)) {
    return "未命名会话";
  }
  return value;
};

/** `query` is already lower-cased by the caller; the haystack is lower-cased once per line. */
const findMatches = (text: string, query: string): Array<{ start: number; end: number }> => {
  const matches: Array<{ start: number; end: number }> = [];
  const haystack = text.toLowerCase();
  let from = 0;
  while (from <= haystack.length - query.length) {
    const start = haystack.indexOf(query, from);
    if (start < 0) break;
    matches.push({ start, end: start + query.length });
    from = start + query.length;
  }
  return matches;
};

/** Keeps one context line bounded around `focus` so an oversized rollout line never reaches the UI. */
const toContextLine = (
  line: number,
  rawText: string,
  query: string,
  focus = 0
): SearchContextLine => {
  if (rawText.length <= MAX_CONTEXT_LINE_CHARS) {
    return { line, text: rawText, matches: findMatches(rawText, query) };
  }
  const start = Math.max(
    0,
    Math.min(focus - Math.floor(MAX_CONTEXT_LINE_CHARS / 2), rawText.length - MAX_CONTEXT_LINE_CHARS)
  );
  const end = start + MAX_CONTEXT_LINE_CHARS;
  const text = (start > 0 ? "…" : "") + rawText.slice(start, end) + (end < rawText.length ? "…" : "");
  return { line, text, matches: findMatches(text, query) };
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
  accumulator.hits.push(hit);
  accumulator.pending.push(hit);
  return true;
};

const flushHits = (accumulator: SearchAccumulator): void => {
  if (!accumulator.onHits || accumulator.pending.length === 0) return;
  const batch = accumulator.pending;
  accumulator.pending = [];
  accumulator.onHits(batch);
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
    if (accumulator.pending.length >= HIT_EVENT_BATCH_SIZE) flushHits(accumulator);
  }
  return true;
};

const turnIdPattern = /"(?:turn_id|node_id)":"([^"]+)"/;

const scanTurnId = (text: string): string | undefined => turnIdPattern.exec(text)?.[1];

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

const isVermillionRollout = (header: string): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(header);
  } catch {
    return header.includes("\"originator\":\"vermillion\"");
  }
  if (!isRecord(value) || value.type !== "session_meta") return false;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return (
    asNonEmptyString(payload?.originator) === "vermillion" ||
    asNonEmptyString(value.originator) === "vermillion"
  );
};

const readRolloutHeader = async (path: string): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return newline >= 0 ? text.slice(0, newline) : text;
  } finally {
    await handle.close();
  }
};

// ---- ripgrep ----

const RIPGREP_EXECUTABLE = process.platform === "win32" ? "rg.exe" : "rg";
const RIPGREP_PLATFORM_DIR = `ripgrep-${process.platform}-${process.arch}`;

const ripgrepCandidates = (): string[] => {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const override = process.env.VERMILLION_RIPGREP?.trim();
  const candidates = override ? [override] : [];
  // Release layout: resources/app/ripgrep, one level above both dist-electron/ and cli/.
  candidates.push(resolve(moduleDir, "..", "ripgrep", RIPGREP_EXECUTABLE));
  // Repo layout: the installed platform package, wherever node_modules sits above this module.
  let dir = moduleDir;
  for (;;) {
    candidates.push(join(dir, "node_modules", "@vscode", RIPGREP_PLATFORM_DIR, "bin", RIPGREP_EXECUTABLE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
};

let ripgrepPath: Promise<string> | undefined;

const resolveRipgrepPath = (): Promise<string> => (ripgrepPath ??= (async () => {
  for (const candidate of ripgrepCandidates()) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error("Bundled ripgrep was not found; set VERMILLION_RIPGREP to the rg executable.");
})());

const batchPaths = (paths: string[]): string[][] => {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (current.length > 0 && length + path.length + 3 > MAX_BATCH_ARGV_CHARS) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(path);
    length += path.length + 3;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

type RolloutMatch = { path: string; line: number; byteOffset: number };
type RipgrepRun = { filesSearched: number; bytesSearched: number };

/**
 * Runs one ripgrep pass over a batch of rollout files. `--only-matching` keeps the output
 * proportional to the number of matches instead of the length of the matching lines, so a
 * twelve-megabyte JSONL line costs a few bytes here; the context is read back from the file.
 */
const runRipgrepBatch = async (input: {
  executable: string;
  paths: string[];
  query: string;
  /** False runs the pattern as a regex; the line index uses `^` to report every line start. */
  literal?: boolean;
  signal?: AbortSignal;
  onMatch: (match: RolloutMatch) => void;
}): Promise<RipgrepRun> => {
  const child = spawn(input.executable, [
    "--null", "--with-filename", "--no-heading", "--no-config", "--no-messages",
    "--only-matching", "--line-number", "--byte-offset",
    ...(input.literal === false ? [] : ["--fixed-strings"]), "--ignore-case", "--stats",
    "-e", input.query, "--", ...input.paths
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const run: RipgrepRun = { filesSearched: 0, bytesSearched: 0 };
  let stderr = "";
  let buffer = "";
  let killed = false;

  const kill = (): void => {
    if (killed) return;
    killed = true;
    child.kill();
  };
  input.signal?.addEventListener("abort", kill, { once: true });
  if (input.signal?.aborted) kill();

  const readStats = (line: string): void => {
    const files = /^(\d+) files searched$/.exec(line);
    if (files) {
      run.filesSearched = Number(files[1]);
      return;
    }
    const bytes = /^(\d+) bytes searched$/.exec(line);
    if (bytes) run.bytesSearched = Number(bytes[1]);
  };

  // `<path>\0<line>:<byte offset>:<matched text>`
  const consume = (line: string): void => {
    const separator = line.indexOf("\0");
    if (separator < 0) {
      readStats(line);
      return;
    }
    const firstColon = line.indexOf(":", separator + 1);
    if (firstColon < 0) return;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon < 0) return;
    const lineNumber = Number(line.slice(separator + 1, firstColon));
    const byteOffset = Number(line.slice(firstColon + 1, secondColon));
    if (!Number.isInteger(lineNumber) || !Number.isInteger(byteOffset)) return;
    input.onMatch({ path: line.slice(0, separator), line: lineNumber, byteOffset });
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let start = 0;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n", start)) {
      consume(buffer.slice(start, newline));
      start = newline + 1;
    }
    if (start > 0) buffer = buffer.slice(start);
  });

  try {
    await new Promise<void>((settle, fail) => {
      child.once("error", fail);
      child.once("close", (code) => {
        // Exit 1 only means "no matches"; per-file IO errors stay silent under --no-messages, so
        // anything on stderr is an argument or executable level failure worth surfacing.
        if (!killed && code !== null && code >= 2 && stderr.trim()) {
          fail(new Error("ripgrep failed: " + stderr.trim().split("\n")[0]));
          return;
        }
        settle();
      });
    });
  } finally {
    input.signal?.removeEventListener("abort", kill);
  }
  return run;
};

type HitWindow = {
  text: string;
  matchCharIndex: number;
  startPartial: boolean;
  endPartial: boolean;
};

const readHitWindow = async (path: string, byteOffset: number): Promise<HitWindow> => {
  const windowStart = Math.max(0, byteOffset - CONTEXT_WINDOW_BYTES);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(CONTEXT_WINDOW_BYTES * 2);
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.length, windowStart));
  } finally {
    await handle.close();
  }
  const window = buffer.subarray(0, bytesRead);
  const matchAt = Math.min(Math.max(0, byteOffset - windowStart), bytesRead);
  return {
    text: window.toString("utf8"),
    matchCharIndex: window.subarray(0, matchAt).toString("utf8").length,
    startPartial: windowStart > 0,
    endPartial: bytesRead === buffer.length
  };
};

type HitContext = {
  context: SearchContextLine[];
  column: number;
  hitText: string;
  /** False when the window cut the matching line, so its ends must be read separately. */
  hitComplete: boolean;
};

const buildHitContext = (
  window: HitWindow,
  line: number,
  query: string,
  contextLines: number
): HitContext => {
  const segments = window.text.split("\n");
  const starts: number[] = [];
  let cursor = 0;
  for (const segment of segments) {
    starts.push(cursor);
    cursor += segment.length + 1;
  }
  let hitIndex = segments.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    if (window.matchCharIndex <= starts[index]! + segments[index]!.length) {
      hitIndex = index;
      break;
    }
  }
  const from = Math.max(0, hitIndex - contextLines);
  const to = Math.min(segments.length - 1, hitIndex + contextLines);
  const context: SearchContextLine[] = [];
  for (let index = from; index <= to; index += 1) {
    const leading = index === 0 && window.startPartial;
    const trailing = index === segments.length - 1 && window.endPartial;
    const body = segments[index]!.replace(/\r$/, "");
    const text = (leading ? "…" : "") + body + (trailing ? "…" : "");
    const focus = index === hitIndex
      ? window.matchCharIndex - starts[index]! + (leading ? 1 : 0)
      : 0;
    context.push(toContextLine(line + (index - hitIndex), text, query, focus));
  }
  return {
    context,
    column: window.matchCharIndex - starts[hitIndex]! + 1,
    hitText: segments[hitIndex]!,
    hitComplete: !(hitIndex === 0 && window.startPartial) &&
      !(hitIndex === segments.length - 1 && window.endPartial)
  };
};

/**
 * Line start offsets for one rollout, taken from a ripgrep pass that reports every line. Only files
 * holding a hit on an oversized line need this, so normal results never pay for it.
 */
const readLineStarts = async (
  executable: string,
  path: string,
  signal: AbortSignal | undefined
): Promise<number[]> => {
  const starts: number[] = [];
  await runRipgrepBatch({
    executable,
    paths: [path],
    query: "^",
    literal: false,
    ...(signal ? { signal } : {}),
    onMatch: (match) => { starts[match.line] = match.byteOffset; }
  });
  return starts;
};

const readChunk = async (path: string, position: number, length: number): Promise<string> => {
  if (length <= 0) return "";
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(length);
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, position));
  } finally {
    await handle.close();
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
};

/** Rollout lines carry their turn id near one end, so both ends are probed within a fixed budget. */
const readTurnIdOnLine = async (path: string, start: number, end: number): Promise<string | undefined> => {
  const length = Math.max(0, end - start);
  const head = await readChunk(path, start, Math.min(length, CONTEXT_WINDOW_BYTES));
  const fromHead = scanTurnId(head);
  if (fromHead || length <= CONTEXT_WINDOW_BYTES * 2) return fromHead;
  return scanTurnId(await readChunk(path, end - CONTEXT_WINDOW_BYTES, CONTEXT_WINDOW_BYTES));
};

/**
 * Column of a hit whose line reaches past the context window. The window alone cannot tell how far
 * the match sits from the line start, so the prefix is decoded; past the limit the byte distance is
 * reported rather than reading megabytes for a number nobody can act on.
 */
const columnInLine = async (path: string, lineStart: number, byteOffset: number): Promise<number> => {
  const length = byteOffset - lineStart;
  if (length <= 0) return 1;
  if (length > COLUMN_PREFIX_LIMIT) return length + 1;
  return (await readChunk(path, lineStart, length)).length + 1;
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

const isInsideRolloutsDir = (path: string, rolloutsDir: string | undefined): boolean => {
  if (!rolloutsDir) return true;
  const pathRelativeToRollouts = relative(resolve(rolloutsDir), resolve(path));
  return Boolean(pathRelativeToRollouts) &&
    !isAbsolute(pathRelativeToRollouts) &&
    pathRelativeToRollouts !== ".." &&
    !pathRelativeToRollouts.startsWith(".." + (process.platform === "win32" ? "\\" : "/"));
};

/** Rollout files are named `rollout-<timestamp>-<provider session id>.jsonl`. */
const rolloutIdPattern = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** One pass over the rollouts directory, so resolving a thousand sessions stays a map lookup. */
const indexRolloutFiles = async (root: string): Promise<Map<string, string>> => {
  const index = new Map<string, string>();
  for (const path of await listRolloutFiles(root)) {
    const id = rolloutIdPattern.exec(basename(path))?.[1];
    if (id && !index.has(id.toLowerCase())) index.set(id.toLowerCase(), path);
  }
  return index;
};

const providerSessionId = (entry: SearchSessionEntry): string | undefined =>
  entry.providerSessionId ??
  (entry.sessionId.startsWith("codex-thread:")
    ? entry.sessionId.slice("codex-thread:".length)
    : undefined);

const searchRollouts = async (input: {
  entries: SearchSessionEntry[];
  rolloutsDir?: string;
  workspaceLabelById: Map<string, string>;
  query: string;
  contextLines: number;
  accumulator: SearchAccumulator;
  stats: SearchStats;
  signal?: AbortSignal;
}): Promise<void> => {
  const entryByPath = new Map<string, SearchSessionEntry>();
  let fileIndex: Map<string, string> | undefined;
  for (const entry of input.entries) {
    let path: string | undefined;
    if (entry.rolloutPath &&
      isInsideRolloutsDir(entry.rolloutPath, input.rolloutsDir) &&
      await isFile(entry.rolloutPath)) {
      path = entry.rolloutPath;
    } else if (input.rolloutsDir) {
      const providerId = providerSessionId(entry);
      if (providerId) {
        fileIndex ??= await indexRolloutFiles(input.rolloutsDir);
        path = fileIndex.get(providerId.toLowerCase());
      }
    }
    if (path && !entryByPath.has(path)) entryByPath.set(path, entry);
  }
  if (entryByPath.size === 0) return;
  const paths = [...entryByPath.keys()].sort((leftPath, rightPath) => {
    const left = entryByPath.get(leftPath)!;
    const right = entryByPath.get(rightPath)!;
    return (
      (right.treeActivityAt ?? right.activityAt ?? "").localeCompare(left.treeActivityAt ?? left.activityAt ?? "") ||
      (left.treeId ?? left.sessionId).localeCompare(right.treeId ?? right.sessionId) ||
      (right.activityAt ?? "").localeCompare(left.activityAt ?? "") ||
      left.sessionId.localeCompare(right.sessionId) ||
      basename(leftPath).localeCompare(basename(rightPath))
    );
  });
  const executable = await resolveRipgrepPath();
  const vermillionByPath = new Map<string, boolean>();
  const lineStartsByPath = new Map<string, Promise<number[]>>();
  const sharedPositionKeys = new Set<string>();

  const cutLineBounds = async (path: string, line: number): Promise<{ start: number; end: number } | undefined> => {
    let starts = lineStartsByPath.get(path);
    if (!starts) {
      starts = readLineStarts(executable, path, input.signal);
      lineStartsByPath.set(path, starts);
    }
    const offsets = await starts;
    const start = offsets[line];
    if (start === undefined) return undefined;
    const next = offsets[line + 1];
    const end = next === undefined ? (await stat(path).catch(() => undefined))?.size ?? start : next - 1;
    return { start, end };
  };

  for (const batch of batchPaths(paths)) {
    if (input.signal?.aborted || input.accumulator.truncated) return;
    const found = new Map<string, Map<number, number>>();
    const run = await runRipgrepBatch({
      executable,
      paths: batch,
      query: input.query,
      signal: input.signal,
      onMatch: (match) => {
        let lines = found.get(match.path);
        if (!lines) {
          lines = new Map();
          found.set(match.path, lines);
        }
        if (lines.has(match.line)) return;
        lines.set(match.line, match.byteOffset);
      }
    });
    input.stats.sourcesScanned += run.filesSearched || batch.length;
    input.stats.bytesScanned += run.bytesSearched;

    for (const path of batch) {
      if (input.signal?.aborted) return;
      const lines = found.get(path);
      if (!lines) continue;
      let vermillion = vermillionByPath.get(path);
      if (vermillion === undefined) {
        vermillion = isVermillionRollout(await readRolloutHeader(path).catch(() => ""));
        vermillionByPath.set(path, vermillion);
      }
      if (!vermillion) continue;
      const entry = entryByPath.get(path)!;
      const workspaceLabel = input.workspaceLabelById.get(entry.workspaceId)!;
      for (const [line, byteOffset] of [...lines].sort((a, b) => a[0] - b[0])) {
        if (input.signal?.aborted) return;
        const window = await readHitWindow(path, byteOffset);
        const built = buildHitContext(window, line, input.query, input.contextLines);
        let column = built.column;
        let turnId: string | undefined;
        if (built.hitComplete) {
          turnId = extractTurnId(built.hitText);
        } else {
          // The window holds only part of this line, so its start is needed for both the turn and
          // the column; one ripgrep pass over the file provides every line start.
          const bounds = await cutLineBounds(path, line);
          if (bounds) {
            turnId = await readTurnIdOnLine(path, bounds.start, bounds.end);
            column = await columnInLine(path, bounds.start, byteOffset);
          }
        }
        const treeId = entry.treeId ?? entry.sessionId;
        const treeTitle = displaySessionTitle(entry.treeTitle);
        const sharedPositionKey = turnId ? [treeId, turnId, line].join(":") : undefined;
        if (sharedPositionKey && sharedPositionKeys.has(sharedPositionKey)) continue;
        if (sharedPositionKey) sharedPositionKeys.add(sharedPositionKey);
        const hit = {
          id: `session:${entry.workspaceId}:${entry.sessionId}:${line}`,
          kind: "session" as const,
          workspaceId: entry.workspaceId,
          workspaceLabel,
          title: treeTitle,
          treeId,
          treeTitle,
          ...(entry.treeActivityAt ? { treeActivityAt: entry.treeActivityAt } : {}),
          ...(entry.activityAt ? { sessionActivityAt: entry.activityAt } : {}),
          path,
          line,
          column,
          context: built.context,
          sessionId: entry.sessionId,
          ...(turnId ? { turnId } : {})
        } satisfies SearchHit;
        if (!addHit(input.accumulator, hit)) break;
        if (input.accumulator.pending.length >= HIT_EVENT_BATCH_SIZE) flushHits(input.accumulator);
      }
      flushHits(input.accumulator);
      if (input.accumulator.truncated) return;
    }
  }
};

type SearchSessionRelation = {
  parentSessionId: string;
  childSessionId: string;
  relationType: string;
};

const latestTimestamp = (values: readonly (string | undefined)[]): string | undefined =>
  values.reduce<string | undefined>(
    (latest, value) => value && (!latest || value > latest) ? value : latest,
    undefined
  );

const decorateSessionSearchEntries = (
  entries: SearchSessionEntry[],
  relations: SearchSessionRelation[]
): SearchSessionEntry[] => {
  const parentBySessionId = new Map(
    relations
      .filter((relation) => relation.relationType === "fork")
      .map((relation) => [relation.childSessionId, relation.parentSessionId])
  );
  const entryBySessionId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const rootIdFor = (sessionId: string): string => {
    const seen = new Set<string>();
    let current = sessionId;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentBySessionId.get(current);
      if (!parent || !entryBySessionId.has(parent)) break;
      current = parent;
    }
    return current;
  };
  const membersByTree = new Map<string, SearchSessionEntry[]>();
  for (const entry of entries) {
    const treeId = rootIdFor(entry.sessionId);
    const members = membersByTree.get(treeId) ?? [];
    members.push(entry);
    membersByTree.set(treeId, members);
  }
  const metadataByTree = new Map<string, { title: string; activityAt: string | undefined }>();
  for (const [treeId, members] of membersByTree) {
    const root = entryBySessionId.get(treeId);
    metadataByTree.set(treeId, {
      title: displaySessionTitle(root?.title),
      activityAt: latestTimestamp(members.map((entry) => entry.activityAt))
    });
  }
  return entries.map((entry) => {
    const treeId = rootIdFor(entry.sessionId);
    const tree = metadataByTree.get(treeId)!;
    return {
      ...entry,
      treeId,
      treeTitle: tree.title,
      ...(tree.activityAt ? { treeActivityAt: tree.activityAt } : {})
    };
  });
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
  const entries = value.entries.flatMap((rawEntry): SearchSessionEntry[] => {
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
      ...(asNonEmptyString(rawEntry.createdAt) ? { createdAt: asNonEmptyString(rawEntry.createdAt) } : {}),
      ...(asNonEmptyString(rawEntry.lastCompletedTurnAt)
        ? { lastCompletedTurnAt: asNonEmptyString(rawEntry.lastCompletedTurnAt) }
        : {}),
      ...(asNonEmptyString(rawEntry.lastUserMessageAt)
        ? { lastUserMessageAt: asNonEmptyString(rawEntry.lastUserMessageAt) }
        : {}),
      activityAt: latestTimestamp([
        asNonEmptyString(rawEntry.lastCompletedTurnAt),
        asNonEmptyString(rawEntry.lastUserMessageAt),
        asNonEmptyString(rawEntry.createdAt)
      ]),
      ...(asNonEmptyString(metadata?.rolloutPath)
        ? { rolloutPath: asNonEmptyString(metadata?.rolloutPath) }
        : {})
    }];
  });
  const relations = Array.isArray(value.relations)
    ? value.relations.flatMap((rawRelation): SearchSessionRelation[] => {
      if (!isRecord(rawRelation)) return [];
      const parentSessionId = asNonEmptyString(rawRelation.parentSessionId);
      const childSessionId = asNonEmptyString(rawRelation.childSessionId);
      const relationType = asNonEmptyString(rawRelation.relationType);
      return parentSessionId && childSessionId && relationType
        ? [{ parentSessionId, childSessionId, relationType }]
        : [];
    })
    : [];
  const decorated = decorateSessionSearchEntries(entries, relations);
  return decorated.map((entry) => ({
    ...entry,
    activityAt: latestTimestamp([
      entry.lastCompletedTurnAt,
      entry.lastUserMessageAt,
      entry.createdAt
    ])
  }));
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
  /** Receives every hit as soon as it is built, for callers that render results while scanning. */
  onHits?: (hits: SearchHit[]) => void;
  signal?: AbortSignal;
}): Promise<SearchResult> => {
  const startedAt = Date.now();
  const query = input.query.query.trim().toLowerCase();
  const contextLines = input.query.contextLines ?? 3;
  const accumulator: SearchAccumulator = {
    hits: [],
    pending: [],
    truncated: false,
    ...(input.onHits ? { onHits: input.onHits } : {})
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

  const workspaceData = await Promise.all(workspaces.map(async (workspace) => ({
    workspace,
    workItems: await input.listWorkItems(workspace.workspaceId)
  })));

  for (const { workspace, workItems } of workspaceData) {
    if (input.signal?.aborted) break;
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
    flushHits(accumulator);
    if (accumulator.truncated) break;
    const docs = await input.listDocs(workspace.workspaceId);
    for (const doc of docs.filter((entry) => entry.isText !== false)) {
      let text: string;
      try {
        text = await input.readDoc(workspace.workspaceId, doc.path);
      } catch {
        continue;
      }
      const document: TextDocument = {
        kind: "doc",
        id: doc.path,
        workspaceId: workspace.workspaceId,
        workspaceLabel: workspace.label,
        title: doc.path.replace(/^\.vermillion\/docs\//, ""),
        path: doc.path,
        text
      };
      if (!searchTextDocument(document, query, contextLines, accumulator, stats)) break;
    }
    flushHits(accumulator);
    if (accumulator.truncated) break;
  }

  if (!accumulator.truncated && input.sessionSearch && !input.signal?.aborted) {
    const entries = (await input.sessionSearch()).filter((entry) =>
      workspaceLabelById.has(entry.workspaceId) &&
      entry.providerKind === "codex-thread"
    );
    await searchRollouts({
      entries,
      ...(input.rolloutsDir ? { rolloutsDir: input.rolloutsDir } : {}),
      workspaceLabelById,
      query,
      contextLines,
      accumulator,
      stats,
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  flushHits(accumulator);
  stats.durationMs = Math.max(0, Date.now() - startedAt);
  stats.truncated = accumulator.truncated;
  return zSearchResult.parse({
    query: input.query.query.trim(),
    hits: accumulator.hits,
    stats
  });
};
