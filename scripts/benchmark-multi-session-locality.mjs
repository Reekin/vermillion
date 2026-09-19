import { performance } from "node:perf_hooks";
import { DomainStore } from "../packages/core/dist/index.js";

// Run after building @vermillion/core: pnpm exec tsx scripts/benchmark-multi-session-locality.mjs

const now = "2026-09-20T00:00:00.000Z";
const counts = [1, 10, 30, 50];

const sessionSnapshot = (sessionIndex, turnCount = 100) => {
  const sessionId = `session-${sessionIndex}`;
  const conversationId = `conversation-${sessionIndex}`;
  const turns = [];
  const messageBlocks = [];
  const toolCalls = [];
  const terminalStreams = [];
  const runtimeInteractions = [];
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    const turnId = `${sessionId}:turn-${turnIndex}`;
    const messageIds = [`${turnId}:user`, `${turnId}:assistant`];
    const toolCallId = `${turnId}:tool`;
    const terminalId = `${turnId}:terminal`;
    const requestId = `${turnId}:interaction`;
    turns.push({
      turnId,
      sessionId,
      status: "completed",
      finishReason: "completed",
      startedAt: now,
      completedAt: now,
      messageIds,
      toolCallIds: [toolCallId],
      terminalIds: [terminalId],
      approvalRequestIds: [],
      interactionRequestIds: [requestId]
    });
    for (const [messageIndex, messageId] of messageIds.entries()) {
      messageBlocks.push({
        blockId: `${messageId}:block`,
        messageId,
        sessionId,
        turnId,
        role: messageIndex === 0 ? "user" : "assistant",
        kind: "markdown",
        text: `message ${turnIndex}:${messageIndex}`,
        startedAt: now,
        completedAt: now
      });
    }
    toolCalls.push({
      toolCallId,
      sessionId,
      turnId,
      toolName: "benchmark",
      status: "completed",
      startedAt: now,
      completedAt: now
    });
    terminalStreams.push({
      terminalId,
      sessionId,
      turnId,
      toolCallId,
      status: "completed",
      outputText: "output",
      exitCode: 0,
      startedAt: now,
      completedAt: now
    });
    runtimeInteractions.push({
      requestId,
      sessionId,
      turnId,
      interactionKind: "tool_user_input",
      status: "submitted",
      title: "benchmark",
      payload: {},
      response: {},
      requestedAt: now,
      resolvedAt: now
    });
  }
  return {
    conversations: [{
      conversationId,
      participantEngineIds: ["codex"],
      sessionIds: [sessionId],
      createdAt: now,
      updatedAt: now
    }],
    sessions: [{
      sessionId,
      conversationId,
      engineId: "codex",
      status: "completed",
      createdAt: now,
      updatedAt: now
    }],
    turns,
    messageBlocks,
    toolCalls,
    terminalStreams,
    approvalRequests: [],
    runtimeInteractions,
    participants: [],
    threadGoals: [],
    sessionRelations: []
  };
};

const combine = (snapshots) => Object.fromEntries(
  Object.keys(snapshots[0]).map((key) => [key, snapshots.flatMap((snapshot) => snapshot[key])])
);

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const measure = (operation) => {
  const samples = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(performance.now() - startedAt);
  }
  return Number(median(samples).toFixed(2));
};

const results = [];
for (const count of counts) {
  const snapshots = Array.from({ length: count }, (_, index) => sessionSnapshot(index));
  const store = new DomainStore({ snapshot: combine(snapshots) });
  const target = snapshots[0];
  const window = {
    ...target,
    turns: target.turns.slice(-10),
    messageBlocks: target.messageBlocks.slice(-20),
    toolCalls: target.toolCalls.slice(-10),
    terminalStreams: target.terminalStreams.slice(-10),
    runtimeInteractions: target.runtimeInteractions.slice(-10)
  };
  results.push({
    loadedSessions: count,
    mergeMs: measure(() => store.mergeSnapshot(target, { scope: { sessionId: "session-0" } })),
    windowReplaceMs: measure(() => store.replaceSessionWindowSnapshot("session-0", window)),
    historyReplaceMs: measure(() => store.replaceSessionHistorySnapshot("session-0", target))
  });
  if (store.listTurns({ sessionId: "session-0" }).length !== 100) {
    throw new Error(`Target history was corrupted at ${count} loaded sessions.`);
  }
  if (count > 1 && store.listTurns({ sessionId: `session-${count - 1}` }).length !== 100) {
    throw new Error(`Unrelated history was changed at ${count} loaded sessions.`);
  }
}

console.table(results);
