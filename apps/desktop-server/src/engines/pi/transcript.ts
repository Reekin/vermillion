import {
  parseMessageBlock,
  parseTerminalStream,
  parseToolCall,
  readTurnExecutionProfiles,
  type MessageBlock,
  type TerminalStream,
  type ToolCall,
  type TurnExecutionProfile
} from "@vermillion/shared";
import { sessionItemId } from "../../session-item-id.js";
import type { HydratedTurn } from "../../session-discovery.js";
import { piMessageEntryType, piTurnEntryType } from "./session-identity.js";
import type { PiContentBlock, PiSessionEntry } from "./session-file.js";

export type PiTurnEntities = {
  turns: HydratedTurn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  /** 被判定为继承前缀的轮次 id；fork 成员的 fork 点即最后一个继承轮。 */
  inheritedTurnIds: string[];
};

type TurnDraft = {
  assistantCount: number;
  lastStopReason?: string;
};

const maxSummaryChars = 400;

const summarize = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > maxSummaryChars ? `${text.slice(0, maxSummaryChars)}…` : text;
};

const messageText = (blocks: PiContentBlock[] | undefined): string =>
  (blocks ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");

/** 文本块的 textSignature 记录了本段是 commentary 还是最终答复。 */
const messagePhase = (
  blocks: PiContentBlock[] | undefined
): "commentary" | "final_answer" | undefined => {
  for (const block of blocks ?? []) {
    if (block.type !== "text" || typeof block.textSignature !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(block.textSignature) as { phase?: unknown };
      if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
        return parsed.phase;
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

const markerMessageId = (entry: PiSessionEntry): string | undefined => {
  const data = entry.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const value = (data as { messageId?: unknown }).messageId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const finishReasonFor = (
  stopReason: string | undefined
): "completed" | "interrupted" | "failed" => {
  if (stopReason === "aborted" || stopReason === "interrupted") {
    return "interrupted";
  }
  if (stopReason === "error") {
    return "failed";
  }
  return "completed";
};

/**
 * 引擎轮次由会话开始时写入的 `vermillion.turn` 标记界定，标记条目 id 即轮次 id；
 * `vermillion.message` 标记把工作台分配的用户消息 id 带进历史，
 * 让实时投影和历史读取落到同一个实体。缺少标记时按用户条目 id 兜底成轮。
 */
export const buildPiTurnEntities = (input: {
  sessionId: string;
  entries: readonly PiSessionEntry[];
  forkSourceTurnId?: string;
  executionProfiles?: Record<string, TurnExecutionProfile>;
}): PiTurnEntities => {
  const { sessionId } = input;
  const turns: HydratedTurn[] = [];
  const messageBlocks: MessageBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const terminalStreams: TerminalStream[] = [];
  const toolCallsByRawId = new Map<string, ToolCall>();
  const drafts = new Map<string, TurnDraft>();
  const scoped = (rawId: string): string => sessionItemId(sessionId, rawId);

  let draft: HydratedTurn | undefined;
  let pendingUserMessageId: string | undefined;

  const startTurn = (turnId: string, startedAt: string): HydratedTurn => {
    const turn: HydratedTurn = {
      turnId,
      sessionId,
      status: "completed",
      startedAt,
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: [],
      interactionRequestIds: []
    };
    turns.push(turn);
    drafts.set(turnId, { assistantCount: 0 });
    return turn;
  };

  for (const entry of input.entries) {
    if (entry.type === "custom") {
      if (entry.customType === piTurnEntryType) {
        draft = startTurn(entry.id, entry.timestamp);
        pendingUserMessageId = markerMessageId(entry);
      } else if (entry.customType === piMessageEntryType) {
        pendingUserMessageId = markerMessageId(entry);
      }
      continue;
    }
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      if (!draft) {
        draft = startTurn(entry.id, entry.timestamp);
      }
      const messageId = pendingUserMessageId
        ? scoped(pendingUserMessageId)
        : scoped(`${draft.turnId}:u${draft.messageIds.length}`);
      pendingUserMessageId = undefined;
      const text = messageText(message.content);
      const imageCount = (message.content ?? []).filter(
        (block) => block.type === "image"
      ).length;
      draft.messageIds.push(messageId);
      messageBlocks.push(
        parseMessageBlock({
          blockId: `${messageId}:md`,
          messageId,
          sessionId,
          turnId: draft.turnId,
          role: "user",
          kind: "markdown",
          text:
            imageCount > 0
              ? `${text}${text ? "\n\n" : ""}[${imageCount} image attachment(s)]`
              : text,
          startedAt: entry.timestamp,
          completedAt: entry.timestamp
        })
      );
      draft.completedAt = entry.timestamp;
      continue;
    }
    if (message.role === "assistant") {
      if (!draft) {
        continue;
      }
      const turnDraft = drafts.get(draft.turnId);
      const ordinal = turnDraft?.assistantCount ?? 0;
      if (turnDraft) {
        turnDraft.assistantCount = ordinal + 1;
        turnDraft.lastStopReason = message.stopReason;
      }
      const messageId = scoped(`${draft.turnId}:a${ordinal}`);
      const phase = messagePhase(message.content);
      const text = messageText(message.content);
      draft.messageIds.push(messageId);
      draft.completedAt = entry.timestamp;
      if (text) {
        messageBlocks.push(
          parseMessageBlock({
            blockId: `${messageId}:md`,
            messageId,
            sessionId,
            turnId: draft.turnId,
            role: "assistant",
            ...(phase ? { phase } : {}),
            kind: "markdown",
            text,
            startedAt: entry.timestamp,
            completedAt: entry.timestamp
          })
        );
        if (phase === "final_answer") {
          draft.finalMessageId = messageId;
        }
      }
      for (const block of (message.content ?? []).filter(
        (item) => item.type === "toolCall"
      )) {
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          continue;
        }
        const toolCallId = scoped(block.id);
        draft.toolCallIds.push(toolCallId);
        toolCalls.push(
          parseToolCall({
            toolCallId,
            sessionId,
            turnId: draft.turnId,
            toolName: block.name,
            inputSummary: summarize(block.arguments),
            status: "running",
            startedAt: entry.timestamp
          })
        );
        toolCallsByRawId.set(
          block.id,
          toolCalls[toolCalls.length - 1]!
        );
        if (block.name === "bash") {
          draft.terminalIds.push(toolCallId);
          terminalStreams.push(
            parseTerminalStream({
              terminalId: toolCallId,
              sessionId,
              turnId: draft.turnId,
              toolCallId,
              status: "running",
              outputText: "",
              startedAt: entry.timestamp
            })
          );
        }
      }
      continue;
    }
    if (message.role === "toolResult" && draft) {
      const rawId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const toolCall = rawId ? toolCallsByRawId.get(rawId) : undefined;
      if (toolCall) {
        const outputText = messageText(message.content);
        toolCall.status = message.isError ? "failed" : "completed";
        toolCall.outputSummary = summarize(outputText);
        toolCall.completedAt = entry.timestamp;
        const terminal = terminalStreams.find(
          (stream) => stream.toolCallId === toolCall.toolCallId
        );
        if (terminal) {
          terminal.status = message.isError ? "failed" : "completed";
          terminal.outputText = outputText;
          terminal.completedAt = entry.timestamp;
        }
      }
      draft.completedAt = entry.timestamp;
    }
  }

  const forkIndex = input.forkSourceTurnId
    ? turns.findIndex((turn) => turn.turnId === input.forkSourceTurnId)
    : -1;
  const ownedTurns = forkIndex >= 0 ? turns.slice(forkIndex + 1) : turns;
  const ownedTurnIds = new Set(ownedTurns.map((turn) => turn.turnId));

  return {
    turns: ownedTurns.map((turn) => {
      const turnDraft = drafts.get(turn.turnId);
      const withFinal = turn.finalMessageId
        ? turn
        : turn.messageIds.length > 0
          ? { ...turn, finalMessageId: turn.messageIds.at(-1) }
          : turn;
      return {
        ...withFinal,
        finishReason: finishReasonFor(turnDraft?.lastStopReason),
        ...(input.executionProfiles?.[turn.turnId]
          ? { executionProfile: input.executionProfiles[turn.turnId] }
          : {})
      };
    }),
    messageBlocks: messageBlocks.filter((block) => ownedTurnIds.has(block.turnId)),
    toolCalls: toolCalls.filter((call) => ownedTurnIds.has(call.turnId)),
    terminalStreams: terminalStreams.filter((stream) =>
      ownedTurnIds.has(stream.turnId)
    ),
    inheritedTurnIds: turns.slice(0, forkIndex + 1).map((turn) => turn.turnId)
  };
};

export const readPiTurnExecutionProfiles = (
  metadata: Record<string, unknown> | undefined
): Record<string, TurnExecutionProfile> => readTurnExecutionProfiles(metadata);
