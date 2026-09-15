import type {
  ChatSession,
  MessageBlock,
  SessionRelation,
  SessionStatus,
  TerminalStream,
  ToolCall
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
import { pathToFileURL } from "node:url";
import type { Thread } from "../../codex-app-server-generated/v2/Thread.js";
import type { CodexErrorInfo } from "../../codex-app-server-generated/v2/CodexErrorInfo.js";
import type { FileUpdateChange } from "../../codex-app-server-generated/v2/FileUpdateChange.js";
import type { ThreadItem } from "../../codex-app-server-generated/v2/ThreadItem.js";
import type { SessionSource } from "../../codex-app-server-generated/v2/SessionSource.js";
import type { UserInput } from "../../codex-app-server-generated/v2/UserInput.js";
import { engineItemKey, sessionItemId } from "../../session-item-id.js";
import type { CodexAppServerRuntimePort } from "./runtime-port.js";
import type {
  SessionIndexEntry,
  SessionRelationIndex,
  UpsertSessionIndexInput,
  UpsertSessionRelationInput
} from "../../session-index.js";
import type { WorkspaceRecord, WorkspaceRegistryService } from "../../workspace-registry.js";
import type { SessionRuntimeService } from "../../runtime-service.js";
import { CapabilityRegistry } from "../../capability-registry.js";
import { SessionIdentityRegistry } from "../../session-identity-registry.js";
import {
  buildRelationId,
  latestIso,
  type DiscoveredSessionRecord,
  type DiscoveredSessionRelation,
  type DiscoveredWorkspaceResult,
  type HydratedSessionSnapshot,
  type HydratedSessionWindowSnapshot,
  type HydratedTurn,
  type SessionDiscoveryProvider
} from "../../session-discovery.js";
import { codexProviderKind, discoveredCodexSessionId } from "./session-identity.js";
import {
  CodexTurnChangesStore,
  getRecordedCodexTurnChanges,
  recordCodexTurnChangesFromFileUpdate
} from "./extensions/turn-changes-store.js";
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
} from "./extensions/process-activity.js";
import {
  consumeCodexRolloutTimestampForItem,
  type CodexRolloutTimestampGroup,
  readCodexRolloutModifiedAt,
  readCodexRolloutTimestampGroups,
  resolveCodexThreadItemTimestamp
} from "./extensions/rollout-timestamps.js";

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
  signal?: AbortSignal;
}): Promise<HydratedCodexTurnEntities | undefined> => {
  const { entry, thread, rolloutPath, turnChangesStore, signal } = input;
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
    if (signal?.aborted) {
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
      if (signal?.aborted) {
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

  public isSessionArchivedError(entry: SessionIndexEntry, error: unknown): boolean {
    return Boolean(entry.providerSessionId) && error instanceof Error &&
      error.message.includes(`session ${entry.providerSessionId} is archived.`);
  }

  public async hydrateSession(
    entry: SessionIndexEntry,
    input: {
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
      if (input.signal?.aborted) {
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
        signal: input.signal
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
      if (input.signal?.aborted) {
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
      if (input.signal?.aborted) {
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
        signal: input.signal
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
