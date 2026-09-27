import type { ToolAction, ToolCall } from "./domain.js";

/**
 * Engine-neutral structure of tool calls as steps (action, object, result) and a per-turn summary.
 * Only meaning the engine states is classified: its command actions, its tool types and the
 * summaries the adapters write. Commands the engine did not classify are "run <command>"; tools
 * without a known type keep their name. Results report output lines and exit codes as they are.
 * Wording is left to the interface, which renders these structures in its own language.
 */

export type ToolStepKind =
  | "think"
  | "read"
  | "list"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "view"
  | "generate"
  | "compact"
  | "agent"
  | "other";

export type ToolAgentAction = "spawn" | "message" | "resume" | "wait" | "close";

/** What a step acts on; every text here comes from the record, never from generated wording. */
export type ToolStepObject =
  | { kind: "text"; text: string }
  /** File base names, in the order the engine lists them. */
  | { kind: "files"; names: string[] }
  /** Directory paths shortened for display; `.` is the current directory. */
  | { kind: "directories"; paths: string[] }
  | { kind: "pattern"; pattern: string; path?: string }
  | { kind: "agents"; count: number }
  | { kind: "terminal" };

export type ToolStepResult =
  | { kind: "running" }
  | { kind: "failed"; exitCode?: number }
  /** Printed output lines; 0 means no output. */
  | { kind: "output"; lines: number }
  | { kind: "agents"; errored: number; completed: number };

export type ToolStep = {
  kind: ToolStepKind;
  /** Subagent steps: which subagent operation the call performs. */
  agentAction?: ToolAgentAction;
  object?: ToolStepObject;
  result?: ToolStepResult;
  failed: boolean;
  running: boolean;
  /** Files touched (read/edit) used for summary counts. */
  targets: string[];
};

export type ToolStepOutput = {
  text?: string;
  exitCode?: number;
};

const truncate = (value: string, max = 72): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const firstLine = (value: string | undefined): string | undefined =>
  value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

/** Output lines as printed, without the trailing newline. */
const outputLines = (value: string | undefined): number =>
  value?.trim() ? value.replace(/(\r?\n)+$/, "").split(/\r?\n/).length : 0;

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === "\"" || first === "'") && trimmed.at(-1) === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const shellWrapper =
  /^\s*(?:"[^"]*?(?:pwsh|powershell|bash|sh|cmd|zsh)(?:\.exe)?"|\S*?(?:pwsh|powershell|bash|sh|cmd|zsh)(?:\.exe)?)\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*(?:-Command|-c|-lc|\/c)\s+/i;

/** Removes the `pwsh -Command "..."` / `bash -lc '...'` wrapper engines put around commands. */
export const unwrapShellCommand = (command: string): string => {
  const match = shellWrapper.exec(command);
  if (!match) {
    return command.trim();
  }
  const inner = stripQuotes(command.slice(match[0].length));
  return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
};

/** First line of a command, without the shell wrapper. */
export const commandHead = (command: string): string =>
  truncate(firstLine(unwrapShellCommand(command)) ?? command.trim());

/** Web steps are summarized as "Open page\nurl: …"; the query or address is what they act on. */
const webTarget = (summary: string | undefined): string | undefined => {
  const field = /^(?:query|url|pattern):\s*(.+)$/m.exec(summary ?? "")?.[1]?.trim();
  if (field) return field;
  const listed = /^-\s*(.+)$/m.exec(summary ?? "")?.[1]?.trim();
  return listed ?? (summary && !/^(Search|Open page|Find in page|Web search)$/.test(summary.trim()) ? firstLine(summary) : undefined);
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

/** Actions for engines whose tools are named by what they do (pi: read, ls, grep, bash…). */
export const actionsFromNamedTool = (toolName: string, args: unknown): ToolAction[] | undefined => {
  const record = asRecord(args) ?? {};
  const path = stringField(record, "path", "file_path", "filePath", "file");
  switch (toolName) {
    case "read":
      return [{ kind: "read", ...(path ? { target: path } : {}) }];
    case "ls":
      return [{ kind: "list", ...(path ? { target: path } : {}) }];
    case "find":
    case "grep": {
      const pattern = stringField(record, "pattern", "query");
      return [{ kind: "search", ...(pattern ? { target: pattern } : {}), ...(path ? { path } : {}) }];
    }
    case "edit":
    case "write":
      return [{ kind: "edit", ...(path ? { target: path } : {}) }];
    case "bash": {
      const command = stringField(record, "command");
      return command ? [{ kind: "run", target: command }] : undefined;
    }
    default:
      return undefined;
  }
};

const baseName = (path: string): string => {
  const cleaned = stripQuotes(path).replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).at(-1) || cleaned;
};

const shortPath = (path: string): string => {
  const cleaned = stripQuotes(path).replace(/[\\/]+$/, "");
  if (!cleaned || cleaned === ".") {
    return ".";
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
};

const textObject = (text: string | undefined): ToolStepObject | undefined =>
  text ? { kind: "text", text: truncate(text) } : undefined;

/**
 * The object as plain text taken from the record (files and paths joined by ", ", a pattern in
 * quotes); used where the step is matched as text, such as search.
 */
export const toolStepObjectText = (object: ToolStepObject | undefined): string => {
  switch (object?.kind) {
    case "text":
      return object.text;
    case "files":
      return object.names.join(", ");
    case "directories":
      return object.paths.join(", ");
    case "pattern":
      return `"${object.pattern}"${object.path ? ` · ${object.path}` : ""}`;
    default:
      return "";
  }
};

/**
 * The engine's actions when they name one kind of work; a command it left unclassified, or one
 * mixing kinds, is shown as the command itself.
 */
const resolveActions = (toolCall: ToolCall): ToolAction[] | undefined => {
  const actions = toolCall.actions ?? [];
  const kinds = new Set(actions.map((action) => action.kind));
  if (kinds.size === 1 && !kinds.has("run")) {
    return actions;
  }
  const command = toolCall.toolName === "commandExecution"
    ? toolCall.inputSummary
    : actions.find((action) => action.kind === "run")?.target;
  return command ? [{ kind: "run", target: command }] : undefined;
};

const kindForTool = (toolName: string): ToolStepKind | undefined => {
  switch (toolName) {
    case "reasoning":
      return "think";
    case "webSearch":
      return "web";
    case "imageView":
      return "view";
    case "imageGeneration":
      return "generate";
    case "contextCompaction":
      return "compact";
    default:
      return toolName.startsWith("subagent.") ? "agent" : undefined;
  }
};

const agentActions: Record<string, ToolAgentAction> = {
  "subagent.spawn": "spawn",
  "subagent.message": "message",
  "subagent.resume": "resume",
  "subagent.wait": "wait",
  "subagent.close": "close"
};

/**
 * Subagent calls name their targets by thread id, which says nothing to a reader: spawn and
 * message show the task text, the others how many agents they act on. Engines report each agent
 * as "<thread>: <status>…" in the output, which gives a wait its outcome.
 */
const describeAgentStep = (toolCall: ToolCall, running: boolean): ToolStep => {
  const input = toolCall.inputSummary ?? "";
  const targets = /^targets:\s*(.+)$/m.exec(input)?.[1]?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
  const task = firstLine(input.replace(/^(?:targets|model|reasoning):.*$/gm, ""));
  const sendsTask = toolCall.toolName === "subagent.spawn" || toolCall.toolName === "subagent.message";
  const object: ToolStepObject | undefined = sendsTask && task ? textObject(task)
    : targets.length > 0 ? { kind: "agents", count: targets.length } : undefined;
  const statuses = (toolCall.outputSummary ?? "").split(/\r?\n/)
    .map((line) => /^\S+:\s*([A-Za-z_]+)/.exec(line.trim())?.[1]?.toLowerCase())
    .filter((status): status is string => Boolean(status));
  const errored = statuses.filter((status) => status === "errored").length;
  const completed = statuses.filter((status) => status === "completed" || status === "shutdown").length;
  const failed = toolCall.status === "failed" || errored > 0;
  const result: ToolStepResult | undefined = running ? { kind: "running" }
    : toolCall.toolName !== "subagent.wait" ? undefined
      : { kind: "agents", errored, completed };
  const agentAction = agentActions[toolCall.toolName];
  return {
    kind: "agent",
    ...(agentAction ? { agentAction } : {}),
    ...(object ? { object } : {}),
    ...(result ? { result } : {}),
    failed,
    running,
    targets: []
  };
};

const failureResult = (exitCode: number | undefined): ToolStepResult =>
  typeof exitCode === "number" ? { kind: "failed", exitCode } : { kind: "failed" };

/** One step for a tool call: action kind, object and result. */
export const describeToolStep = (toolCall: ToolCall, output: ToolStepOutput = {}): ToolStep => {
  const running = toolCall.status === "running";
  const text = output.text ?? toolCall.outputSummary;
  const fixedKind = kindForTool(toolCall.toolName);
  if (fixedKind === "agent") {
    return describeAgentStep(toolCall, running);
  }
  if (fixedKind) {
    const object =
      fixedKind === "think"
        ? firstLine(toolCall.outputSummary?.replace(/[*#`]+/g, ""))
        : fixedKind === "view"
          ? toolCall.inputSummary ? baseName(toolCall.inputSummary) : undefined
          : fixedKind === "compact"
            ? undefined
            : fixedKind === "web"
              ? webTarget(toolCall.inputSummary)
              : firstLine(toolCall.inputSummary);
    return {
      kind: fixedKind,
      ...(object ? { object: textObject(object)! } : {}),
      ...(running ? { result: { kind: "running" } as const } : {}),
      failed: toolCall.status === "failed",
      running,
      targets: []
    };
  }

  const failed = toolCall.status === "failed" || (typeof output.exitCode === "number" && output.exitCode !== 0);
  const actions = resolveActions(toolCall);
  if (!actions) {
    return {
      kind: "other",
      object: { kind: "text", text: toolCall.toolName },
      ...(running ? { result: { kind: "running" } as const } : failed ? { result: failureResult(output.exitCode) } : {}),
      failed,
      running,
      targets: []
    };
  }

  const kind = actions[0]!.kind;
  const targets = actions.map((action) => action.target).filter((target): target is string => Boolean(target));
  let object: ToolStepObject | undefined;
  if (kind === "read" || kind === "edit") {
    object = targets.length > 0 ? { kind: "files", names: targets.map(baseName) } : undefined;
  } else if (kind === "list") {
    object = { kind: "directories", paths: targets.length > 0 ? [...new Set(targets.map(shortPath))] : ["."] };
  } else if (kind === "search") {
    const first = actions[0]!;
    object = first.target
      ? { kind: "pattern", pattern: truncate(stripQuotes(first.target)), ...(first.path ? { path: shortPath(first.path) } : {}) }
      : undefined;
  } else {
    object = textObject(commandHead(actions[0]!.target ?? ""));
  }

  const lines = outputLines(text);
  const result: ToolStepResult | undefined = running ? { kind: "running" }
    : failed ? failureResult(output.exitCode)
      : kind === "edit" ? undefined
        : { kind: "output", lines };

  return {
    kind,
    ...(object ? { object } : {}),
    ...(result ? { result } : {}),
    failed,
    running,
    targets: kind === "read" || kind === "edit" ? targets : []
  };
};

const summaryOrder: ToolStepKind[] = [
  "list", "read", "search", "edit", "run", "web", "view", "generate", "agent", "other", "compact", "think"
];

export type ToolStepSummary = {
  /** Counts by action kind in display order; read/edit count distinct files. */
  counts: Array<{ kind: ToolStepKind; count: number }>;
  /** Set when no step was counted: how many process messages the turn showed. */
  messageCount?: number;
  failures: number;
  durationMs?: number;
};

/** Summary of a finished turn's process: counts by action kind, failures and elapsed time. */
export const summarizeToolSteps = (
  steps: ToolStep[],
  options: { messageCount?: number; durationMs?: number } = {}
): ToolStepSummary => {
  const counts: ToolStepSummary["counts"] = [];
  for (const kind of summaryOrder) {
    const matching = steps.filter((step) => step.kind === kind);
    if (matching.length === 0) {
      continue;
    }
    const files = new Set(matching.flatMap((step) => step.targets.map(baseName)));
    const count = (kind === "read" || kind === "edit") && files.size > 0 ? files.size : matching.length;
    counts.push({ kind, count });
  }
  return {
    counts,
    ...(counts.length === 0 && options.messageCount ? { messageCount: options.messageCount } : {}),
    failures: steps.filter((step) => step.failed).length,
    ...(typeof options.durationMs === "number" && options.durationMs > 0 ? { durationMs: options.durationMs } : {})
  };
};
