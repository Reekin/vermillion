import type { ToolAction, ToolCall } from "./domain.js";

/**
 * Engine-neutral translation of tool calls into readable steps ("读取 README.md · 3 行") and a
 * per-turn summary ("读取 2 个文件 · 运行 1 条命令 · 1 分 27 秒"). Raw commands stay in details.
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
  | "other";

export type ToolStep = {
  kind: ToolStepKind;
  verb: string;
  object?: string;
  result?: string;
  failed: boolean;
  running: boolean;
  /** Files touched (read/edit) used for summary counts. */
  targets: string[];
};

export type ToolStepOutput = {
  text?: string;
  exitCode?: number;
};

const verbs: Record<ToolStepKind, string> = {
  think: "思考",
  read: "读取",
  list: "列目录",
  search: "搜索",
  edit: "编辑",
  run: "运行",
  web: "网络搜索",
  view: "查看图片",
  generate: "生成图片",
  compact: "压缩上下文",
  other: "调用"
};

const truncate = (value: string, max = 72): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const firstLine = (value: string | undefined): string | undefined =>
  value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

const countLines = (value: string | undefined): number =>
  value ? value.split(/\r?\n/).filter((line) => line.trim().length > 0).length : 0;

/** File lines as written, blank lines included, without the trailing newline. */
const countRawLines = (value: string | undefined): number =>
  value ? value.replace(/(\r?\n)+$/, "").split(/\r?\n/).length : 0;

/**
 * Directory entries without table headers (any header line followed by a dashed rule, as pwsh
 * prints for Get-ChildItem and Select-Object), `Directory:` captions, `ls -la` totals or dot entries.
 */
const countListEntries = (value: string | undefined): number => {
  const lines = (value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line, index) => {
    const next = lines[index + 1];
    const isHeader = next !== undefined && /^-[-\s]*$/.test(next);
    return (
      !isHeader &&
      !/^-[-\s]*$/.test(line) &&
      !/^Directory:/i.test(line) &&
      !/^total \d+$/.test(line) &&
      !/(^|\s)\.{1,2}$/.test(line)
    );
  }).length;
};

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

/** First meaningful fragment of a command, without the shell wrapper. */
export const commandHead = (command: string): string =>
  truncate(firstLine(unwrapShellCommand(command)) ?? command.trim());

const tokenize = (segment: string): string[] => {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of segment.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
};

const trivialCommands = new Set([
  "get-location", "pwd", "cd", "set-location", "echo", "write-output", "write-host", "chcp", "clear"
]);
const readCommands = new Set(["get-content", "gc", "cat", "type", "head", "tail", "less", "more", "bat", "nl"]);
const listCommands = new Set(["ls", "dir", "get-childitem", "gci", "tree", "find"]);
const searchCommands = new Set(["rg", "grep", "select-string", "sls", "findstr", "ag"]);
/** Flags whose next token is a value, not a positional argument. */
const valueFlags = new Set([
  "-g", "--glob", "-t", "--type", "-m", "--max-count", "-A", "-B", "-C", "--context", "-e",
  "-totalcount", "-tail", "-first", "-last", "-encoding", "-filter", "-include", "-exclude",
  "-depth", "--lines", "-maxdepth", "-name", "-pattern", "-path", "-literalpath"
]);

const positionals = (tokens: string[]): { values: string[]; flags: Map<string, string> } => {
  const values: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("-") && token.length > 1) {
      // Single-letter flags are case-sensitive (rg -C vs -c); long ones follow PowerShell casing rules.
      const flag = token.length === 2 ? token : token.toLowerCase();
      if (valueFlags.has(flag) && index + 1 < tokens.length) {
        flags.set(flag, tokens[index + 1]!);
        index += 1;
      }
      continue;
    }
    values.push(token);
  }
  return { values, flags };
};

const commandName = (token: string): string =>
  token.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();

const classifySegment = (segment: string): ToolAction | undefined => {
  const tokens = tokenize(segment.split("|")[0] ?? "");
  if (tokens.length === 0) {
    return undefined;
  }
  const name = commandName(tokens[0]!);
  if (trivialCommands.has(name) || /^\$\w+\s*=/.test(segment.trim())) {
    return undefined;
  }
  const { values, flags } = positionals(tokens);
  const pathFlag = flags.get("-path") ?? flags.get("-literalpath");
  if (name === "sed" && tokens.includes("-n")) {
    const file = values.filter((value) => !/^\d+(,\d+)?p$/.test(value)).at(-1);
    return { kind: "read", ...(file ? { target: file } : {}) };
  }
  if (readCommands.has(name)) {
    const file = pathFlag ?? values.filter((value) => !/^\d+$/.test(value)).at(-1);
    return { kind: "read", ...(file ? { target: file } : {}) };
  }
  if (listCommands.has(name) || (name === "rg" && tokens.includes("--files"))) {
    const dir = pathFlag ?? values[0];
    return { kind: "list", ...(dir ? { target: dir } : {}) };
  }
  if (searchCommands.has(name)) {
    const query = flags.get("-e") ?? flags.get("-pattern") ?? values[0];
    const path = pathFlag ?? (flags.has("-e") || flags.has("-pattern") ? values[0] : values[1]);
    return { kind: "search", ...(query ? { target: query } : {}), ...(path ? { path } : {}) };
  }
  return { kind: "run", target: segment.trim() };
};

const commandSegments = (command: string): string[] =>
  unwrapShellCommand(command).split(/;|&&|\|\||\r?\n/).map((segment) => segment.trim()).filter(Boolean);

/** The first segment that does real work, skipping cd, echo and variable setup. */
const meaningfulCommand = (command: string): string => {
  const segments = commandSegments(command);
  return segments.find((segment) => classifySegment(segment)) ?? segments[0] ?? command.trim();
};

/** Best-effort reading of a shell command when the engine gives no structured actions. */
export const actionsFromCommand = (command: string): ToolAction[] => {
  const actions = commandSegments(command)
    .map(classifySegment)
    .filter((action): action is ToolAction => Boolean(action));
  const firstRun = actions.find((action) => action.kind === "run");
  if (firstRun) {
    return [firstRun];
  }
  return actions.length > 0 ? actions : [{ kind: "run", target: meaningfulCommand(command) }];
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
      return command ? actionsFromCommand(command) : undefined;
    }
    default:
      return undefined;
  }
};

const parseJson = (value: string | undefined): unknown => {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
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
    return "当前目录";
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
};

const joinTargets = (targets: string[]): string | undefined => {
  if (targets.length === 0) {
    return undefined;
  }
  const names = targets.map(baseName);
  return names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 个文件` : names.join("、");
};

const commandToolNames = new Set(["commandExecution", "bash", "shell", "exec_command"]);

const resolveActions = (toolCall: ToolCall): ToolAction[] | undefined => {
  const reported = toolCall.actions?.filter((action) => action.kind !== "run");
  if (reported && reported.length > 0 && reported.length === toolCall.actions!.length) {
    return toolCall.actions;
  }
  if (toolCall.toolName === "commandExecution") {
    return toolCall.inputSummary ? actionsFromCommand(toolCall.inputSummary) : undefined;
  }
  return toolCall.actions ?? actionsFromNamedTool(toolCall.toolName, parseJson(toolCall.inputSummary));
};

const failureReason = (output: string | undefined, exitCode: number | undefined): string => {
  const text = output ?? "";
  if (/cannot find path|no such file|cannot find the (file|path)|does not exist|不存在|找不到/i.test(text)) {
    return "不存在";
  }
  if (/permission denied|access is denied|拒绝访问/i.test(text)) {
    return "无权限";
  }
  if (/is not recognized as|command not found|not found in path/i.test(text)) {
    return "命令不存在";
  }
  if (/timed out|timeout/i.test(text)) {
    return "超时";
  }
  return typeof exitCode === "number" ? `失败 · 退出码 ${exitCode}` : "失败";
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
      return undefined;
  }
};

/** One readable step for a tool call: verb, object and result. */
export const describeToolStep = (toolCall: ToolCall, output: ToolStepOutput = {}): ToolStep => {
  const running = toolCall.status === "running";
  const text = output.text ?? toolCall.outputSummary;
  const fixedKind = kindForTool(toolCall.toolName);
  if (fixedKind) {
    const object =
      fixedKind === "think"
        ? firstLine(toolCall.outputSummary?.replace(/[*#`]+/g, ""))
        : fixedKind === "view"
          ? toolCall.inputSummary ? baseName(toolCall.inputSummary) : undefined
          : fixedKind === "compact"
            ? undefined
            : firstLine(toolCall.inputSummary);
    return {
      kind: fixedKind,
      verb: verbs[fixedKind],
      ...(object ? { object: truncate(object) } : {}),
      ...(running ? { result: "进行中" } : {}),
      failed: toolCall.status === "failed",
      running,
      targets: []
    };
  }

  let actions = resolveActions(toolCall);
  // A step names one kind of action; a command mixing kinds (list then read) reads as a command.
  if (actions && new Set(actions.map((action) => action.kind)).size > 1) {
    const command =
      toolCall.toolName === "commandExecution"
        ? toolCall.inputSummary
        : stringField(asRecord(parseJson(toolCall.inputSummary)) ?? {}, "command") ?? toolCall.inputSummary;
    actions = [{ kind: "run", target: meaningfulCommand(command ?? "") }];
  }
  if (!actions || actions.length === 0) {
    const input = firstLine(toolCall.inputSummary);
    const failed = toolCall.status === "failed";
    return {
      kind: "other",
      verb: verbs.other,
      object: truncate(input && !input.startsWith("{") ? input : toolCall.toolName),
      ...(running ? { result: "进行中" } : failed ? { result: failureReason(text, output.exitCode) } : {}),
      failed,
      running,
      targets: []
    };
  }

  const kind = actions[0]!.kind;
  const targets = actions.map((action) => action.target).filter((target): target is string => Boolean(target));
  const noMatches = kind === "search" && output.exitCode === 1 && countLines(text) === 0;
  const failed =
    !noMatches &&
    (toolCall.status === "failed" || (typeof output.exitCode === "number" && output.exitCode !== 0));
  let object: string | undefined;
  if (kind === "read" || kind === "edit") {
    object = joinTargets(targets);
  } else if (kind === "list") {
    object = targets.length > 0 ? [...new Set(targets.map(shortPath))].join("、") : "当前目录";
  } else if (kind === "search") {
    const first = actions[0]!;
    object = first.target ? `“${stripQuotes(first.target)}”${first.path ? ` · ${shortPath(first.path)}` : ""}` : undefined;
  } else {
    object = commandToolNames.has(toolCall.toolName)
      ? commandHead(actions[0]!.target ?? toolCall.inputSummary ?? "")
      : toolCall.toolName;
  }

  let result: string | undefined;
  if (running) {
    result = "进行中";
  } else if (failed) {
    result = failureReason(text, output.exitCode);
  } else if (noMatches) {
    result = "无匹配";
  } else {
    const lines = countLines(text);
    switch (kind) {
      case "read":
        result = `${countRawLines(text)} 行`;
        break;
      case "list":
        result = `${countListEntries(text)} 个条目`;
        break;
      case "search":
        result = lines > 0 ? `${lines} 处匹配` : "无匹配";
        break;
      case "edit":
        result = undefined;
        break;
      default:
        result = lines > 0 ? `输出 ${lines} 行` : "无输出";
    }
  }

  return {
    kind,
    verb: verbs[kind],
    ...(object ? { object: truncate(object) } : {}),
    ...(result ? { result } : {}),
    failed,
    running,
    targets
  };
};

/** "45 秒", "1 分 27 秒", "1 小时 5 分". */
export const formatDurationZh = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
};

const summaryOrder: ToolStepKind[] = [
  "list", "read", "search", "edit", "run", "web", "view", "generate", "other", "compact", "think"
];

const summaryPhrase = (kind: ToolStepKind, count: number): string => {
  switch (kind) {
    case "read":
      return `读取 ${count} 个文件`;
    case "edit":
      return `编辑 ${count} 个文件`;
    case "list":
      return `列目录 ${count} 次`;
    case "search":
      return `搜索 ${count} 次`;
    case "run":
      return `运行 ${count} 条命令`;
    case "web":
      return `网络搜索 ${count} 次`;
    case "view":
      return `查看 ${count} 张图片`;
    case "generate":
      return `生成 ${count} 张图片`;
    case "compact":
      return "压缩上下文";
    case "think":
      return `思考 ${count} 次`;
    default:
      return `调用 ${count} 个工具`;
  }
};

/** One-line summary of a finished turn's process: counts by action kind plus elapsed time. */
export const summarizeToolSteps = (
  steps: ToolStep[],
  options: { messageCount?: number; durationMs?: number } = {}
): string => {
  const parts: string[] = [];
  const hasFailure = steps.some((step) => step.failed);
  for (const kind of summaryOrder) {
    const matching = steps.filter((step) => step.kind === kind);
    if (matching.length === 0) {
      continue;
    }
    const files = new Set(matching.flatMap((step) => step.targets.map(baseName)));
    const count = (kind === "read" || kind === "edit") && files.size > 0 ? files.size : matching.length;
    parts.push(summaryPhrase(kind, count));
  }
  if (parts.length === 0 && options.messageCount) {
    parts.push(`${options.messageCount} 条过程消息`);
  }
  if (hasFailure) {
    parts.push(`${steps.filter((step) => step.failed).length} 步失败`);
  }
  if (typeof options.durationMs === "number" && options.durationMs > 0) {
    parts.push(formatDurationZh(options.durationMs));
  }
  return parts.join(" · ");
};
