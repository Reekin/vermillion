import { spawn } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocFile, WorkItem } from "./contracts.js";
import { zSearchResult } from "./search-contract.js";
import type { SearchContextLine, SearchHit, SearchQuery, SearchResult, SearchSource, SearchStats } from "./search-contract.js";
import type { ToolAction, ToolCall } from "@vermillion/shared";
import { describeToolStep } from "@vermillion/shared/tool-actions";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
export type { SearchContextLine, SearchHit, SearchQuery, SearchResult, SearchSource } from "./search-contract.js";

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
  archivedAt?: string;
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
/** A session_meta header carries the originator; this covers it without reading the whole file. */
const HEADER_PROBE_BYTES = 262_144;
/** Message lines longer than this are skipped; only tool output makes a rollout line this large. */
const MAX_MESSAGE_LINE_BYTES = 4_194_304;
const LINE_READ_CHUNK_BYTES = 65_536;
/** Neighbouring messages in the preview are cut to this many characters. */
const NEIGHBOUR_TEXT_CHARS = 600;

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

type RolloutMatch = { path: string; line: number; byteOffset: number; text: string };
type RipgrepRun = { filesSearched: number; bytesSearched: number };

/**
 * Runs one ripgrep pass over a batch of rollout files. `--only-matching` keeps the output
 * proportional to the number of matches instead of the length of the matching lines, so a
 * twelve-megabyte JSONL line costs a few bytes here; the context is read back from the file.
 */
const runRipgrepBatch = async (input: {
  executable: string;
  paths: string[];
  /** Any of these patterns matches. */
  patterns: string[];
  /** False runs the pattern as a regex; the line index uses `^` to report every line start. */
  literal?: boolean;
  caseSensitive?: boolean;
  signal?: AbortSignal;
  onMatch: (match: RolloutMatch) => void;
}): Promise<RipgrepRun> => {
  const child = spawn(input.executable, [
    "--null", "--with-filename", "--no-heading", "--no-config", "--no-messages",
    "--only-matching", "--line-number", "--byte-offset",
    ...(input.literal === false ? [] : ["--fixed-strings"]), ...(input.caseSensitive ? [] : ["--ignore-case"]), "--stats",
    ...input.patterns.flatMap((pattern) => ["-e", pattern]), "--", ...input.paths
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
    input.onMatch({ path: line.slice(0, separator), line: lineNumber, byteOffset, text: line.slice(secondColon + 1) });
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

// ---- rollout messages ----

/**
 * Heads of the rollout records that make up what a session shows: completed items (user messages,
 * agent replies, tool calls), legacy user/agent message events, and the turn markers that number
 * turns. Only the fixed-width head is matched, so a pass over a huge rollout outputs a few hundred
 * bytes per record.
 */
const ROLLOUT_INDEX_PATTERN =
  String.raw`^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"(?:` +
  String.raw`item_completed","thread_id":"[^"]*","turn_id":"[^"]*","item":\{"type":"[A-Za-z]+"` +
  String.raw`|user_message"|agent_message"|task_started","turn_id":"[^"]*"` +
  String.raw`|chat_tree_node_started","revision":\d+,"node_id":"[^"]*","parent_node_id":(?:null|"[^"]*"),"turn_id":"[^"]*","order":\d+)`;

const toolItemTypes = new Set([
  "CommandExecution", "McpToolCall", "DynamicToolCall", "CollabAgentToolCall", "WebSearch",
  "ImageView", "ImageGeneration", "Reasoning", "Extension"
]);

export type RolloutMessageRecord = {
  line: number;
  /** Byte offset of the line start. */
  start: number;
  source: SearchSource;
  turnId?: string;
  at: string;
};

export type RolloutIndex = {
  messages: RolloutMessageRecord[];
  indexByLine: Map<number, number>;
  turnNumbers: Map<string, number>;
};

/** Builds the message list of one rollout from the heads reported by the index pattern, in file order. */
export const buildRolloutIndex = (heads: Array<{ line: number; byteOffset: number; text: string }>): RolloutIndex => {
  const messages: RolloutMessageRecord[] = [];
  const nodeOrders = new Map<string, number>();
  const startedTurns: string[] = [];
  let currentTurnId: string | undefined;
  for (const head of [...heads].sort((left, right) => left.line - right.line)) {
    const at = /^\{"timestamp":"([^"]*)"/.exec(head.text)?.[1] ?? "";
    const item = /"turn_id":"([^"]*)","item":\{"type":"([A-Za-z]+)"/.exec(head.text);
    if (item) {
      const [, turnId, itemType] = item;
      const source: SearchSource | undefined = itemType === "UserMessage"
        ? "user"
        : itemType === "AgentMessage" ? "agent" : toolItemTypes.has(itemType!) ? "tool" : undefined;
      if (source) messages.push({ line: head.line, start: head.byteOffset, source, at, ...(turnId ? { turnId } : {}) });
      continue;
    }
    const node = /"turn_id":"([^"]*)","order":(\d+)/.exec(head.text);
    if (node) {
      nodeOrders.set(node[1]!, Number(node[2]));
      continue;
    }
    const started = /"task_started","turn_id":"([^"]*)"/.exec(head.text);
    if (started) {
      currentTurnId = started[1]!;
      if (!startedTurns.includes(currentTurnId)) startedTurns.push(currentTurnId);
      continue;
    }
    const legacy = /"type":"(user_message|agent_message)"/.exec(head.text);
    if (legacy) {
      messages.push({
        line: head.line,
        start: head.byteOffset,
        source: legacy[1] === "user_message" ? "user" : "agent",
        at,
        ...(currentTurnId ? { turnId: currentTurnId } : {})
      });
    }
  }
  // Vermillion records each turn's depth on its session path; older rollouts only number by order.
  const turnNumbers = new Map<string, number>(
    nodeOrders.size > 0
      ? [...nodeOrders].map(([turnId, order]) => [turnId, order + 1])
      : startedTurns.map((turnId, index) => [turnId, index + 1])
  );
  return {
    messages,
    indexByLine: new Map(messages.map((message, index) => [message.line, index])),
    turnNumbers
  };
};

/** One ripgrep pass per argv batch indexes every candidate rollout, instead of one process per file. */
const readRolloutIndexes = async (
  executable: string,
  paths: string[],
  signal: AbortSignal | undefined
): Promise<Map<string, RolloutIndex>> => {
  const heads = new Map<string, Array<{ line: number; byteOffset: number; text: string }>>(paths.map((path) => [path, []]));
  for (const batch of batchPaths(paths)) {
    if (signal?.aborted) break;
    await runRipgrepBatch({
      executable,
      paths: batch,
      patterns: [ROLLOUT_INDEX_PATTERN],
      literal: false,
      caseSensitive: true,
      ...(signal ? { signal } : {}),
      onMatch: (match) => { heads.get(match.path)?.push(match); }
    });
  }
  return new Map([...heads].map(([path, pathHeads]) => [path, buildRolloutIndex(pathHeads)]));
};

/** Reads one rollout line from its start; undefined when it exceeds the message size limit. */
const readRolloutLine = async (path: string, start: number): Promise<string | undefined> => {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let position = start;
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(LINE_READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      const chunk = buffer.subarray(0, newline >= 0 ? newline : bytesRead);
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_MESSAGE_LINE_BYTES) return undefined;
      if (newline >= 0) break;
      position += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
  } finally {
    await handle.close();
  }
};

const textParts = (content: unknown, type: string): string =>
  Array.isArray(content)
    ? content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === type && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
    : "";

const compactJson = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const shellFlags = new Set(["-lc", "-c", "-command", "/c"]);

/** Codex records `[shell, -lc, script]`; the script is what the message area reads as the command. */
const commandText = (command: unknown): string =>
  Array.isArray(command)
    ? command.length >= 3 && shellFlags.has(String(command[command.length - 2]).toLowerCase())
      ? String(command[command.length - 1])
      : command.map(String).join(" ")
    : typeof command === "string" ? command : "";

/** Same reading of Codex's parsed command as the message area: omitted when no part is classified. */
const parsedCommandActions = (parsed: unknown): ToolAction[] | undefined => {
  if (!Array.isArray(parsed)) return undefined;
  const actions = parsed.filter(isRecord).map((action): ToolAction => {
    const path = asNonEmptyString(action.path);
    switch (action.type) {
      case "read":
        return { kind: "read", ...(path ?? asNonEmptyString(action.name) ? { target: path ?? asNonEmptyString(action.name)! } : {}) };
      case "list_files":
        return { kind: "list", ...(path ? { target: path } : {}) };
      case "search": {
        const query = asNonEmptyString(action.query);
        return { kind: "search", ...(query ? { target: query } : {}), ...(path ? { path } : {}) };
      }
      default:
        return { kind: "run", target: String(action.cmd ?? "") };
    }
  });
  return actions.some((action) => action.kind !== "run") ? actions : undefined;
};

const collabToolNames: Record<string, string> = {
  spawn_agent: "subagent.spawn",
  send_input: "subagent.message",
  resume_agent: "subagent.resume",
  wait: "subagent.wait",
  close_agent: "subagent.close"
};

type ToolInput = Pick<ToolCall, "toolName" | "status" | "inputSummary" | "outputSummary" | "actions"> & { exitCode?: number };

const toolInput = (item: Record<string, unknown>): ToolInput | undefined => {
  const status: ToolCall["status"] = item.status === "failed" ? "failed" : item.status === "inProgress" ? "running" : "completed";
  switch (item.type) {
    case "CommandExecution": {
      const actions = parsedCommandActions(item.parsed_cmd);
      const output = asNonEmptyString(item.aggregated_output) ?? asNonEmptyString(item.stdout);
      return {
        toolName: "commandExecution",
        status,
        inputSummary: commandText(item.command),
        ...(output ? { outputSummary: output } : {}),
        ...(actions ? { actions } : {}),
        ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {})
      };
    }
    case "McpToolCall":
    case "DynamicToolCall": {
      const toolName = item.type === "McpToolCall"
        ? `mcp.${String(item.server)}.${String(item.tool)}`
        : item.namespace ? `${String(item.namespace)}.${String(item.tool)}` : String(item.tool);
      const args = compactJson(item.arguments);
      const result = isRecord(item.result) ? item.result : undefined;
      const output = textParts(result?.content ?? item.content_items, result ? "text" : "inputText");
      return {
        toolName,
        status: result?.isError === true || item.success === false ? "failed" : status,
        inputSummary: args ? `${toolName} ${args}` : toolName,
        ...(output ? { outputSummary: output } : {})
      };
    }
    case "CollabAgentToolCall": {
      const prompt = asNonEmptyString(item.prompt);
      return {
        toolName: collabToolNames[String(item.tool)] ?? `subagent.${String(item.tool)}`,
        status,
        ...(prompt ? { inputSummary: prompt } : {})
      };
    }
    case "WebSearch":
    case "Extension": {
      const action = isRecord(item.action) ? item.action : undefined;
      const queries = Array.isArray(action?.queries) ? action.queries.filter((query): query is string => typeof query === "string") : [];
      const query = asNonEmptyString(item.query) ?? asNonEmptyString(action?.query) ?? (queries.join("\n") || undefined);
      if (item.type === "Extension" && item.kind !== "web.search") return undefined;
      return { toolName: "webSearch", status, ...(query ? { inputSummary: query } : {}) };
    }
    case "ImageView": {
      const path = asNonEmptyString(item.path)?.replace(/^file:\/\/\/?/, "");
      return { toolName: "imageView", status, ...(path ? { inputSummary: path } : {}) };
    }
    case "ImageGeneration": {
      const prompt = asNonEmptyString(item.revised_prompt) ?? asNonEmptyString(item.prompt);
      return { toolName: "imageGeneration", status, ...(prompt ? { inputSummary: prompt } : {}) };
    }
    case "Reasoning": {
      const summary = [
        ...(Array.isArray(item.summary_text) ? item.summary_text : []),
        ...(Array.isArray(item.raw_content) ? item.raw_content : [])
      ].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n");
      return summary ? { toolName: "reasoning", status: "completed", outputSummary: summary } : undefined;
    }
    default:
      return undefined;
  }
};

/** "读取 README.md · 3 行": the step exactly as the message area lists it. */
const toolStepText = (input: ToolInput, message: RolloutMessageRecord, id: string): { text: string; kind: string } => {
  const { exitCode, ...call } = input;
  const step = describeToolStep(
    { ...call, toolCallId: id, sessionId: "search", turnId: message.turnId ?? "search", startedAt: message.at },
    { ...(call.outputSummary ? { text: call.outputSummary } : {}), ...(exitCode !== undefined ? { exitCode } : {}) }
  );
  const head = [step.verb, step.object].filter(Boolean).join(" ");
  return { text: step.result ? `${head} · ${step.result}` : head, kind: step.kind };
};

export type RolloutMessage = {
  /** Item id when the rollout records one; shared ancestors in forks carry the same id. */
  id?: string;
  text: string;
  toolKind?: string;
};

const markdownParser = unified().use(remarkParse).use(remarkGfm);

type MarkdownNode = { type: string; value?: string; alt?: string | null; children?: MarkdownNode[] };

const blockTypes = new Set(["paragraph", "heading", "code", "blockquote", "listItem", "tableRow", "thematicBreak", "html"]);

/**
 * Agent replies render as Markdown (same parser as the message area); search matches and previews
 * the text a reader sees: markup is gone, code keeps its literal content, blocks become lines.
 */
export const markdownToPlainText = (markdown: string): string => {
  const out: string[] = [];
  const walk = (node: MarkdownNode): void => {
    if (typeof node.value === "string" && node.type !== "html") out.push(node.value);
    else if (node.type === "image" && node.alt) out.push(node.alt);
    else if (node.type === "break") out.push("\n");
    else if (node.type === "tableCell") out.push(" ");
    node.children?.forEach(walk);
    if (blockTypes.has(node.type)) out.push("\n");
  };
  walk(markdownParser.parse(markdown) as MarkdownNode);
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
};

/** The text a rollout record shows in the session, or undefined for records that show nothing. */
export const readRolloutMessage = (lineText: string, message: RolloutMessageRecord): RolloutMessage | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(lineText);
  } catch {
    return undefined;
  }
  const payload = isRecord(value) && isRecord(value.payload) ? value.payload : undefined;
  if (!payload) return undefined;
  if (payload.type === "user_message" || payload.type === "agent_message") {
    const raw = asNonEmptyString(payload.message);
    const text = raw && payload.type === "agent_message" ? markdownToPlainText(raw) : raw;
    return text ? { text } : undefined;
  }
  const item = isRecord(payload.item) ? payload.item : undefined;
  if (!item) return undefined;
  const id = asNonEmptyString(item.id);
  const withId = (rest: Omit<RolloutMessage, "id">): RolloutMessage => ({ ...(id ? { id } : {}), ...rest });
  if (item.type === "UserMessage" || item.type === "AgentMessage") {
    const raw = textParts(item.content, item.type === "UserMessage" ? "text" : "Text").trim();
    const text = item.type === "AgentMessage" ? markdownToPlainText(raw) : raw;
    return text ? withId({ text }) : undefined;
  }
  const input = toolInput(item);
  if (!input) return undefined;
  const step = toolStepText(input, message, id ?? String(message.line));
  return step.text ? withId({ text: step.text, toolKind: step.kind }) : undefined;
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

/** Words tool steps add in the message area; they never appear in the raw rollout record. */
const STEP_WORDS = [
  "思考", "读取", "列目录", "网络搜索", "搜索", "编辑", "运行", "查看图片", "生成图片", "压缩上下文", "调用",
  "个条目", "处匹配", "无匹配", "无输出", "不存在", "无权限", "命令不存在", "超时", "退出码", "失败", "进行中",
  "输出", "当前目录", "行"
];
const TOOL_RECORD_PATTERN =
  String.raw`"type":"item_completed","thread_id":"[^"]*","turn_id":"[^"]*","item":\{"type":"(?:` +
  [...toolItemTypes].join("|") + ")\"";

const escapeRegex = (value: string): string => value.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, "\\$&");

/** Characters rendering removes or JSON escaping adds between two shown characters. */
const STORED_GAP = String.raw`(?:[*_~` + "`" + String.raw`\[#> ]|\]\([^)\s]*\)|\\[nrt"\\/])*`;

/**
 * Regex for `text` as it may be stored: rendering removes emphasis, code backticks, link brackets
 * and heading/quote markers between the shown characters, and JSON escapes quotes, backslashes and
 * line breaks, so any of those may sit between two characters.
 */
const storedTextPattern = (text: string): string =>
  [...text].map((char) => escapeRegex(JSON.stringify(char).slice(1, -1))).join(STORED_GAP);

/**
 * Raw rollout patterns that find every record whose shown text can contain the query; the shown
 * text confirms every candidate. Tool steps also show generated words ("读取 README.md · 3 行"):
 * when the query uses them, what remains (a file, a command) is searched, and a query made only of
 * step words looks at every tool record.
 */
export const rolloutCandidatePatterns = (query: string): string[] => {
  const patterns = new Set([storedTextPattern(query)]);
  if (STEP_WORDS.some((word) => query.includes(word))) {
    let rest = query;
    for (const word of STEP_WORDS) rest = rest.split(word).join(" ");
    const tokens = rest.split(/[\s·“”"]+/).map((token) => token.replace(/^\d+$/, "")).filter(Boolean);
    if (tokens.length === 0) patterns.add(TOOL_RECORD_PATTERN);
    for (const token of tokens) patterns.add(storedTextPattern(token));
  }
  return [...patterns];
};

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
  const sharedMessageKeys = new Set<string>();

  for (const batch of batchPaths(paths)) {
    if (input.signal?.aborted || input.accumulator.truncated) return;
    const found = new Map<string, Set<number>>();
    const run = await runRipgrepBatch({
      executable,
      paths: batch,
      patterns: rolloutCandidatePatterns(input.query),
      literal: false,
      signal: input.signal,
      onMatch: (match) => {
        let lines = found.get(match.path);
        if (!lines) {
          lines = new Set();
          found.set(match.path, lines);
        }
        lines.add(match.line);
      }
    });
    input.stats.sourcesScanned += run.filesSearched || batch.length;
    input.stats.bytesScanned += run.bytesSearched;

    const candidates: string[] = [];
    for (const path of batch) {
      if (input.signal?.aborted) return;
      if (!found.has(path)) continue;
      let vermillion = vermillionByPath.get(path);
      if (vermillion === undefined) {
        vermillion = isVermillionRollout(await readRolloutHeader(path).catch(() => ""));
        vermillionByPath.set(path, vermillion);
      }
      if (vermillion) candidates.push(path);
    }
    if (candidates.length === 0) continue;
    const indexes = await readRolloutIndexes(executable, candidates, input.signal);

    for (const path of candidates) {
      if (input.signal?.aborted) return;
      const lines = found.get(path)!;
      // Candidate lines only say the bytes contain the query; the hit is confirmed on the text the
      // message shows, so matches in field names, escapes or tool output are dropped here.
      const rolloutIndex = indexes.get(path)!;
      const messageIndexes = [...lines]
        .map((line) => rolloutIndex.indexByLine.get(line))
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right);
      if (messageIndexes.length === 0) continue;
      const entry = entryByPath.get(path)!;
      const workspaceLabel = input.workspaceLabelById.get(entry.workspaceId)!;
      const treeId = entry.treeId ?? entry.sessionId;
      const treeTitle = displaySessionTitle(entry.treeTitle);
      const shown = new Map<number, Promise<RolloutMessage | undefined>>();
      const messageAt = (position: number): Promise<RolloutMessage | undefined> => {
        let cached = shown.get(position);
        if (!cached) {
          const record = rolloutIndex.messages[position]!;
          cached = readRolloutLine(path, record.start)
            .then((text) => text === undefined ? undefined : readRolloutMessage(text, record))
            .catch(() => undefined);
          shown.set(position, cached);
        }
        return cached;
      };
      const neighbour = async (position: number, step: -1 | 1): Promise<SearchContextLine | undefined> => {
        // A few steps cover records that show nothing (empty reasoning) between two messages.
        for (let next = position + step, tries = 0; next >= 0 && next < rolloutIndex.messages.length && tries < 4; next += step, tries += 1) {
          const shownMessage = await messageAt(next);
          if (!shownMessage) continue;
          const record = rolloutIndex.messages[next]!;
          const text = shownMessage.text.length > NEIGHBOUR_TEXT_CHARS
            ? (step < 0 ? "…" + shownMessage.text.slice(-NEIGHBOUR_TEXT_CHARS) : shownMessage.text.slice(0, NEIGHBOUR_TEXT_CHARS) + "…")
            : shownMessage.text;
          return { line: record.line, text, matches: findMatches(text, input.query), source: record.source };
        }
        return undefined;
      };
      for (const position of messageIndexes) {
        if (input.signal?.aborted) return;
        const record = rolloutIndex.messages[position]!;
        const shownMessage = await messageAt(position);
        if (!shownMessage) continue;
        const matches = findMatches(shownMessage.text, input.query);
        if (matches.length === 0) continue;
        // Forked sessions copy their ancestors' records; a shared message is listed once per tree.
        const messageKey = [treeId, record.turnId ?? "", shownMessage.id ?? `${record.source}:${shownMessage.text}`].join(":");
        if (sharedMessageKeys.has(messageKey)) continue;
        sharedMessageKeys.add(messageKey);
        const before = await neighbour(position, -1);
        const after = await neighbour(position, 1);
        const hitLine = { ...toContextLine(record.line, shownMessage.text, input.query, matches[0]!.start), source: record.source };
        const turnNumber = record.turnId ? rolloutIndex.turnNumbers.get(record.turnId) : undefined;
        const hit = {
          id: `session:${entry.workspaceId}:${entry.sessionId}:${record.line}`,
          kind: "session" as const,
          workspaceId: entry.workspaceId,
          workspaceLabel,
          title: treeTitle,
          treeId,
          treeTitle,
          ...(entry.treeActivityAt ? { treeActivityAt: entry.treeActivityAt } : {}),
          ...(entry.activityAt ? { sessionActivityAt: entry.activityAt } : {}),
          path,
          line: record.line,
          column: matches[0]!.start + 1,
          context: [before, hitLine, after].filter((line): line is SearchContextLine => Boolean(line)),
          sessionId: entry.sessionId,
          ...(record.turnId ? { turnId: record.turnId } : {}),
          source: record.source,
          ...(shownMessage.toolKind ? { toolKind: shownMessage.toolKind } : {}),
          ...(turnNumber ? { turnNumber } : {}),
          ...(record.at ? { messageAt: record.at } : {})
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
      activityAt: latestTimestamp(
        members.filter((entry) => !entry.archivedAt).map((entry) => entry.activityAt)
      )
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
      ...(asNonEmptyString(rawEntry.archivedAt) ? { archivedAt: asNonEmptyString(rawEntry.archivedAt) } : {}),
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
