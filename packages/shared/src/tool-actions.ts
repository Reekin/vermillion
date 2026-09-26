import type { ToolAction, ToolCall } from "./domain.js";

/**
 * Engine-neutral wording of tool calls as steps ("读取 README.md · 输出 3 行") and a per-turn summary.
 * Only meaning the engine states is translated: its classified command actions, its tool types and
 * the summaries the adapters write. Commands the engine did not classify read as "运行 <command>";
 * tools without a known type keep their name. Results report output and exit codes as they are.
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
  agent: "子代理",
  other: "调用"
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

const agentVerbs: Record<string, string> = {
  "subagent.spawn": "启动子代理",
  "subagent.message": "发消息给子代理",
  "subagent.resume": "恢复子代理",
  "subagent.wait": "等待子代理",
  "subagent.close": "关闭子代理"
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
  const object = sendsTask && task ? task : targets.length > 0 ? `${targets.length} 个` : undefined;
  const statuses = (toolCall.outputSummary ?? "").split(/\r?\n/)
    .map((line) => /^\S+:\s*([A-Za-z_]+)/.exec(line.trim())?.[1]?.toLowerCase())
    .filter((status): status is string => Boolean(status));
  const errored = statuses.filter((status) => status === "errored").length;
  const completed = statuses.filter((status) => status === "completed" || status === "shutdown").length;
  const failed = toolCall.status === "failed" || errored > 0;
  const result = running ? "进行中"
    : toolCall.toolName !== "subagent.wait" ? undefined
      : errored > 0 ? `${errored} 个出错`
        : completed > 0 ? `${completed} 个已完成` : "未完成";
  return {
    kind: "agent",
    verb: agentVerbs[toolCall.toolName] ?? verbs.agent,
    ...(object ? { object: truncate(object) } : {}),
    ...(result ? { result } : {}),
    failed,
    running,
    targets: []
  };
};

const failureResult = (exitCode: number | undefined): string =>
  typeof exitCode === "number" ? `失败 · 退出码 ${exitCode}` : "失败";

/** One readable step for a tool call: verb, object and result. */
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
      verb: verbs[fixedKind],
      ...(object ? { object: truncate(object) } : {}),
      ...(running ? { result: "进行中" } : {}),
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
      verb: verbs.other,
      object: toolCall.toolName,
      ...(running ? { result: "进行中" } : failed ? { result: failureResult(output.exitCode) } : {}),
      failed,
      running,
      targets: []
    };
  }

  const kind = actions[0]!.kind;
  const targets = actions.map((action) => action.target).filter((target): target is string => Boolean(target));
  let object: string | undefined;
  if (kind === "read" || kind === "edit") {
    object = joinTargets(targets);
  } else if (kind === "list") {
    object = targets.length > 0 ? [...new Set(targets.map(shortPath))].join("、") : "当前目录";
  } else if (kind === "search") {
    const first = actions[0]!;
    object = first.target ? `“${stripQuotes(first.target)}”${first.path ? ` · ${shortPath(first.path)}` : ""}` : undefined;
  } else {
    object = commandHead(actions[0]!.target ?? "");
  }

  const lines = outputLines(text);
  const result = running ? "进行中"
    : failed ? failureResult(output.exitCode)
      : kind === "edit" ? undefined
        : lines > 0 ? `输出 ${lines} 行` : "无输出";

  return {
    kind,
    verb: verbs[kind],
    ...(object ? { object: truncate(object) } : {}),
    ...(result ? { result } : {}),
    failed,
    running,
    targets: kind === "read" || kind === "edit" ? targets : []
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
  "list", "read", "search", "edit", "run", "web", "view", "generate", "agent", "other", "compact", "think"
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
    case "agent":
      return `子代理操作 ${count} 次`;
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
  const failures = steps.filter((step) => step.failed).length;
  if (failures > 0) {
    parts.push(`${failures} 步失败`);
  }
  if (typeof options.durationMs === "number" && options.durationMs > 0) {
    parts.push(formatDurationZh(options.durationMs));
  }
  return parts.join(" · ");
};
