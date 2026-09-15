import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type PiSessionHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

export type PiContentBlock = {
  type: string;
  text?: string;
  textSignature?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  mimeType?: string;
};

export type PiMessage = {
  role?: string;
  content?: PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  errorMessage?: string;
};

export type PiSessionEntry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  message?: PiMessage;
  customType?: string;
  data?: unknown;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
};

export type PiSessionFile = {
  header: PiSessionHeader;
  entries: PiSessionEntry[];
  path: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseEntry = (value: unknown): PiSessionEntry | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (!id || !type || type === "session") {
    return undefined;
  }
  return {
    ...(value as Omit<PiSessionEntry, "id" | "type">),
    id,
    type,
    parentId: typeof value.parentId === "string" ? value.parentId : null,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : ""
  };
};

/** 会话文件按行追加；读取时忽略无法解析的尾部片段（进程可能正在写入）。 */
export const readPiSessionFile = async (
  path: string
): Promise<PiSessionFile | undefined> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let header: PiSessionHeader | undefined;
  const entries: PiSessionEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header) {
      if (isRecord(parsed) && parsed.type === "session" && typeof parsed.id === "string") {
        header = parsed as unknown as PiSessionHeader;
        continue;
      }
      return undefined;
    }
    const entry = parseEntry(parsed);
    if (entry) {
      entries.push(entry);
    }
  }
  if (!header) {
    return undefined;
  }
  return { header, entries, path };
};

/** 一次会话写在一个目录里，文件名形如 `<timestamp>_<sessionId>.jsonl`。 */
export const findPiSessionFile = async (
  sessionDir: string,
  piSessionId: string
): Promise<string | undefined> => {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return undefined;
  }
  const files = names.filter((name) => name.endsWith(".jsonl")).sort();
  const exact = files.find((name) => name.endsWith(`_${piSessionId}.jsonl`));
  if (exact) {
    return join(sessionDir, exact);
  }
  if (files.length === 0) {
    return undefined;
  }
  for (const name of [...files].reverse()) {
    const file = await readPiSessionFile(join(sessionDir, name));
    if (file?.header.id === piSessionId) {
      return join(sessionDir, name);
    }
  }
  return undefined;
};

/** 会话文件里记录的是追加顺序；当前分支要从叶子沿 parentId 回溯。 */
export const branchEntries = (file: PiSessionFile): PiSessionEntry[] => {
  const byId = new Map(file.entries.map((entry) => [entry.id, entry] as const));
  const leaf = file.entries.at(-1);
  if (!leaf) {
    return [];
  }
  const branch: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let current: PiSessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
};
