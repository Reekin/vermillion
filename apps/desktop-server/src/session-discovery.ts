import type {
  ChatSession,
  Conversation,
  MessageBlock,
  SessionRelation,
  SessionStatus,
  TerminalStream,
  ToolCall,
  Turn
} from "@vermillion/shared";
import {
  appendLimitedStreamText,
  parseChatSession,
  parseConversation,
  parseMessageBlock,
  parseSessionRelation,
  parseTerminalStream,
  parseToolCall,
  parseTurn
} from "@vermillion/shared";
import { readTurnExecutionProfiles } from "@vermillion/shared";
import { isPathInsideWorkspace } from "@vermillion/shared";
import type { Thread } from "./codex-app-server-generated/v2/Thread.js";
import type { CodexErrorInfo } from "./codex-app-server-generated/v2/CodexErrorInfo.js";
import type { FileUpdateChange } from "./codex-app-server-generated/v2/FileUpdateChange.js";
import type { ThreadItem } from "./codex-app-server-generated/v2/ThreadItem.js";
import type { SessionSource } from "./codex-app-server-generated/v2/SessionSource.js";
import type { UserInput } from "./codex-app-server-generated/v2/UserInput.js";
import { pathToFileURL } from "node:url";
import { engineItemKey, sessionItemId } from "./session-item-id.js";
import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import type {
  SessionIndexEntry,
  SessionRelationIndex,
  SessionIndexStore,
  UpsertSessionIndexInput,
  UpsertSessionRelationInput
} from "./session-index.js";
import type { WorkspaceRecord, WorkspaceRegistryService } from "./workspace-registry.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  CodexTurnChangesStore,
  getRecordedCodexTurnChanges,
  recordCodexTurnChangesFromFileUpdate
} from "./engine-extensions/codex/turn-changes-store.js";
import {
  isCodexContextCompactionThreadItem,
  isCodexImageGenerationThreadItem,
  isCodexImageViewThreadItem,
  isCodexReasoningThreadItem,
  isCodexWebSearchThreadItem,
  mapCodexResponseItemStatus,
  summarizeCodexImageGenerationInput,
  summarizeCodexImageGenerationOutput,
  summarizeCodexImageViewInput,
  summarizeCodexImageViewOutput,
  summarizeCodexReasoningThreadItem,
  summarizeCodexWebSearchAction
} from "./engine-extensions/codex/process-activity.js";
import {
  consumeCodexRolloutTimestampForItem,
  type CodexRolloutTimestampGroup,
  readCodexRolloutModifiedAt,
  readCodexRolloutTimestampGroups,
  resolveCodexThreadItemTimestamp
} from "./engine-extensions/codex/rollout-timestamps.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import {
  codexProviderKind,
  discoveredCodexSessionId
} from "./codex-session-identity.js";
export {
  codexProviderKind,
  discoveredCodexSessionId
} from "./codex-session-identity.js";

const codexAgentId = "codex";
const discoveryMetadataConcurrency = 16;

const mapWithConcurrency = async <T, R>(
  values: readonly T[],
  concurrency: number,
  mapValue: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapValue(values[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
};

const isoFromUnixSeconds = (value: number): string =>
  new Date(value * 1_000).toISOString();

export const discoveredConversationId = (rootSessionId: string): string =>
  `conversation-discovered:${rootSessionId}`;

const trimToUndefined = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const rolloutPathForEntry = (
  entry: SessionIndexEntry,
  thread: Thread
): string | undefined =>
  trimToUndefined(thread.path) ??
  (typeof entry.metadata?.rolloutPath === "string"
    ? trimToUndefined(entry.metadata.rolloutPath)
    : undefined);

const summarizeThread = (thread: Thread): string | undefined =>
  trimToUndefined(thread.preview) ?? trimToUndefined(thread.name);

const titleForThread = (thread: Thread): string =>
  trimToUndefined(thread.name) ??
  trimToUndefined(thread.preview)?.split("\n").map((line) => line.trim()).find(Boolean) ??
  discoveredCodexSessionId(thread.id);

const mapThreadStatus = (thread: Thread): SessionStatus => {
  switch (thread.status.type) {
    case "active":
      return "running";
    case "systemError":
      return "error";
    case "idle":
    case "notLoaded":
    default:
      return "idle";
  }
};

const toSubagentParentThreadId = (source: SessionSource): string | undefined => {
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return undefined;
  }
  const subAgentSource = source.subAgent;
  if (
    !subAgentSource ||
    typeof subAgentSource !== "object" ||
    !("thread_spawn" in subAgentSource)
  ) {
    return undefined;
  }
  return trimToUndefined(subAgentSource.thread_spawn.parent_thread_id);
};

const isGuardianThreadSource = (source: SessionSource): boolean => {
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return false;
  }
  const subAgentSource = source.subAgent;
  return Boolean(
    subAgentSource &&
      typeof subAgentSource === "object" &&
      "other" in subAgentSource &&
      subAgentSource.other === "guardian"
  );
};

const buildDeterministicTurnTimestamp = (
  thread: Thread,
  turnIndex: number,
  itemIndex = 0
): string => new Date((thread.createdAt + turnIndex * 60 + itemIndex) * 1_000).toISOString();

const uuidV7Timestamp = (value: string): number | undefined => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return undefined;
  }
  const timestamp = Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
};

const isCodexTurnOwnedByThread = (
  thread: Thread,
  turn: Thread["turns"][number]
): boolean => {
  if (!thread.forkedFromId) return true;
  if (typeof turn.startedAt === "number" && turn.startedAt < thread.createdAt) return false;
  if (typeof turn.startedAt === "number" && turn.startedAt > thread.createdAt) return true;
  const threadTimestamp = uuidV7Timestamp(thread.id);
  const turnTimestamp = uuidV7Timestamp(turn.id);
  return threadTimestamp === undefined || turnTimestamp === undefined ||
    turnTimestamp >= threadTimestamp;
};

const resolveCodexForkSourceTurnId = (thread: Thread): string | undefined => {
  if (!thread.forkedFromId) return undefined;
  const firstOwnedTurn = thread.turns.findIndex((turn) =>
    isCodexTurnOwnedByThread(thread, turn)
  );
  if (firstOwnedTurn <= 0) return undefined;
  return thread.turns
    .slice(0, firstOwnedTurn)
    .every((turn) => !isCodexTurnOwnedByThread(thread, turn))
      ? thread.turns[firstOwnedTurn - 1]?.id
      : undefined;
};

const buildRelationId = (
  parentSessionId: string,
  childSessionId: string,
  relationType: SessionRelation["relationType"]
): string => `relation-discovered:${parentSessionId}:${childSessionId}:${relationType}`;

const lastTimestamp = (timestamps: string[]): string | undefined => {
  let latest: string | undefined;
  for (const timestamp of timestamps) {
    if (!latest || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
};

const resolveThreadTurnItemStartedAts = (
  thread: Thread,
  turnIndex: number,
  rolloutTimestampGroups: readonly CodexRolloutTimestampGroup[] = []
): string[] => {
  const turn = thread.turns[turnIndex];
  if (!turn) {
    return [];
  }
  const rolloutTimestampGroup = resolveRolloutTimestampGroup(
    turn,
    turnIndex,
    rolloutTimestampGroups
  );
  const rolloutTimestamps = [...(rolloutTimestampGroup?.items ?? [])];
  return turn.items.map(
    (item, itemIndex) =>
      resolveCodexThreadItemTimestamp(item) ??
      consumeCodexRolloutTimestampForItem(rolloutTimestamps, item) ??
      buildDeterministicTurnTimestamp(thread, turnIndex, itemIndex)
  );
};

const resolveRolloutTimestampGroup = (
  turn: Thread["turns"][number],
  turnIndex: number,
  rolloutTimestampGroups: readonly CodexRolloutTimestampGroup[]
): CodexRolloutTimestampGroup | undefined =>
  rolloutTimestampGroups.find((group) => group.turnId === turn.id) ??
  rolloutTimestampGroups[turnIndex];

const resolveThreadTurnStartedAt = (
  thread: Thread,
  turnIndex: number,
  itemStartedAts: readonly string[],
  rolloutTimestampGroup?: CodexRolloutTimestampGroup
): string => {
  const turn = thread.turns[turnIndex]!;
  const fallbackStartedAt = buildDeterministicTurnTimestamp(thread, turnIndex);
  const protocolStartedAt = typeof turn.startedAt === "number" &&
      Number.isFinite(turn.startedAt)
    ? isoFromUnixSeconds(turn.startedAt)
    : undefined;
  const firstItemStartedAt = itemStartedAts[0];
  if (firstItemStartedAt && firstItemStartedAt !== fallbackStartedAt) {
    return firstItemStartedAt;
  }
  return rolloutTimestampGroup?.startedAt ??
    protocolStartedAt ??
    firstItemStartedAt ??
    fallbackStartedAt;
};

const resolveThreadTurnCompletedAt = (
  thread: Thread,
  turnIndex: number,
  itemStartedAts: readonly string[],
  rolloutTimestampGroup?: CodexRolloutTimestampGroup
): string | undefined => {
  const turn = thread.turns[turnIndex];
  if (!turn || turn.status === "inProgress") {
    return undefined;
  }
  return (
    rolloutTimestampGroup?.completedAt ??
    (typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt)
      ? isoFromUnixSeconds(turn.completedAt)
      : undefined) ??
    lastTimestamp([...itemStartedAts]) ??
    buildDeterministicTurnTimestamp(thread, turnIndex, turn.items.length + 1)
  );
};

const resolveThreadLastCompletedTurnAt = (
  thread: Thread,
  rolloutTimestampGroups: readonly CodexRolloutTimestampGroup[] = []
): string | undefined => {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    if (turn?.status !== "inProgress") {
      const rolloutTimestampGroup = resolveRolloutTimestampGroup(
        turn,
        turnIndex,
        rolloutTimestampGroups
      );
      return resolveThreadTurnCompletedAt(
        thread,
        turnIndex,
        resolveThreadTurnItemStartedAts(thread, turnIndex, rolloutTimestampGroups),
        rolloutTimestampGroup
      );
    }
  }
  return undefined;
};

const isCommandExecutionItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "commandExecution" }> =>
  item.type === "commandExecution";

const isFileChangeItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "fileChange" }> => item.type === "fileChange";

const isCollabAgentToolCallItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "collabAgentToolCall" }> =>
  item.type === "collabAgentToolCall";

const isAgentMessageItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "agentMessage" }> =>
  item.type === "agentMessage";

const isFinalAnswerMessageItem = (
  item: Extract<ThreadItem, { type: "agentMessage" }>
): boolean => item.phase === "final_answer";

const isUserMessageItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "userMessage" }> =>
  item.type === "userMessage";

const mapCollabToolLabel = (
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"]
): string => {
  switch (tool) {
    case "spawnAgent":
      return "subagent.spawn";
    case "sendInput":
      return "subagent.message";
    case "resumeAgent":
      return "subagent.resume";
    case "wait":
      return "subagent.wait";
    case "closeAgent":
      return "subagent.close";
    default:
      return `subagent.${tool}`;
  }
};

const summarizeCollabInput = (
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): string | undefined => {
  const parts = [
    item.prompt?.trim(),
    item.model ? `model: ${item.model}` : undefined,
    item.reasoningEffort ? `reasoning: ${item.reasoningEffort}` : undefined,
    item.receiverThreadIds.length > 0
      ? `targets: ${item.receiverThreadIds.join(", ")}`
      : undefined
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const summarizeCollabOutput = (
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): string | undefined => {
  const lines = item.receiverThreadIds.map((threadId) => {
    const state = item.agentsStates[threadId];
    if (!state) {
      return `${threadId}: unknown`;
    }
    const detail = trimToUndefined(state.message);
    return detail
      ? `${threadId}: ${state.status} — ${detail}`
      : `${threadId}: ${state.status}`;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
};

const toLocalImageMarkdownUrl = (value: string): string => {
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return pathToFileURL(value).toString();
  }
  if (/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(value)) {
    return value;
  }
  return pathToFileURL(value).toString();
};

const summarizeUserInput = (
  input: UserInput
): string | undefined => {
  switch (input.type) {
    case "text":
      return input.text;
    case "image":
      return `![image](${input.url})`;
    case "localImage":
      return `![image](${toLocalImageMarkdownUrl(input.path)})`;
    case "skill":
      return `skill: ${input.name} (${input.path})`;
    case "mention":
      return `mention: ${input.name} (${input.path})`;
    default:
      return undefined;
  }
};

const summarizeUserMessage = (content: UserInput[]): string =>
  content
    .map((input) => summarizeUserInput(input)?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

const formatCodexErrorInfo = (value: CodexErrorInfo | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  const [key] = Object.keys(value);
  return key ? key : undefined;
};

const formatTurnErrorText = (input: {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails?: string | null;
}): string => {
  const errorCode = formatCodexErrorInfo(input.codexErrorInfo);
  const headline = errorCode
    ? `Runtime error (${errorCode}): ${input.message}`
    : `Runtime error: ${input.message}`;
  const details = trimToUndefined(input.additionalDetails);
  return details ? `${headline}\n\n${details}` : headline;
};

export type DiscoveredSessionRecord = {
  sessionId: string;
  engineId: string;
  providerKind: string;
  providerSessionId: string;
  title: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
  lastCompletedTurnAt?: string;
  archivedAt?: string;
  metadata?: Record<string, unknown>;
};

export type DiscoveredSessionRelation = {
  parentSessionId: string;
  childSessionId: string;
  relationType: "fork" | "subagent";
  createdAt: string;
};

export type DiscoveredWorkspaceResult = {
  sessions: DiscoveredSessionRecord[];
  relations: DiscoveredSessionRelation[];
};

export type HydratedTurn = Turn & {
  finalMessageId?: string;
};

export type HydratedSessionSnapshot = {
  workspaceId: string;
  conversation: Conversation;
  session: ChatSession;
  turns: HydratedTurn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  sessionRelations: SessionRelation[];
  runtimeBinding?: {
    providerKind: string;
    providerSessionId: string;
  };
};

export type HydratedSessionWindowSnapshot = HydratedSessionSnapshot & {
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
};

export type SessionDiscoveryProvider = {
  readonly engineId: string;
  discoverWorkspaces: (
    workspaces: readonly WorkspaceRecord[]
  ) => Promise<ReadonlyMap<string, DiscoveredWorkspaceResult>>;
  hydrateSession: (
    entry: SessionIndexEntry,
    input?: {
      isCancelled?: () => boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
      historySources?: { entry: SessionIndexEntry; sourceTurnIds: string[] }[];
    }
  ) => Promise<HydratedSessionSnapshot | undefined>;
  hydrateSessionWindow?: (
    entry: SessionIndexEntry,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
    }
  ) => Promise<HydratedSessionWindowSnapshot | undefined>;
  ensureSessionExecutable?: (
    entry: SessionIndexEntry,
    input?: { signal?: AbortSignal }
  ) => Promise<boolean>;
};

type HydrationConsumer = {
  isCancelled?: () => boolean;
  signal?: AbortSignal;
};

type SharedHydrationTask<T> = {
  consumers: Set<HydrationConsumer>;
  promise: Promise<T>;
};

const areAllHydrationConsumersCancelled = (
  consumers: ReadonlySet<HydrationConsumer>
): boolean => {
  if (consumers.size === 0) {
    return false;
  }
  for (const consumer of consumers) {
    if (!consumer.signal?.aborted && !consumer.isCancelled?.()) {
      return false;
    }
  }
  return true;
};

const resolveHydratedLastCompletedTurnAt = (
  turns: readonly HydratedTurn[]
): string | undefined => {
  let latestCompletedAt: string | undefined;
  for (const turn of turns) {
    if (turn.status !== "completed" || !turn.completedAt) {
      continue;
    }
    if (!latestCompletedAt || turn.completedAt > latestCompletedAt) {
      latestCompletedAt = turn.completedAt;
    }
  }
  return latestCompletedAt;
};

const resolveHydratedLastUserMessageAt = (
  messageBlocks: readonly MessageBlock[]
): string | undefined => {
  let latestUserMessageAt: string | undefined;
  for (const messageBlock of messageBlocks) {
    if (messageBlock.role !== "user") {
      continue;
    }
    if (!latestUserMessageAt || messageBlock.startedAt > latestUserMessageAt) {
      latestUserMessageAt = messageBlock.startedAt;
    }
  }
  return latestUserMessageAt;
};

const isActiveSessionStatus = (status: SessionStatus): boolean =>
  status === "running" || status === "awaiting_approval";

const mergeTurnIds = (...lists: readonly string[][]): string[] => [
  ...new Set(lists.flat())
];

const latestIso = (
  left: string | undefined,
  right: string | undefined
): string | undefined => {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs > rightMs ? left : right;
  }
  return left > right ? left : right;
};

type HydratedCodexTurnEntities = {
  turns: HydratedTurn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
};

const hydrateCodexTurnEntities = async (input: {
  entry: SessionIndexEntry;
  thread: Thread;
  rolloutPath?: string;
  turnChangesStore?: CodexTurnChangesStore;
  isCancelled?: () => boolean;
}): Promise<HydratedCodexTurnEntities | undefined> => {
  const { entry, thread, rolloutPath, turnChangesStore, isCancelled } = input;
  const turns: HydratedTurn[] = [];
  const messageBlocks: MessageBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const terminalStreams: TerminalStream[] = [];
  const executionProfiles = readTurnExecutionProfiles(entry.metadata);
  const rolloutTimestampGroups = await readCodexRolloutTimestampGroups(
    rolloutPath ?? thread.path
  );

  const ownedThread = thread.forkedFromId
    ? { ...thread, turns: thread.turns.filter((turn) => isCodexTurnOwnedByThread(thread, turn)) }
    : thread;
  for (const [turnIndex, turn] of ownedThread.turns.entries()) {
    if (isCancelled?.()) {
      return undefined;
    }
    const hydratedItems = turn.items;
    const rolloutTimestampGroup = resolveRolloutTimestampGroup(
      turn,
      turnIndex,
      rolloutTimestampGroups
    );
    const itemStartedAts = resolveThreadTurnItemStartedAts(
      ownedThread,
      turnIndex,
      rolloutTimestampGroups
    );
    const startedAt = resolveThreadTurnStartedAt(
      ownedThread,
      turnIndex,
      itemStartedAts,
      rolloutTimestampGroup
    );
    const completedAt = resolveThreadTurnCompletedAt(
      ownedThread,
      turnIndex,
      itemStartedAts,
      rolloutTimestampGroup
    );
    const messageIds: string[] = [];
    const toolCallIds: string[] = [];
    const terminalIds: string[] = [];
    const fileChanges: FileUpdateChange[] = [];
    let finalMessageId: string | undefined;
    let lastAgentMessageId: string | undefined;

    for (const [itemIndex, item] of hydratedItems.entries()) {
      if (isCancelled?.()) {
        return undefined;
      }
      const itemStartedAt =
        itemStartedAts[itemIndex] ??
        buildDeterministicTurnTimestamp(ownedThread, turnIndex, itemIndex);
      const itemEntityId = sessionItemId(entry.sessionId, engineItemKey(item));
      if (isUserMessageItem(item)) {
        messageIds.push(itemEntityId);
        messageBlocks.push(
          parseMessageBlock({
            blockId: `${itemEntityId}:md`,
            messageId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            role: "user",
            kind: "markdown",
            text: summarizeUserMessage(item.content),
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }
      if (isAgentMessageItem(item)) {
        messageIds.push(itemEntityId);
        lastAgentMessageId = itemEntityId;
        if (isFinalAnswerMessageItem(item)) {
          finalMessageId = itemEntityId;
        }
        messageBlocks.push(
          parseMessageBlock({
            blockId: `${itemEntityId}:md`,
            messageId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            role: "assistant",
            phase: item.phase ?? undefined,
            kind: "markdown",
            text: item.text,
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }
      if (isCommandExecutionItem(item)) {
        toolCallIds.push(itemEntityId);
        terminalIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "commandExecution",
            inputSummary: item.command,
            outputSummary: item.aggregatedOutput != null
              ? appendLimitedStreamText(undefined, item.aggregatedOutput)
              : undefined,
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "completed"
                  ? "completed"
                  : "running",
            startedAt: itemStartedAt,
            completedAt:
              item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
        terminalStreams.push(
          parseTerminalStream({
            terminalId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolCallId: itemEntityId,
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "completed"
                  ? "completed"
                  : "running",
            outputText: appendLimitedStreamText(
              undefined,
              item.aggregatedOutput ?? undefined
            ),
            exitCode: item.exitCode ?? undefined,
            startedAt: itemStartedAt,
            completedAt:
              item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
        continue;
      }

      if (isFileChangeItem(item)) {
        fileChanges.push(...item.changes);
        continue;
      }

      if (isCodexReasoningThreadItem(item)) {
        const outputSummary = summarizeCodexReasoningThreadItem(item);
        if (!outputSummary) {
          continue;
        }
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "reasoning",
            inputSummary: "Reasoning",
            outputSummary,
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexWebSearchThreadItem(item)) {
        const inputSummary = summarizeCodexWebSearchAction(item.action, item.query);
        if (!inputSummary) {
          continue;
        }
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "webSearch",
            inputSummary,
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexContextCompactionThreadItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "contextCompaction",
            inputSummary: "compacting...",
            outputSummary: "compaction finished",
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexImageViewThreadItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "imageView",
            inputSummary: summarizeCodexImageViewInput(item),
            outputSummary: summarizeCodexImageViewOutput(item),
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexImageGenerationThreadItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "imageGeneration",
            inputSummary: summarizeCodexImageGenerationInput(item),
            outputSummary: summarizeCodexImageGenerationOutput(item),
            status:
              item.status === "inProgress"
                ? "running"
                : mapCodexResponseItemStatus(item.status),
            startedAt: itemStartedAt,
            completedAt: item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
        continue;
      }

      if (isCollabAgentToolCallItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: mapCollabToolLabel(item.tool),
            inputSummary: summarizeCollabInput(item),
            outputSummary: summarizeCollabOutput(item),
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "completed"
                  ? "completed"
                  : "running",
            startedAt: itemStartedAt,
            completedAt:
              item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
      }
    }

    if (!finalMessageId && turn.status !== "inProgress") {
      finalMessageId = lastAgentMessageId;
    }

    if (turn.error) {
      const errorMessageId = `runtime-error:${turn.id}`;
      messageIds.push(errorMessageId);
      messageBlocks.push(
        parseMessageBlock({
          blockId: `${errorMessageId}:md`,
          messageId: errorMessageId,
          sessionId: entry.sessionId,
          turnId: turn.id,
          role: "system",
          kind: "markdown",
          text: formatTurnErrorText(turn.error),
          startedAt: completedAt ?? startedAt,
          completedAt: completedAt ?? startedAt
        })
      );
    }

    recordCodexTurnChangesFromFileUpdate({
      sessionId: entry.sessionId,
      turnId: turn.id,
      changes: fileChanges
    });
    const turnChanges = getRecordedCodexTurnChanges(entry.sessionId, turn.id);
    if (turnChanges) {
      turnChangesStore?.record(turnChanges);
    }

    const hydratedTurn = parseTurn({
      turnId: turn.id,
      sessionId: entry.sessionId,
      status: turn.status === "inProgress" ? "streaming" : "completed",
      executionProfile: executionProfiles[turn.id],
      finishReason:
        turn.status === "failed"
          ? "failed"
          : turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "completed"
              ? "completed"
              : undefined,
      startedAt,
      completedAt,
      messageIds,
      toolCallIds,
      terminalIds,
      approvalRequestIds: []
    });

    turns.push({
      ...hydratedTurn,
      ...(finalMessageId ? { finalMessageId } : {})
    });
  }

  return {
    turns,
    messageBlocks,
    toolCalls,
    terminalStreams
  };
};

type SessionRoleInstructionsResolver = (workspaceId: string, metadata: Record<string, unknown>) => Promise<string | undefined>;

export class CodexSessionDiscoveryProvider implements SessionDiscoveryProvider {
  public readonly engineId = codexAgentId;

  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly turnChangesStore: CodexTurnChangesStore | undefined;
  private readonly resolveHistoryCwd: ((workspaceId: string) => string | undefined) | undefined;
  private readonly resolveRoleInstructions: SessionRoleInstructionsResolver | undefined;

  public constructor(options: {
    codexRuntimePort: CodexAppServerRuntimePort;
    turnChangesStore?: CodexTurnChangesStore;
    resolveHistoryCwd?: (workspaceId: string) => string | undefined;
    resolveRoleInstructions?: SessionRoleInstructionsResolver;
  }) {
    this.codexRuntimePort = options.codexRuntimePort;
    this.turnChangesStore = options.turnChangesStore;
    this.resolveHistoryCwd = options.resolveHistoryCwd;
    this.resolveRoleInstructions = options.resolveRoleInstructions;
  }

  /** Loading a thread fixes the instructions Codex re-renders after compaction, so they must be current. */
  private roleInstructionsFor(entry: SessionIndexEntry): Promise<string | undefined> {
    return this.resolveRoleInstructions?.(entry.workspaceId, entry.metadata ?? {}) ?? Promise.resolve(undefined);
  }

  private async withHistory<T>(
    entry: SessionIndexEntry,
    read: (thread: Thread, restored: boolean) => Promise<T>,
    signal?: AbortSignal,
    retainExecution = false
  ): Promise<T> {
    const header = await this.codexRuntimePort.readThread(entry.providerSessionId!, false, { signal });
    const restored = !entry.archivedAt && header.status.type === "notLoaded";
    const thread = restored
      ? await this.codexRuntimePort.resumeThread(
          header.id,
          this.resolveHistoryCwd?.(entry.workspaceId) ?? header.cwd,
          await this.roleInstructionsFor(entry),
          { signal }
        )
      : header;
    try {
      return await read(thread, restored);
    } finally {
      if (restored && !retainExecution) await this.codexRuntimePort.releaseHistoryRead(thread.id);
    }
  }

  public async discoverWorkspaces(
    workspaces: readonly WorkspaceRecord[]
  ): Promise<ReadonlyMap<string, DiscoveredWorkspaceResult>> {
    if (workspaces.length === 0) {
      return new Map();
    }
    const listedThreads = await this.listAllThreads();
    const threadsByWorkspaceId = new Map(
      workspaces.map((workspace) => [workspace.workspaceId, new Map<string, Thread>()] as const)
    );
    const candidateThreadsById = new Map<string, Thread>();
    for (const thread of listedThreads) {
      if (isGuardianThreadSource(thread.source)) {
        continue;
      }
      for (const workspace of workspaces) {
        if (!isPathInsideWorkspace(thread.cwd, workspace.absolutePath)) {
          continue;
        }
        threadsByWorkspaceId.get(workspace.workspaceId)?.set(thread.id, thread);
        candidateThreadsById.set(thread.id, thread);
      }
    }

    const discoveredSessionsByThreadId = new Map(
      await mapWithConcurrency(
        [...candidateThreadsById.values()],
        discoveryMetadataConcurrency,
        async (thread) => [thread.id, await this.toDiscoveredSessionRecord(thread)] as const
      )
    );

    return new Map(
      workspaces.map((workspace) => {
        const threads = [...(threadsByWorkspaceId.get(workspace.workspaceId)?.values() ?? [])];
        const sessions = threads.map((thread) => discoveredSessionsByThreadId.get(thread.id)!);
        const sessionIds = new Set(sessions.map((session) => session.sessionId));
        const relations = threads
          .flatMap((thread) => {
            const relations: DiscoveredSessionRelation[] = [];
            const subagentParentThreadId = toSubagentParentThreadId(thread.source);
            if (subagentParentThreadId) {
              relations.push({
                parentSessionId: discoveredCodexSessionId(subagentParentThreadId),
                childSessionId: discoveredCodexSessionId(thread.id),
                relationType: "subagent",
                createdAt: isoFromUnixSeconds(thread.createdAt)
              });
            }
            if (!subagentParentThreadId && thread.forkedFromId) {
              relations.push({
                parentSessionId: discoveredCodexSessionId(thread.forkedFromId),
                childSessionId: discoveredCodexSessionId(thread.id),
                relationType: "fork",
                createdAt: isoFromUnixSeconds(thread.createdAt)
              });
            }
            return relations;
          })
          .filter((relation) => sessionIds.has(relation.parentSessionId));

        return [workspace.workspaceId, { sessions, relations }] as const;
      })
    );
  }

  public async ensureSessionExecutable(
    entry: SessionIndexEntry,
    input: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    const threadId = entry.providerSessionId;
    if (!threadId) {
      return false;
    }
    if (this.codexRuntimePort.getThreadIdForSession(entry.sessionId) === threadId
      && !this.codexRuntimePort.isThreadExecutionReleased(threadId)) {
      return true;
    }
    const thread = await this.codexRuntimePort.resumeThread(
      threadId,
      this.resolveHistoryCwd?.(entry.workspaceId),
      await this.roleInstructionsFor(entry),
      { signal: input.signal }
    );
    this.codexRuntimePort.attachThreadToSession(entry.sessionId, thread.id);
    return true;
  }

  public async hydrateSession(
    entry: SessionIndexEntry,
    input: {
      isCancelled?: () => boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
      historySources?: { entry: SessionIndexEntry; sourceTurnIds: string[] }[];
    } = {}
  ): Promise<HydratedSessionSnapshot | undefined> {
    const threadId = entry.providerSessionId;
    if (!threadId) {
      return undefined;
    }
    const readHistory = async (read: (thread: Thread, restored: boolean) => Promise<HydratedSessionSnapshot | undefined>) => {
      if (!entry.archivedAt || !input.historySources) {
        return this.withHistory(entry, read, input.signal, input.retainExecution);
      }
      const header = await this.codexRuntimePort.readThread(threadId, false, { signal: input.signal });
      let sharedTurns: Thread["turns"] = [];
      for (const source of input.historySources) {
        const turns = await this.withHistory(source.entry, async (thread, restored) => {
          const history = restored
            ? thread
            : await this.codexRuntimePort.readThread(thread.id, true, { signal: input.signal });
          const end = history.turns.findIndex((turn) => source.sourceTurnIds.includes(turn.id));
          if (end < 0) throw new Error(`Fork points ${source.sourceTurnIds.join(", ")} are missing from ${thread.id}`);
          return history.turns.slice(0, end + 1);
        }, input.signal);
        // Every source contains a prefix of the same archived linear history.
        if (turns.length > sharedTurns.length) sharedTurns = turns;
      }
      return read({ ...header, turns: sharedTurns }, true);
    };
    return readHistory(async (header, restored) => {
      const thread = restored
        ? header
        : await this.codexRuntimePort.readThread(threadId, true, { signal: input.signal });
      if (input.isCancelled?.()) {
        return undefined;
      }
      this.codexRuntimePort.attachThreadToSession(entry.sessionId, thread.id, false);
      await this.refreshThreadGoal(entry.sessionId);
      const workspaceId = entry.workspaceId;
      const conversation = parseConversation({
        conversationId: entry.conversationId,
        workspaceId,
        participantEngineIds: [codexAgentId],
        activeSessionId: entry.sessionId,
        sessionIds: [entry.sessionId],
        createdAt: isoFromUnixSeconds(thread.createdAt),
        updatedAt: isoFromUnixSeconds(thread.updatedAt)
      });
      const session = parseChatSession({
        sessionId: entry.sessionId,
        conversationId: entry.conversationId,
        engineId: codexAgentId,
        status: mapThreadStatus(thread),
        title: entry.title ?? titleForThread(thread),
        createdAt: isoFromUnixSeconds(thread.createdAt),
        updatedAt: isoFromUnixSeconds(thread.updatedAt),
        archivedAt: entry.archivedAt,
        lastTurnId: thread.turns.at(-1)?.id,
        metadata: {
          ...(entry.metadata ?? {}),
          providerKind: codexProviderKind,
          providerSessionId: thread.id,
          rolloutPath: thread.path ?? undefined,
          cwd: thread.cwd
        }
      });

      const hydratedTurns = await hydrateCodexTurnEntities({
        entry,
        thread,
        rolloutPath: rolloutPathForEntry(entry, thread),
        turnChangesStore: this.turnChangesStore,
        isCancelled: input.isCancelled
      });
      if (!hydratedTurns) {
        return undefined;
      }
      const { turns, messageBlocks, toolCalls, terminalStreams } = hydratedTurns;

      const sessionRelations = this.buildHydratedRelations(
        thread,
        resolveCodexForkSourceTurnId(thread)
      );

      return {
        workspaceId,
        conversation,
        session,
        turns,
        messageBlocks,
        toolCalls,
        terminalStreams,
        sessionRelations,
        runtimeBinding: {
          providerKind: codexProviderKind,
          providerSessionId: thread.id
        }
      };
    });
  }

  public async hydrateSessionWindow(
    entry: SessionIndexEntry,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
    }
  ): Promise<HydratedSessionWindowSnapshot | undefined> {
    const threadId = entry.providerSessionId;
    if (!threadId) {
      return undefined;
    }
    const anchorTurnId = input.cursor ? undefined : input.anchorTurnId;
    const cursor =
      input.cursor ??
      (anchorTurnId
        ? JSON.stringify({
            turnId: anchorTurnId,
            includeAnchor: true
          })
        : null);
    return this.withHistory(entry, async (thread) => {
      const turnsInput = {
          threadId,
          cursor,
          limit: input.limit,
          sortDirection: "desc",
          itemsView: "full"
        } as const;
      const turnsPage = await this.codexRuntimePort.listThreadTurns(turnsInput, { signal: input.signal });
      if (input.isCancelled?.()) {
        return undefined;
      }
      let pageTurns = turnsPage.data;
      const incompleteTurnIds = new Set(
        pageTurns
          .filter(
            (turn) =>
              turn.itemsView === "full" &&
              turn.status === "completed" &&
              turn.items.some(isUserMessageItem) &&
              !turn.items.some(isAgentMessageItem)
          )
          .map((turn) => turn.id)
      );
      if (incompleteTurnIds.size > 0) {
        const completeThread = await this.codexRuntimePort.readThread(threadId, true, { signal: input.signal });
        const completeTurnsById = new Map(
          completeThread.turns
            .filter(
              (turn) =>
                incompleteTurnIds.has(turn.id) && turn.items.some(isAgentMessageItem)
            )
            .map((turn) => [turn.id, turn] as const)
        );
        pageTurns = pageTurns.map((turn) => completeTurnsById.get(turn.id) ?? turn);
      }
      if (input.isCancelled?.()) {
        return undefined;
      }
      const pageThread: Thread = {
        ...thread,
        turns: pageTurns
      };
      this.codexRuntimePort.attachThreadToSession(entry.sessionId, thread.id, false);
      await this.refreshThreadGoal(entry.sessionId);
      const workspaceId = entry.workspaceId;
      const conversation = parseConversation({
        conversationId: entry.conversationId,
        workspaceId,
        participantEngineIds: [codexAgentId],
        activeSessionId: entry.sessionId,
        sessionIds: [entry.sessionId],
        createdAt: isoFromUnixSeconds(thread.createdAt),
        updatedAt: isoFromUnixSeconds(thread.updatedAt)
      });
      const session = parseChatSession({
        sessionId: entry.sessionId,
        conversationId: entry.conversationId,
        engineId: codexAgentId,
        status: mapThreadStatus(thread),
        title: entry.title ?? titleForThread(thread),
        createdAt: isoFromUnixSeconds(thread.createdAt),
        updatedAt: isoFromUnixSeconds(thread.updatedAt),
        archivedAt: entry.archivedAt,
        lastTurnId: entry.lastTurnId ?? pageTurns[0]?.id,
        metadata: {
          ...(entry.metadata ?? {}),
          providerKind: codexProviderKind,
          providerSessionId: thread.id,
          rolloutPath: thread.path ?? undefined,
          cwd: thread.cwd
        }
      });
      const hydratedTurns = await hydrateCodexTurnEntities({
        entry,
        thread: pageThread,
        rolloutPath: rolloutPathForEntry(entry, thread),
        turnChangesStore: this.turnChangesStore,
        isCancelled: input.isCancelled
      });
      if (!hydratedTurns) {
        return undefined;
      }
      const { turns, messageBlocks, toolCalls, terminalStreams } = hydratedTurns;

      return {
        workspaceId,
        conversation,
        session,
        turns,
        messageBlocks,
        toolCalls,
        terminalStreams,
        sessionRelations: this.buildHydratedRelations(thread),
        hasOlder: Boolean(turnsPage.nextCursor),
        hasNewer: Boolean(input.cursor),
        olderCursor: turnsPage.nextCursor ?? undefined,
        newerCursor: turnsPage.backwardsCursor ?? undefined,
        runtimeBinding: {
          providerKind: codexProviderKind,
          providerSessionId: thread.id
        }
      };
    }, input.signal, input.retainExecution);
  }

  private async listAllThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.codexRuntimePort.listThreads({
        cursor,
        archived: false,
        useStateDbOnly: true,
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown"
        ]
      });
      threads.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return threads;
  }

  private async refreshThreadGoal(sessionId: string): Promise<void> {
    await this.codexRuntimePort
      .refreshThreadGoalForSession?.(sessionId)
      .catch(() => undefined);
  }

  private async toDiscoveredSessionRecord(
    thread: Thread
  ): Promise<DiscoveredSessionRecord> {
    const threadUpdatedAt = isoFromUnixSeconds(thread.updatedAt);
    const rolloutModifiedAt = await readCodexRolloutModifiedAt(thread.path);
    return {
      sessionId: discoveredCodexSessionId(thread.id),
      engineId: codexAgentId,
      providerKind: codexProviderKind,
      providerSessionId: thread.id,
      title: titleForThread(thread),
      summaryText: summarizeThread(thread),
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: latestIso(threadUpdatedAt, rolloutModifiedAt) ?? threadUpdatedAt,
      metadata: {
        rolloutPath: thread.path ?? undefined,
        cwd: thread.cwd
      }
    };
  }

  private buildHydratedRelations(
    thread: Thread,
    forkSourceTurnId?: string
  ): SessionRelation[] {
    const relations: SessionRelation[] = [];
    const subagentParentThreadId = toSubagentParentThreadId(thread.source);
    if (subagentParentThreadId) {
      const parentSessionId = discoveredCodexSessionId(subagentParentThreadId);
      const childSessionId = discoveredCodexSessionId(thread.id);
      relations.push(
        parseSessionRelation({
          relationId: buildRelationId(parentSessionId, childSessionId, "subagent"),
          parentSessionId,
          childSessionId,
          relationType: "subagent",
          createdAt: isoFromUnixSeconds(thread.createdAt)
        })
      );
    }
    if (!subagentParentThreadId && thread.forkedFromId) {
      const parentSessionId = discoveredCodexSessionId(thread.forkedFromId);
      const childSessionId = discoveredCodexSessionId(thread.id);
      relations.push(parseSessionRelation({
        relationId: buildRelationId(parentSessionId, childSessionId, "fork"),
        parentSessionId,
        childSessionId,
        relationType: "fork",
        sourceTurnId: forkSourceTurnId,
        createdAt: isoFromUnixSeconds(thread.createdAt)
      }));
    }
    return relations;
  }
}

export class SessionReconciliationService {
  private readonly workspaceRegistry: WorkspaceRegistryService;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly runtimeService: SessionRuntimeService;
  private readonly providersByEngineId: Map<string, SessionDiscoveryProvider>;
  private readonly sessionIdentity: SessionIdentityRegistry;
  private readonly hydrationBySessionId = new Map<
    string,
    SharedHydrationTask<boolean>
  >();
  private readonly fullyHydratedSessionIds = new Set<string>();
  private readonly hydrationGenerationBySessionId = new Map<string, number>();
  private readonly windowHydrationByKey = new Map<
    string,
    SharedHydrationTask<HydratedSessionWindowSnapshot | undefined>
  >();
  private repairQueue: Promise<void> = Promise.resolve();

  public constructor(options: {
    workspaceRegistry: WorkspaceRegistryService;
    sessionIndexStore: SessionIndexStore;
    runtimeService: SessionRuntimeService;
    sessionIdentity?: SessionIdentityRegistry;
    capabilityRegistry?: CapabilityRegistry;
    providers?: SessionDiscoveryProvider[];
  }) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.runtimeService = options.runtimeService;
    this.sessionIdentity =
      options.sessionIdentity ??
      new SessionIdentityRegistry({
        runtimeService: options.runtimeService,
        sessionIndexStore: options.sessionIndexStore
      });
    this.providersByEngineId = new Map(
      (options.providers ?? options.capabilityRegistry?.listSessionDiscoveryProviders() ?? []).map(
        (provider) => [provider.engineId, provider] as const
      )
    );
  }

  public repairWorkspaces(workspaceIds: readonly string[]): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    const normalizedWorkspaceIds = [...new Set(workspaceIds)];
    const repair = this.repairQueue.then(() =>
      this.runWorkspaceRepair(normalizedWorkspaceIds)
    );
    this.repairQueue = repair.then(
      () => undefined,
      () => undefined
    );
    return repair;
  }

  public invalidateSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.hydrationGenerationBySessionId.set(
        sessionId,
        (this.hydrationGenerationBySessionId.get(sessionId) ?? 0) + 1
      );
      this.fullyHydratedSessionIds.delete(sessionId);
    }
  }

  private async runWorkspaceRepair(workspaceIds: readonly string[]): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    await this.workspaceRegistry.ready();
    await this.sessionIndexStore.ready();
    const workspaces = workspaceIds
      .map((workspaceId) => this.workspaceRegistry.getWorkspace(workspaceId))
      .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));

    if (workspaces.length === 0) {
      return {
        workspaces: 0,
        sessions: 0,
        relations: 0
      };
    }

    let sessionCount = 0;
    let relationCount = 0;

    for (const provider of this.providersByEngineId.values()) {
      const discoveredByWorkspaceId = await provider.discoverWorkspaces(workspaces);
      for (const workspace of workspaces) {
        const discovered = discoveredByWorkspaceId.get(workspace.workspaceId);
        if (!discovered) {
          throw new Error(
            `Session discovery provider ${provider.engineId} omitted workspace ${workspace.workspaceId}.`
          );
        }
        const sessionIdAliases = this.buildSessionIdAliases(
          workspace.workspaceId,
          discovered.sessions
        );
        const normalizedSessions = discovered.sessions.map((session) => ({
          ...session,
          sessionId: sessionIdAliases.get(session.sessionId) ?? session.sessionId
        }));
        const normalizedRelations = discovered.relations.map((relation) => ({
          ...relation,
          parentSessionId:
            sessionIdAliases.get(relation.parentSessionId) ?? relation.parentSessionId,
          childSessionId:
            sessionIdAliases.get(relation.childSessionId) ?? relation.childSessionId
        }));
        const conversationIdBySessionId = buildConversationMap(
          normalizedSessions,
          normalizedRelations
        );
        const entries: UpsertSessionIndexInput[] = normalizedSessions.map((session) => ({
          workspaceId: workspace.workspaceId,
          session: {
            sessionId: session.sessionId,
            conversationId:
              conversationIdBySessionId.get(session.sessionId) ??
              discoveredConversationId(session.sessionId),
            engineId: session.engineId,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            archivedAt: session.archivedAt,
            metadata: session.metadata
          },
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId,
          summaryText: session.summaryText,
          lastCompletedTurnAt: session.lastCompletedTurnAt,
          source: "reconciled"
        }));
        const relations: UpsertSessionRelationInput[] = normalizedRelations.map((relation) => ({
          workspaceId: workspace.workspaceId,
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType,
          createdAt: relation.createdAt
        }));

        const result = await this.sessionIndexStore.applyWorkspaceRepair({
          workspaceId: workspace.workspaceId,
          engineId: provider.engineId,
          entries,
          relations
        });
        sessionCount += result.sessionCount;
        relationCount += result.relationCount;
      }
    }

    return {
      workspaces: workspaces.length,
      sessions: sessionCount,
      relations: relationCount
    };
  }

  private buildSessionIdAliases(
    workspaceId: string,
    sessions: DiscoveredSessionRecord[]
  ): Map<string, string> {
    const aliases = new Map<string, string>();

    for (const session of sessions) {
      const existingSessionId = this.sessionIdentity.resolveWorkbenchSessionId(
        {
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId
        },
        workspaceId
      );
      if (existingSessionId) {
        aliases.set(session.sessionId, existingSessionId);
      }
    }

    return aliases;
  }

  public async ensureSessionLoaded(
    sessionId: string,
    input: {
      isCancelled?: () => boolean;
      force?: boolean;
      requireFull?: boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
    } = {}
  ): Promise<boolean> {
    const generation = this.hydrationGenerationBySessionId.get(sessionId) ?? 0;
    const consumer: HydrationConsumer = {
      isCancelled: input.isCancelled,
      signal: input.signal
    };
    const loaded = this.runtimeService
      .listSessions({ includeArchived: true })
      .some((session) => session.sessionId === sessionId);
    if (
      loaded &&
      !input.force &&
      (!input.requireFull || this.fullyHydratedSessionIds.has(sessionId))
    ) {
      const existingHydration = this.hydrationBySessionId.get(sessionId);
      if (!existingHydration) {
        return true;
      }
      existingHydration.consumers.add(consumer);
      const loadedByExisting = await existingHydration.promise;
      if ((this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation &&
          !input.isCancelled?.()) {
        return this.ensureSessionLoaded(sessionId, input);
      }
      return input.isCancelled?.() ? false : loadedByExisting;
    }

    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return false;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider) {
      return false;
    }
    const existingHydration = this.hydrationBySessionId.get(sessionId);
    if (existingHydration) {
      existingHydration.consumers.add(consumer);
      const loadedByExisting = await existingHydration.promise;
      if ((this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation &&
          !input.isCancelled?.()) {
        return this.ensureSessionLoaded(sessionId, input);
      }
      return input.isCancelled?.() ? false : loadedByExisting;
    }
    const consumers = new Set<HydrationConsumer>([consumer]);
    const hydration: SharedHydrationTask<boolean> = {
      consumers,
      promise: this.hydrateSessionEntry(entry, provider, {
        signal: input.signal,
        retainExecution: input.retainExecution,
        isCancelled: () =>
          areAllHydrationConsumersCancelled(consumers) ||
          (this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation
      }).finally(() => {
        this.hydrationBySessionId.delete(sessionId);
      })
    };
    this.hydrationBySessionId.set(sessionId, hydration);
    const loadedByHydration = await hydration.promise;
    if ((this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation &&
        !input.isCancelled?.()) {
      return this.ensureSessionLoaded(sessionId, input);
    }
    return input.isCancelled?.() ? false : loadedByHydration;
  }

  public async ensureSessionExecutable(
    sessionId: string,
    input: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return false;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider?.ensureSessionExecutable) {
      return true;
    }
    return provider.ensureSessionExecutable(entry, input);
  }

  public async hydrateSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
    }
  ): Promise<HydratedSessionWindowSnapshot | undefined> {
    const generation = this.hydrationGenerationBySessionId.get(sessionId) ?? 0;
    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return undefined;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider?.hydrateSessionWindow) {
      return undefined;
    }
    const anchorTurnId = input.cursor ? undefined : input.anchorTurnId;
    const hydrationKey = `${sessionId}\u0000${input.cursor ?? ""}\u0000${
      anchorTurnId ?? ""
    }\u0000${input.limit}`;
    const consumer: HydrationConsumer = {
      isCancelled: input.isCancelled,
      signal: input.signal
    };
    const existingHydration = this.windowHydrationByKey.get(hydrationKey);
    if (existingHydration) {
      existingHydration.consumers.add(consumer);
      const hydrated = await existingHydration.promise;
      if ((this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation &&
          !input.isCancelled?.()) {
        return this.hydrateSessionWindow(sessionId, input);
      }
      return input.isCancelled?.() ? undefined : hydrated;
    }
    const consumers = new Set<HydrationConsumer>([consumer]);
    const hydration: SharedHydrationTask<
      HydratedSessionWindowSnapshot | undefined
    > = {
      consumers,
      promise: provider
        .hydrateSessionWindow(entry, {
          limit: input.limit,
          cursor: input.cursor,
          anchorTurnId,
          signal: input.signal,
          retainExecution: input.retainExecution,
          isCancelled: () =>
            areAllHydrationConsumersCancelled(consumers) ||
            (this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation
        })
        .then(async (hydrated) => {
          if (!hydrated || areAllHydrationConsumersCancelled(consumers) ||
              (this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation) {
            return undefined;
          }
          return this.commitHydratedSession(entry, hydrated, {
            partial: true,
            atLatest: !input.cursor && !anchorTurnId,
            isCancelled: () =>
              areAllHydrationConsumersCancelled(consumers) ||
              (this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation
          });
        })
        .finally(() => this.windowHydrationByKey.delete(hydrationKey))
    };
    this.windowHydrationByKey.set(hydrationKey, hydration);
    const hydrated = await hydration.promise;
    if ((this.hydrationGenerationBySessionId.get(sessionId) ?? 0) !== generation &&
        !input.isCancelled?.()) {
      return this.hydrateSessionWindow(sessionId, input);
    }
    if (!hydrated || input.isCancelled?.()) {
      return undefined;
    }
    return hydrated;
  }

  private async hydrateSessionEntry(
    entry: SessionIndexEntry,
    provider: SessionDiscoveryProvider,
    input: {
      isCancelled?: () => boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
    } = {}
  ): Promise<boolean> {
    let hydrated: HydratedSessionSnapshot | undefined;
    try {
      const historySources: { entry: SessionIndexEntry; sourceTurnIds: string[] }[] = [];
      if (entry.archivedAt) {
        const forks = this.sessionIndexStore.listRelations(entry.workspaceId)
          .filter((relation) => relation.relationType === "fork");
        const visit = (parentSessionId: string, sourceTurnIds: string[] = []): void => {
          for (const fork of forks.filter((relation) => relation.parentSessionId === parentSessionId)) {
            const child = this.sessionIndexStore.getEntry(fork.childSessionId);
            if (!child || !fork.sourceTurnId) continue;
            const boundaries = [...sourceTurnIds, fork.sourceTurnId];
            if (child.archivedAt) visit(child.sessionId, boundaries);
            else historySources.push({ entry: child, sourceTurnIds: boundaries });
          }
        };
        visit(entry.sessionId);
      }
      hydrated = await provider.hydrateSession(entry, {
        isCancelled: input.isCancelled,
        signal: input.signal,
        retainExecution: input.retainExecution,
        historySources: entry.archivedAt ? historySources : undefined
      });
    } catch (error) {
      if (entry.providerKind !== codexProviderKind || !entry.providerSessionId ||
          !(error instanceof Error) || !error.message.includes(`session ${entry.providerSessionId} is archived.`)) {
        throw error;
      }
      await this.sessionIndexStore.archiveSessions([entry.sessionId]);
      return false;
    }
    if (!hydrated || input.isCancelled?.()) {
      return false;
    }
    return Boolean(await this.commitHydratedSession(entry, hydrated, input));
  }

  private async commitHydratedSession<T extends HydratedSessionSnapshot>(
    entry: SessionIndexEntry,
    hydrated: T,
    input: { partial?: boolean; atLatest?: boolean; isCancelled?: () => boolean } = {}
  ): Promise<T | undefined> {
    const indexRelations = this.sessionIndexStore.listRelations(entry.workspaceId);
    const relatedIndexRelations = indexRelations.filter(
      (relation) =>
        relation.parentSessionId === entry.sessionId ||
        relation.childSessionId === entry.sessionId
    );
    const hydratedForkSourceTurnId = hydrated.sessionRelations.find(
      (relation) =>
        relation.relationType === "fork" &&
        this.normalizeProviderSessionId(relation.childSessionId, entry) === entry.sessionId
    )?.sourceTurnId;
    let normalizedHydrated = this.normalizeHydratedRelations(
      entry,
      hydrated,
      relatedIndexRelations
    );
    const forkByChild = new Map(
      [...normalizedHydrated.sessionRelations, ...indexRelations]
        .filter((relation) => relation.relationType === "fork")
        .map((relation) => [relation.childSessionId, relation] as const)
    );
    const fork = forkByChild.get(entry.sessionId);
    const knownForkSourceTurnId = fork?.sourceTurnId ?? hydratedForkSourceTurnId;
    const ancestorSessionIds = new Set<string>();
    for (
      let ancestor = fork;
      ancestor;
      ancestor = forkByChild.get(ancestor.parentSessionId)
    ) {
      ancestorSessionIds.add(ancestor.parentSessionId);
    }
    for (const ancestorSessionId of [...ancestorSessionIds].reverse()) {
      await this.ensureSessionLoaded(ancestorSessionId, {
        requireFull: true,
        isCancelled: input.isCancelled
      });
    }
    if (input.isCancelled?.()) {
      return undefined;
    }
    if (fork) {
      const inheritedTurnIds = new Set(
        this.runtimeService.getSnapshot().turns
          .filter((turn) => ancestorSessionIds.has(turn.sessionId))
          .map((turn) => turn.turnId)
      );
      const forkPointIndex = knownForkSourceTurnId
        ? normalizedHydrated.turns.findIndex((turn) => turn.turnId === knownForkSourceTurnId)
        : -1;
      if (forkPointIndex >= 0) {
        const inheritedTurns = input.partial
          ? normalizedHydrated.turns.slice(forkPointIndex)
          : normalizedHydrated.turns.slice(0, forkPointIndex + 1);
        for (const turn of inheritedTurns) inheritedTurnIds.add(turn.turnId);
      }
      const sharedTurns = hydrated.turns.filter((turn) => inheritedTurnIds.has(turn.turnId));
      // A newest-first window can identify the fork point only on its latest page.
      const includesLatest = !input.partial || input.atLatest;
      const sourceTurnId = knownForkSourceTurnId ??
        (input.partial ? sharedTurns[0]?.turnId : sharedTurns.at(-1)?.turnId);
      if (!fork.sourceTurnId && includesLatest && sourceTurnId) {
        const repaired = await this.sessionIndexStore.upsertRelation({
          workspaceId: entry.workspaceId,
          parentSessionId: fork.parentSessionId,
          childSessionId: fork.childSessionId,
          relationType: "fork",
          sourceTurnId,
          createdAt: fork.createdAt
        });
        const relationIndex = relatedIndexRelations.findIndex(
          (relation) => relation.childSessionId === entry.sessionId
        );
        if (relationIndex >= 0) {
          relatedIndexRelations[relationIndex] = repaired;
        } else {
          relatedIndexRelations.push(repaired);
          normalizedHydrated = this.normalizeHydratedRelations(
            entry,
            normalizedHydrated,
            relatedIndexRelations
          );
        }
      }
      const isOwn = (entity: { turnId: string }): boolean => !inheritedTurnIds.has(entity.turnId);
      normalizedHydrated = {
        ...normalizedHydrated,
        turns: normalizedHydrated.turns.filter(isOwn),
        messageBlocks: normalizedHydrated.messageBlocks.filter(isOwn),
        toolCalls: normalizedHydrated.toolCalls.filter(isOwn),
        terminalStreams: normalizedHydrated.terminalStreams.filter(isOwn)
      };
    }
    const currentSession = this.runtimeService.getSession(entry.sessionId);
    const replaceSessionHistory =
      !input.partial &&
      !isActiveSessionStatus(currentSession?.status ?? "idle");
    const committedHydrated = replaceSessionHistory
      ? normalizedHydrated
      : this.preserveLiveRuntimeState(normalizedHydrated);
    this.runtimeService.hydrateDiscoveredSession(committedHydrated, {
      relatedIndexRelations,
      replaceSessionHistory
    });
    await this.upsertHydratedSession(entry, committedHydrated, input);
    if (!input.partial) {
      this.fullyHydratedSessionIds.add(entry.sessionId);
    }
    return committedHydrated;
  }

  private preserveLiveRuntimeState<T extends HydratedSessionSnapshot>(hydrated: T): T {
    const current = this.runtimeService.getSnapshot();
    const currentSession = current.sessions.find(
      (session) => session.sessionId === hydrated.session.sessionId
    );
    const currentTurns = new Map(
      current.turns
        .filter((turn) => turn.sessionId === hydrated.session.sessionId)
        .map((turn) => [turn.turnId, turn] as const)
    );
    const turns = hydrated.turns.map((turn) => {
      const currentTurn = currentTurns.get(turn.turnId);
      if (!currentTurn || (
        currentTurn.status !== "completed" &&
        !isActiveSessionStatus(currentSession?.status ?? "idle")
      )) {
        return turn;
      }
      return {
        ...turn,
        status: currentTurn.status,
        finishReason: currentTurn.finishReason ?? turn.finishReason,
        completedAt: currentTurn.completedAt ?? turn.completedAt,
        actor: currentTurn.actor ?? turn.actor,
        finalMessageId: currentTurn.finalMessageId ?? turn.finalMessageId,
        executionProfile: currentTurn.executionProfile ?? turn.executionProfile,
        messageIds: mergeTurnIds(turn.messageIds, currentTurn.messageIds),
        toolCallIds: mergeTurnIds(turn.toolCallIds, currentTurn.toolCallIds),
        terminalIds: mergeTurnIds(turn.terminalIds, currentTurn.terminalIds),
        approvalRequestIds: mergeTurnIds(
          turn.approvalRequestIds,
          currentTurn.approvalRequestIds
        ),
        interactionRequestIds: mergeTurnIds(
          turn.interactionRequestIds ?? [],
          currentTurn.interactionRequestIds ?? []
        )
      };
    });
    const session = currentSession &&
      isActiveSessionStatus(currentSession.status)
      ? {
          ...hydrated.session,
          status: currentSession.status,
          lastTurnId: currentSession.lastTurnId ?? hydrated.session.lastTurnId
        }
      : hydrated.session;
    return { ...hydrated, session, turns };
  }

  private normalizeHydratedRelations<
    T extends HydratedSessionSnapshot | HydratedSessionWindowSnapshot
  >(
    entry: SessionIndexEntry,
    hydrated: T,
    relatedIndexRelations: SessionRelationIndex[]
  ): T {
    const indexOwnedChildSessionIds = new Set(
      relatedIndexRelations.map((relation) => relation.childSessionId)
    );
    const normalizedRelations = hydrated.sessionRelations
      .map((relation) => {
        const parentSessionId = this.normalizeProviderSessionId(
          relation.parentSessionId,
          entry
        );
        const childSessionId = this.normalizeProviderSessionId(
          relation.childSessionId,
          entry
        );
        return parseSessionRelation({
          ...relation,
          relationId: buildRelationId(
            parentSessionId,
            childSessionId,
            relation.relationType
          ),
          parentSessionId,
          childSessionId
        });
      })
      .filter(
        (relation) =>
          !indexOwnedChildSessionIds.has(relation.childSessionId)
      );
    return {
      ...hydrated,
      sessionRelations: normalizedRelations
    };
  }

  private normalizeProviderSessionId(
    sessionId: string,
    entry: SessionIndexEntry
  ): string {
    if (!entry.providerKind) {
      return sessionId;
    }
    const prefix = `${entry.providerKind}:`;
    if (!sessionId.startsWith(prefix)) {
      return sessionId;
    }
    const providerSessionId = sessionId.slice(prefix.length);
    return (
      this.sessionIdentity.resolveWorkbenchSessionId(
        {
          providerKind: entry.providerKind,
          providerSessionId
        },
        entry.workspaceId
      ) ?? sessionId
    );
  }

  private async upsertHydratedSession(
    entry: SessionIndexEntry,
    hydrated: HydratedSessionSnapshot,
    input: {
      partial?: boolean;
    } = {}
  ): Promise<void> {
    const hydratedLastCompletedTurnAt = resolveHydratedLastCompletedTurnAt(hydrated.turns);
    const hydratedLastUserMessageAt = resolveHydratedLastUserMessageAt(hydrated.messageBlocks);
    await this.sessionIndexStore.upsertSession({
      workspaceId: hydrated.workspaceId,
      session: hydrated.session,
      providerKind: hydrated.runtimeBinding?.providerKind ?? entry.providerKind,
      providerSessionId:
        hydrated.runtimeBinding?.providerSessionId ?? entry.providerSessionId,
      summaryText: entry.summaryText,
      lastCompletedTurnAt: input.partial
        ? latestIso(entry.lastCompletedTurnAt, hydratedLastCompletedTurnAt)
        : hydratedLastCompletedTurnAt,
      lastUserMessageAt: latestIso(entry.lastUserMessageAt, hydratedLastUserMessageAt),
      unreadState: entry.unreadState,
      source: entry.source
    });
  }
}

export const buildConversationMap = (
  sessions: DiscoveredSessionRecord[],
  relations: DiscoveredSessionRelation[]
): Map<string, string> => {
  const parentByChildId = new Map<string, string>();
  for (const relation of relations) {
    if (!parentByChildId.has(relation.childSessionId)) {
      parentByChildId.set(relation.childSessionId, relation.parentSessionId);
    }
  }

  const conversationIdBySessionId = new Map<string, string>();
  const resolveRoot = (sessionId: string): string => {
    const seen = new Set<string>();
    let current = sessionId;
    while (parentByChildId.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentByChildId.get(current) ?? current;
    }
    return current;
  };

  for (const session of sessions) {
    const rootSessionId = resolveRoot(session.sessionId);
    conversationIdBySessionId.set(
      session.sessionId,
      discoveredConversationId(rootSessionId)
    );
  }
  return conversationIdBySessionId;
};
