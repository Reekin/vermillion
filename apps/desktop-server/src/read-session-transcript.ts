import type {
  ChatSession,
  DomainSnapshot,
  MessageBlock,
  Turn
} from "@vermillion/shared";

export type ReadSessionTranscriptMessage = {
  messageId: string;
  turnId: string;
  sender: "user" | "agent";
  phase?: MessageBlock["phase"];
  text: string;
  startedAt: string;
  completedAt?: string;
  textTruncated?: boolean;
};

export type ReadSessionTranscriptTurn = {
  turnId: string;
  status: Turn["status"];
  finishReason?: Turn["finishReason"];
  startedAt: string;
  completedAt?: string;
};

export type ReadSessionTranscriptResult = {
  sessionId: string;
  conversationId: string;
  engineId: string;
  sessionStatus: ChatSession["status"];
  activeTurnId?: string;
  lastMessageAt?: string;
  totalTurnCount: number;
  totalMessageCount: number;
  returnedMessageCount: number;
  truncated: boolean;
  truncatedByMessages: boolean;
  truncatedByChars: boolean;
  maxTextChars: number;
  turns: ReadSessionTranscriptTurn[];
  messages: ReadSessionTranscriptMessage[];
};

export type ReadSessionTranscriptInput = {
  snapshot: DomainSnapshot;
  sessionId: string;
  limit?: number;
  maxTextChars?: number;
};

export const maxReadSessionMessageLimit = 200;
export const defaultReadSessionMaxTextChars = 60_000;
export const maxReadSessionMaxTextChars = 200_000;

const textBlockKinds = new Set<MessageBlock["kind"]>([
  "markdown",
  "plain_text"
]);

const compareIsoAsc = (left?: string, right?: string): number => {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
};

const sortBlocksAsc = (blocks: MessageBlock[]): MessageBlock[] =>
  [...blocks].sort((left, right) =>
    compareIsoAsc(left.startedAt, right.startedAt) ||
    compareIsoAsc(left.completedAt, right.completedAt) ||
    left.blockId.localeCompare(right.blockId)
  );

const isTextMessageBlock = (
  block: MessageBlock
): block is MessageBlock & { text: string } =>
  (block.role === "user" || block.role === "assistant") &&
  textBlockKinds.has(block.kind) &&
  typeof block.text === "string" &&
  block.text.trim().length > 0;

const earliest = (values: string[]): string =>
  values.sort((left, right) => left.localeCompare(right))[0]!;

const latest = (values: string[]): string | undefined => {
  if (!values.length) return undefined;
  return values.sort((left, right) => right.localeCompare(left))[0];
};

type MessageAccumulator = {
  messageId: string;
  turnId: string;
  sender: "user" | "agent";
  blocks: MessageBlock[];
};

type ReadSessionTurnSegment = {
  sessionId: string;
  throughTurnId?: string;
};

const collectVisibleTurns = (
  snapshot: DomainSnapshot,
  sessionId: string
): Turn[] => {
  const turnsBySessionId = new Map<string, Turn[]>();
  for (const turn of snapshot.turns) {
    const existing = turnsBySessionId.get(turn.sessionId);
    if (existing) {
      existing.push(turn);
    } else {
      turnsBySessionId.set(turn.sessionId, [turn]);
    }
  }
  for (const turns of turnsBySessionId.values()) {
    turns.sort((left, right) =>
      compareIsoAsc(left.startedAt, right.startedAt) ||
      compareIsoAsc(left.completedAt, right.completedAt) ||
      left.turnId.localeCompare(right.turnId)
    );
  }

  const forkByChildSessionId = new Map(
    snapshot.sessionRelations
      .filter((relation) => relation.relationType === "fork")
      .map((relation) => [relation.childSessionId, relation] as const)
  );
  const segments: ReadSessionTurnSegment[] = [{ sessionId }];
  const visited = new Set([sessionId]);
  let childSessionId = sessionId;
  while (true) {
    const relation = forkByChildSessionId.get(childSessionId);
    if (!relation || visited.has(relation.parentSessionId)) break;
    segments.push({
      sessionId: relation.parentSessionId,
      throughTurnId: relation.sourceTurnId
    });
    visited.add(relation.parentSessionId);
    childSessionId = relation.parentSessionId;
  }

  return segments.reverse().flatMap((segment) => {
    const turns = turnsBySessionId.get(segment.sessionId) ?? [];
    if (!segment.throughTurnId) return turns;
    const sourceIndex = turns.findIndex((turn) => turn.turnId === segment.throughTurnId);
    return sourceIndex < 0 ? turns : turns.slice(0, sourceIndex + 1);
  });
};

const collectMessages = (
  turns: Turn[],
  blocks: MessageBlock[]
): ReadSessionTranscriptMessage[] => {
  const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const turnIdByMessageId = new Map<string, string>();
  for (const turn of turns) {
    for (const messageId of turn.messageIds) {
      if (!turnIdByMessageId.has(messageId)) {
        turnIdByMessageId.set(messageId, turn.turnId);
      }
    }
  }

  const byMessageId = new Map<string, MessageAccumulator>();
  for (const block of blocks.filter(isTextMessageBlock)) {
    const turnId = turnIdByMessageId.get(block.messageId) ??
      (turnById.has(block.turnId) ? block.turnId : undefined);
    if (!turnId) continue;

    const sender = block.role === "user" ? "user" : "agent";
    const existing = byMessageId.get(block.messageId);
    if (existing) {
      existing.blocks.push(block);
    } else {
      byMessageId.set(block.messageId, {
        messageId: block.messageId,
        turnId,
        sender,
        blocks: [block]
      });
    }
  }

  return [...byMessageId.values()]
    .map((message): ReadSessionTranscriptMessage => {
      const sorted = sortBlocksAsc(message.blocks);
      const phases = [...new Set(sorted.map((block) => block.phase).filter(Boolean))];
      const completedAt = latest(sorted.map((block) => block.completedAt).filter((value): value is string => Boolean(value)));
      return {
        messageId: message.messageId,
        turnId: message.turnId,
        sender: message.sender,
        ...(phases.length === 1 ? { phase: phases[0] } : {}),
        text: sorted.map((block) => block.text!.trim()).join("\n\n"),
        startedAt: earliest(sorted.map((block) => block.startedAt)),
        ...(completedAt ? { completedAt } : {})
      };
    })
    .sort((left, right) =>
      compareIsoAsc(left.startedAt, right.startedAt) ||
      compareIsoAsc(left.completedAt, right.completedAt) ||
      left.messageId.localeCompare(right.messageId)
    );
};

const normalizeMessageLimit = (limit?: number): number | undefined => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return undefined;
  return Math.min(maxReadSessionMessageLimit, Math.max(1, Math.floor(limit)));
};

const normalizeMaxTextChars = (maxTextChars?: number): number => {
  if (typeof maxTextChars !== "number" || !Number.isFinite(maxTextChars)) {
    return defaultReadSessionMaxTextChars;
  }
  return Math.min(maxReadSessionMaxTextChars, Math.max(1, Math.floor(maxTextChars)));
};

const applyTextBudget = (
  messages: ReadSessionTranscriptMessage[],
  maxTextChars: number
): { messages: ReadSessionTranscriptMessage[]; truncated: boolean } => {
  let remaining = maxTextChars;
  let truncated = false;
  const result = messages.map((message) => ({ ...message }));

  // Keep the newest messages when a caller asks for a small character budget.
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index]!;
    if (message.text.length <= remaining) {
      remaining -= message.text.length;
      continue;
    }
    message.textTruncated = true;
    truncated = true;
    message.text = remaining > 0 ? message.text.slice(0, remaining).trimEnd() : "";
    remaining = 0;
  }
  return { messages: result, truncated };
};

const activeTurnId = (turns: Turn[]): string | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]!.status !== "completed") return turns[index]!.turnId;
  }
  return undefined;
};

export const buildReadSessionTranscript = (
  input: ReadSessionTranscriptInput
): ReadSessionTranscriptResult => {
  const session = input.snapshot.sessions.find(
    (candidate) => candidate.sessionId === input.sessionId
  );
  if (!session) throw new Error(`Unknown session: ${input.sessionId}`);

  const turns = collectVisibleTurns(input.snapshot, input.sessionId);
  const allMessages = collectMessages(
    turns,
    input.snapshot.messageBlocks
  );
  const limit = normalizeMessageLimit(input.limit);
  const selectedMessages = limit === undefined ? allMessages : allMessages.slice(-limit);
  const maxTextChars = normalizeMaxTextChars(input.maxTextChars);
  const budgeted = applyTextBudget(selectedMessages, maxTextChars);
  const lastMessageAt = latest(allMessages.flatMap((message) => [
    message.completedAt,
    message.startedAt
  ].filter((value): value is string => Boolean(value))));
  const truncatedByMessages = selectedMessages.length < allMessages.length;
  const currentTurnId = activeTurnId(turns);

  return {
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    engineId: session.engineId,
    sessionStatus: session.status,
    ...(currentTurnId ? { activeTurnId: currentTurnId } : {}),
    ...(lastMessageAt ? { lastMessageAt } : {}),
    totalTurnCount: turns.length,
    totalMessageCount: allMessages.length,
    returnedMessageCount: budgeted.messages.length,
    truncated: truncatedByMessages || budgeted.truncated,
    truncatedByMessages,
    truncatedByChars: budgeted.truncated,
    maxTextChars,
    turns: turns.map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      ...(turn.finishReason ? { finishReason: turn.finishReason } : {}),
      startedAt: turn.startedAt,
      ...(turn.completedAt ? { completedAt: turn.completedAt } : {})
    })),
    messages: budgeted.messages
  };
};

export const serializeReadSessionTranscript = (
  result: ReadSessionTranscriptResult
): string => JSON.stringify(result, null, 2);
