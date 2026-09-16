import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  branchEntries,
  findPiSessionFile,
  readPiSessionFile,
  type PiSessionEntry
} from "./session-file.js";
import { piTurnEntryType } from "./session-identity.js";

export type PiForkResult = {
  sessionFile: string;
  inheritedEntryCount: number;
  forkSourceTurnId?: string;
};

const sessionFileName = (sessionId: string, timestamp: string): string =>
  `${timestamp.replace(/[:.]/gu, "-")}_${sessionId}.jsonl`;

/**
 * pi 自己的 fork 从源会话末端复制全部条目；工作台要的是"从某一轮分出来"，
 * 因此只复制该轮结束前的分支前缀，新会话续写时自然挂在派生点上。
 */
export const forkPiSession = async (input: {
  sourceSessionDir: string;
  sourcePiSessionId: string;
  targetSessionDir: string;
  targetPiSessionId: string;
  targetCwd: string;
  fromTurnId?: string;
  now?: () => string;
}): Promise<PiForkResult> => {
  const now = input.now ?? (() => new Date().toISOString());
  const sourcePath = await findPiSessionFile(
    join(input.sourceSessionDir, "sessions"),
    input.sourcePiSessionId
  );
  if (!sourcePath) {
    throw new Error("The pi session file for this conversation is missing.");
  }
  const source = await readPiSessionFile(sourcePath);
  if (!source) {
    throw new Error("The pi session file could not be read.");
  }
  const branch = branchEntries(source);
  const fromTurnId = input.fromTurnId;
  let entries: PiSessionEntry[] = branch;
  if (fromTurnId) {
    const forkIndex = branch.findIndex(
      (entry) => entry.id === fromTurnId && entry.customType === piTurnEntryType
    );
    if (forkIndex < 0) {
      throw new Error(`The fork point ${fromTurnId} is not part of this session branch.`);
    }
    const nextTurnIndex = branch.findIndex(
      (entry, index) => index > forkIndex && entry.customType === piTurnEntryType
    );
    entries = branch.slice(0, nextTurnIndex < 0 ? branch.length : nextTurnIndex);
  }
  const timestamp = now();
  const targetSessionsDir = join(input.targetSessionDir, "sessions");
  await mkdir(targetSessionsDir, { recursive: true });
  const sessionFile = join(
    targetSessionsDir,
    sessionFileName(input.targetPiSessionId, timestamp)
  );
  const header = {
    type: "session",
    version: source.header.version ?? 3,
    id: input.targetPiSessionId,
    timestamp,
    cwd: input.targetCwd,
    parentSession: sourcePath
  };
  await writeFile(
    sessionFile,
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n",
    "utf8"
  );
  return {
    sessionFile,
    inheritedEntryCount: entries.length,
    ...(fromTurnId ? { forkSourceTurnId: fromTurnId } : {})
  };
};
