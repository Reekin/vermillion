import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction
} from "react";
import type {
  AgentParticipant,
  ApprovalRequest,
  Attachment,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  RuntimeInteraction,
  SessionSettingsRpc,
  Turn,
  SessionWindowRpc
} from "@vermillion/shared";
import {
  resolveEngineExecutionPreference,
  writeEngineExecutionPreference
} from "@vermillion/shared";
import "xterm/css/xterm.css";
import type { RendererStore } from "../../store/store.js";
import type {
  DesktopTransport,
  EventBacklogPressure
} from "../../transport/desktop-transport.js";
import { connectDesktopTransportToStore } from "../../transport/store-bridge.js";
import { renderTurnExtensions } from "../../features/engine-extensions/turn-extension-registry.js";
import { ImageLightbox, type ImageLightboxState } from "./ImageLightbox.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";
import {
  resolveProcessExpanded,
  toggleProcessVisibility,
  type ProcessVisibilityOverride
} from "./process-visibility.js";
import { TurnProcessPanel } from "./TurnProcessPanel.js";
import { buildParticipantDirectory } from "./participant-directory.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";
import {
  filterComposerTurnsForChatTree,
  filterTranscriptRowsForChatTree
} from "./chat-tree-transcript.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import {
  useRendererConversationRevision,
  useRendererSessionsRevision,
  useRendererStoreState
} from "./use-renderer-store-state.js";
import { useTranscriptViewportController } from "./use-transcript-viewport-controller.js";
import { useChatTreeController } from "./use-chat-tree-controller.js";
import { ChatTreePanel } from "./ChatTreePanel.js";
import { GitBranch } from "lucide-react";
import { useRendererDiagnostics } from "./use-renderer-diagnostics.js";
import { ComposerContainer } from "./composer/ComposerContainer.js";
import type { ComposerExecutionSelection } from "./composer/composer-types.js";
import "./chat-shell.css";

const CHAT_TREE_VISIBLE_KEY = "vermillion.chatTreeVisible";

/** True only once `value` has stayed true for `delayMs`; falls back to false immediately. */
const useDelayedFlag = (value: boolean, delayMs: number): boolean => {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value && delayed;
};

const autoRefreshBacklogCooldownMs = 30_000;
const autoRefreshBacklogStreamThreshold = 500;

export type SessionPaneProps = {
  store: RendererStore;
  transport: DesktopTransport;
  /** Tree entry to display; undefined renders the draft state (no session yet). */
  sessionId: string | undefined;
  /** Incrementing this re-hydrates the displayed session from the provider (after resume). */
  reloadSignal?: number;
  /** Creates the session for the first message in draft state. Returns the new sessionId. */
  createSession: (input: { content: string; attachments: Attachment[] }) => Promise<string>;
  /** Rendered inside the composer turn-configuration group, before the model picker. */
  composerExtras?: ReactNode;
};

type TranscriptPaneProps = {
  transcriptRef: RefObject<HTMLElement | null>;
  transcriptContentRef: RefObject<HTMLDivElement | null>;
  renderedTranscriptRows: ReturnType<typeof buildTurnTranscriptRows>;
  participantDirectory: ReturnType<typeof buildParticipantDirectory>;
  transport: DesktopTransport;
  engineId?: string;
  engineSurface?: EngineSurfaceRpc;
  engineExtensionRefreshSignal: number;
  sessionCwd?: string;
  activeSessionWindow?: Omit<SessionWindowRpc, "snapshot">;
  activeSessionId?: string;
  isOpeningSelectedSession: boolean;
  /** A session switch is in flight; hold the empty state so it doesn't flash before content arrives. */
  isSwitchPending: boolean;
  loadingOlderTurns: boolean;
  onLoadOlder: () => void;
  processVisibilityByTurnId: Readonly<Record<string, ProcessVisibilityOverride>>;
  onToggleProcess: (turnId: string, defaultExpanded: boolean) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
    decision?: string | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  onRespondInteraction?: (input: {
    sessionId: string;
    requestId: string;
    action: "accept" | "decline" | "cancel" | "submit" | "defer";
    response?: Record<string, unknown>;
    content?: unknown;
    answers?: Record<string, string[]>;
  }) => Promise<void>;
};

type TranscriptRow = ReturnType<typeof buildTurnTranscriptRows>[number];
type RenderedTurnGroup = {
  visibleRow: TranscriptRow;
  hiddenRows: TranscriptRow[];
};

const emptyTurns: Turn[] = [];
const emptyParticipants: AgentParticipant[] = [];
const toComposerExecution = (
  profile: ReturnType<typeof resolveEngineExecutionPreference>
): ComposerExecutionSelection | undefined =>
  profile?.modelId
    ? {
        modelId: profile.modelId,
        reasoningOptionId: profile.reasoningOptionId,
        serviceTierId: profile.serviceTierId
      }
    : undefined;

const formatTimestamp = (iso: string | undefined): string => {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
};

const maxSessionHeadingLength = 20;

export const truncateSessionHeading = (value: string | undefined): string => {
  const normalized = value?.trim();
  if (!normalized) {
    return "Thread";
  }
  if (normalized.length <= maxSessionHeadingLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxSessionHeadingLength)}…`;
};

export const formatRelativeCompletedTurnAge = (
  iso: string | undefined,
  nowMs = Date.now()
): string | undefined => {
  if (!iso) {
    return undefined;
  }
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - timestamp) / 60_000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }
  return `${Math.floor(elapsedHours / 24)}d`;
};


const summarizeProcessToggle = (input: {
  hiddenMessageCount?: number;
  toolCount: number;
  terminalCount: number;
  approvalCount: number;
}): string => {
  const parts: string[] = [];
  if (input.hiddenMessageCount && input.hiddenMessageCount > 0) {
    parts.push(
      `${input.hiddenMessageCount} earlier message${
        input.hiddenMessageCount === 1 ? "" : "s"
      }`
    );
  }
  if (input.toolCount > 0) {
    parts.push(`${input.toolCount} tool${input.toolCount === 1 ? "" : "s"}`);
  }
  if (input.terminalCount > 0) {
    parts.push(
      `${input.terminalCount} terminal${input.terminalCount === 1 ? "" : "s"}`
    );
  }
  if (input.approvalCount > 0) {
    parts.push(
      `${input.approvalCount} approval${input.approvalCount === 1 ? "" : "s"}`
    );
  }
  return parts.join(" · ");
};

const countHiddenMessages = (rows: TranscriptRow[]): number => {
  const messageIds = new Set<string>();
  for (const row of rows) {
    for (const block of row.blocks) {
      messageIds.add(block.messageId);
    }
  }
  return messageIds.size;
};

const buildTranscriptContentVersion = (rows: TranscriptRow[]): string =>
  rows
    .map((row) =>
      [
        row.rowId,
        row.turn.status,
        row.turn.completedAt ?? "",
        row.blocks
          .map(
            (block) =>
              `${block.blockId}:${block.kind}:${block.text?.length ?? 0}:${
                block.startedAt ?? ""
              }`
          )
          .join(","),
        row.toolCalls
          .map(
            (toolCall) =>
              `${toolCall.toolCallId}:${toolCall.status}:${
                toolCall.inputSummary?.length ?? 0
              }:${toolCall.outputSummary?.length ?? 0}`
          )
          .join(","),
        row.terminalStreams
          .map(
            (stream) =>
              `${stream.terminalId}:${stream.status}:${stream.outputText.length}:${
                stream.exitCode ?? ""
              }`
          )
          .join(","),
        row.approvals
          .map((approval) => `${approval.requestId}:${approval.status}`)
          .join(",")
      ].join("|")
    )
    .join("||");

const buildRenderedTurnGroups = (
  rows: ReturnType<typeof buildTurnTranscriptRows>
): RenderedTurnGroup[] => {
  const groups: RenderedTurnGroup[] = [];

  for (let index = 0; index < rows.length; ) {
    const turnId = rows[index]!.turn.turnId;
    const turnRows: TranscriptRow[] = [];
    while (index < rows.length && rows[index]!.turn.turnId === turnId) {
      turnRows.push(rows[index]!);
      index += 1;
    }

    const turn = turnRows[0]!.turn;
    if (turn.status !== "completed") {
      groups.push(
        ...turnRows.map((row) => ({
          visibleRow: row,
          hiddenRows: []
        }))
      );
      continue;
    }

    const visibleRow =
      turnRows.find((row) => row.isFinalResponseRow) ??
      turnRows.find((row) => row.canDisplayAsFinalResponse) ??
      turnRows.at(-1) ??
      turnRows[0]!;
    const hiddenRows = turnRows.filter(
      (row) => row.rowId !== visibleRow.rowId && row.messageRole !== "user"
    );

    for (const row of turnRows) {
      if (row.rowId === visibleRow.rowId) {
        groups.push({
          visibleRow,
          hiddenRows
        });
        continue;
      }
      if (row.messageRole === "user") {
        groups.push({
          visibleRow: row,
          hiddenRows: []
        });
      }
    }
  }

  return groups;
};

const resolveProcessOutputToggleLabel = (expanded: boolean): string =>
  expanded ? "Hide process output" : "Show process output";

const formatPreviousMessagesLabel = (count: number): string =>
  `${count} previous message${count === 1 ? "" : "s"} >`;

const TranscriptPane = memo(
  ({
    transcriptRef,
    transcriptContentRef,
    renderedTranscriptRows,
    participantDirectory,
    transport,
    engineId,
    engineSurface,
    engineExtensionRefreshSignal,
    sessionCwd,
    activeSessionWindow,
    activeSessionId,
    isOpeningSelectedSession,
    isSwitchPending,
    loadingOlderTurns,
    onLoadOlder,
    processVisibilityByTurnId,
    onToggleProcess,
    onPreviewImage,
    onRespondApproval,
    onRespondInteraction
  }: TranscriptPaneProps): ReactElement => (
    <section
      className="awb-transcript"
      ref={transcriptRef}
      role="region"
      aria-label="Transcript"
      tabIndex={0}
    >
      <div className="awb-transcript__content" ref={transcriptContentRef}>
        {renderedTranscriptRows.length === 0 && (isOpeningSelectedSession || !isSwitchPending) && (
          <div className="awb-transcript__empty">
            {isOpeningSelectedSession && <div className="awb-loading-spinner" aria-hidden="true" />}
            <h3>
              {isOpeningSelectedSession
                ? "Loading thread"
                : activeSessionId
                  ? "Empty thread"
                  : "新会话"}
            </h3>
            <p>
              {isOpeningSelectedSession
                ? "Loading conversation history for the selected session."
                : activeSessionId
                  ? "Send a message to start the next turn in this session."
                  : "发送第一条消息开始会话。"}
            </p>
          </div>
        )}

        {activeSessionWindow?.hasOlder && renderedTranscriptRows.length > 0 && (
          <div className="awb-transcript__load-earlier">
            <button
              type="button"
              className="awb-transcript__load-earlier-button"
              onClick={onLoadOlder}
              disabled={loadingOlderTurns || isOpeningSelectedSession}
            >
              {loadingOlderTurns ? "Loading earlier…" : "Load earlier"}
            </button>
          </div>
        )}

        {buildRenderedTurnGroups(renderedTranscriptRows).map(({ visibleRow, hiddenRows }, index, groups) => {
          const isUserTurn = visibleRow.messageRole === "user";
          const isInlineProcessRow =
            visibleRow.rowKind === "process" && visibleRow.turn.status !== "completed";
          const nextGroup = groups[index + 1];
          const isFollowedBySameTurn =
            nextGroup?.visibleRow.turn.turnId === visibleRow.turn.turnId;
          const hiddenMessageCount = countHiddenMessages(hiddenRows);
          const hasCollapsedContent = hiddenRows.length > 0;
          const hasExpandableDetails =
            !isUserTurn &&
            !isInlineProcessRow &&
            (visibleRow.hasProcessDetails || hasCollapsedContent);
          const defaultExpanded = hasCollapsedContent
            ? false
            : visibleRow.defaultProcessExpanded;
          const isProcessExpanded =
            hasExpandableDetails &&
            resolveProcessExpanded(
              defaultExpanded,
              processVisibilityByTurnId[visibleRow.turn.turnId]
            );
          const processSummary = summarizeProcessToggle({
            hiddenMessageCount,
            toolCount: visibleRow.toolCalls.length,
            terminalCount: visibleRow.terminalStreams.length,
            approvalCount: visibleRow.approvals.length
          });
          const processToggleLabel = resolveProcessOutputToggleLabel(isProcessExpanded);
          const previousMessagesLabel = formatPreviousMessagesLabel(hiddenMessageCount);
          const isFinalDisplayedAssistantRow =
            !isUserTurn && visibleRow.turn.status === "completed" && !isInlineProcessRow;
          const shouldShowTimestamp = isUserTurn || isFinalDisplayedAssistantRow;
          const shouldRenderExtensions = isFinalDisplayedAssistantRow;
          return (
            <article
              key={visibleRow.rowId}
              data-turn-id={visibleRow.turn.turnId}
              data-final-response-row={visibleRow.isFinalResponseRow ? "true" : "false"}
              className={`awb-chat-entry ${isUserTurn ? "is-user" : "is-assistant"} ${
                isFollowedBySameTurn ? "is-followed-by-same-turn" : ""
              }`}
            >
              {shouldShowTimestamp && (
                <header className="awb-chat-entry__identity">
                  <time className="awb-chat-entry__timestamp">
                    {formatTimestamp(
                      visibleRow.startedAt ??
                        visibleRow.turn.completedAt ??
                        visibleRow.turn.startedAt
                    )}
                  </time>
                </header>
              )}
              {hasExpandableDetails && (
                <div
                  className={`awb-turn__process ${
                    hasCollapsedContent ? "awb-turn__process--history" : ""
                  }`}
                >
                  <button
                    type="button"
                    className={`awb-turn__process-toggle ${
                      hasCollapsedContent ? "is-history-divider" : ""
                    }`}
                    onClick={() => onToggleProcess(visibleRow.turn.turnId, defaultExpanded)}
                    aria-expanded={isProcessExpanded}
                  >
                    {hasCollapsedContent ? (
                      <>
                        <span aria-hidden="true" />
                        <span>{previousMessagesLabel}</span>
                        <span aria-hidden="true" />
                      </>
                    ) : (
                      <>
                        <span>{processToggleLabel}</span>
                        <span>{processSummary}</span>
                      </>
                    )}
                  </button>
                  {isProcessExpanded && (
                    <TurnProcessPanel
                      row={visibleRow}
                      hiddenRows={hiddenRows}
                      participantDirectory={participantDirectory}
                      onPreviewImage={onPreviewImage}
                      onRespondApproval={onRespondApproval}
                      onRespondInteraction={onRespondInteraction}
                    />
                  )}
                </div>
              )}
              {isInlineProcessRow && (
                <div className="awb-turn__process awb-turn__process--inline">
                  <TurnProcessPanel
                    row={visibleRow}
                    hiddenRows={[]}
                    participantDirectory={participantDirectory}
                    onPreviewImage={onPreviewImage}
                    onRespondApproval={onRespondApproval}
                    onRespondInteraction={onRespondInteraction}
                  />
                </div>
              )}
              {!isInlineProcessRow && (
                <div className="awb-chat-entry__messages">
                  {visibleRow.blocks.length === 0 && (
                    <p className="awb-turn__empty">
                      {isUserTurn ? "No message content." : "Waiting for response…"}
                    </p>
                  )}
                  {visibleRow.blocks.map((block, blockIndex) => (
                    <MessageMarkdownView
                      key={block.blockId}
                      block={block}
                      copyBlocks={
                        blockIndex === visibleRow.blocks.length - 1
                          ? visibleRow.blocks
                          : undefined
                      }
                      onPreviewImage={onPreviewImage}
                    />
                  ))}
                </div>
              )}
              {shouldRenderExtensions
                ? renderTurnExtensions({
                    transport,
                    engineId,
                    engineSurface,
                    sessionId: visibleRow.turn.sessionId,
                    turnId: visibleRow.turn.turnId,
                    cwd: sessionCwd,
                    refreshSignal: engineExtensionRefreshSignal
                  })
                : null}
            </article>
          );
        })}
      </div>
    </section>
  ),
  (previous, next) =>
    previous.renderedTranscriptRows === next.renderedTranscriptRows &&
    previous.participantDirectory === next.participantDirectory &&
    previous.transport === next.transport &&
    previous.engineId === next.engineId &&
    previous.engineSurface === next.engineSurface &&
    previous.engineExtensionRefreshSignal === next.engineExtensionRefreshSignal &&
    previous.sessionCwd === next.sessionCwd &&
    previous.activeSessionWindow === next.activeSessionWindow &&
    previous.activeSessionId === next.activeSessionId &&
    previous.isOpeningSelectedSession === next.isOpeningSelectedSession &&
    previous.isSwitchPending === next.isSwitchPending &&
    previous.loadingOlderTurns === next.loadingOlderTurns &&
    previous.processVisibilityByTurnId === next.processVisibilityByTurnId &&
    previous.transcriptRef === next.transcriptRef &&
    previous.transcriptContentRef === next.transcriptContentRef &&
    previous.onPreviewImage === next.onPreviewImage
);

export const SessionPane = ({
  store,
  transport,
  sessionId,
  reloadSignal,
  createSession,
  composerExtras
}: SessionPaneProps): ReactElement => {
  const state = useRendererStoreState(store);
  const [availableEngines, setAvailableEngines] = useState<EngineDefinitionRpc[]>([]);
  const [engineSurfacesById, setEngineSurfacesById] = useState<
    Record<string, EngineSurfaceRpc | undefined>
  >({});
  const [selectedEngineId, setSelectedEngineId] = useState<string>("");
  const [allowedModelIdsByEngineId, setAllowedModelIdsByEngineId] = useState<
    Record<string, string[]>
  >({});
  const [customModelReasoningOptionIdsByEngineId, setCustomModelReasoningOptionIdsByEngineId] =
    useState<Record<string, Record<string, string[]>>>({});
  const [executionPreferencesByEngineId, setExecutionPreferencesByEngineId] = useState<
    SessionSettingsRpc["executionPreferencesByEngineId"]
  >({});
  const executionPreferencesByEngineIdRef = useRef<
    SessionSettingsRpc["executionPreferencesByEngineId"]
  >({});
  const [statusNotice, setStatusNoticeState] = useState<ComposerStatusNotice | undefined>();
  const [processVisibilityByTurnId, setProcessVisibilityByTurnId] = useState<
    Record<string, ProcessVisibilityOverride>
  >({});
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxState | undefined>();
  const [settingsHydrated, setSettingsHydrated] = useState(false);

  const writeStatusNoticeLog = useCallback(
    (notice: ComposerStatusNotice): void => {
      if (notice.severity !== "error") {
        return;
      }
      const stack =
        notice.stack ??
        new Error(`Status notice emitted: ${notice.message}`).stack;
      void transport.errorLog
        .write({
          message: notice.message,
          severity: "error",
          source: notice.source,
          stack,
          context: {
            persistent: notice.persistent ?? false,
            ...notice.context
          }
        })
        .catch(() => undefined);
    },
    [transport]
  );

  const setStatusNotice = useCallback(
    (action: SetStateAction<ComposerStatusNotice | undefined>): void => {
      if (typeof action === "function") {
        setStatusNoticeState((current) => {
          const next = action(current);
          if (next && next !== current) {
            writeStatusNoticeLog(next);
          }
          return next;
        });
        return;
      }
      if (action) {
        writeStatusNoticeLog(action);
      }
      setStatusNoticeState(action);
    },
    [writeStatusNoticeLog]
  );

  const onExecutionPreferenceChange = useCallback(
    (engineId: string, execution: ComposerExecutionSelection): void => {
      const nextPreferences = writeEngineExecutionPreference(
        executionPreferencesByEngineIdRef.current,
        engineId,
        execution
      );
      executionPreferencesByEngineIdRef.current = nextPreferences;
      setExecutionPreferencesByEngineId(nextPreferences);
      void transport.settings
        .update({
          executionPreferencesByEngineId: nextPreferences
        })
        .catch((error) => {
          setStatusNotice({
            message: `Execution preference save failed: ${(error as Error).message}`,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        });
    },
    [setStatusNotice, transport]
  );

  const {
    chatTree: activeChatTree,
    viewSessionId,
    isOpening: isOpeningSelectedSession,
    refreshChatTree,
    onJumpChatTree,
    prepareSend
  } = useChatTreeController({
    store,
    transport,
    sessionId,
    refreshSignal: state.refreshSignals.chatTree + state.refreshSignals.sessionBrowser,
    onStatusNotice: setStatusNotice
  });
  const memberSessionIds = useMemo(
    () => activeChatTree?.memberSessionIds ?? (sessionId ? [sessionId] : []),
    [activeChatTree?.memberSessionIds, sessionId]
  );
  const displayedSessionRevision = useRendererSessionsRevision(store, memberSessionIds);
  const domain = store.getDomainReadModel();
  const displayedSession = viewSessionId ? domain.getSession(viewSessionId) : undefined;
  const activeSessionId = displayedSession && !isOpeningSelectedSession ? viewSessionId : undefined;
  const activeSessionWindow = activeChatTree?.windows?.find((window) => window.sessionId === viewSessionId);
  const displayedEngineId = displayedSession?.engineId ?? selectedEngineId;
  const activeThreadGoal = activeSessionId
    ? domain.getThreadGoal(activeSessionId)
    : undefined;
  const skillsCwd =
    typeof displayedSession?.metadata?.cwd === "string"
      ? displayedSession.metadata.cwd
      : undefined;

  useRendererDiagnostics({
    transport,
    activeSessionId,
    eventCursor: state.eventStream.lastCursor
  });

  const displayedConversationId = displayedSession?.conversationId;
  const displayedConversationRevision = useRendererConversationRevision(
    store,
    displayedConversationId
  );
  // Most session switches resolve within a frame; only surface the loading state when a switch is genuinely slow.
  const showOpeningIndicator = useDelayedFlag(isOpeningSelectedSession, 300);
  const turns = useMemo(
    () => activeChatTree?.visibleTurnIds
      ? activeChatTree.visibleTurnIds.map((id) => domain.getTurn(id)).filter((turn): turn is Turn => Boolean(turn))
      : viewSessionId ? domain.listTurns({ sessionId: viewSessionId }) : emptyTurns,
    [domain, viewSessionId, displayedSessionRevision, activeChatTree]
  );
  const currentTurn = turns.at(-1);
  const activeSession = displayedSession && activeSessionId
    ? {
        ...displayedSession,
        status: currentTurn?.status === "completed" || !currentTurn
          ? "idle" as const
          : displayedSession.status === "awaiting_approval" ? "awaiting_approval" as const : "running" as const,
        lastTurnId: currentTurn?.turnId
      }
    : undefined;
  const participants = useMemo(
    () =>
      displayedConversationId
        ? domain.listParticipants({ conversationId: displayedConversationId })
        : emptyParticipants,
    [displayedConversationId, displayedConversationRevision, domain]
  );
  const participantDirectory = useMemo(
    () => buildParticipantDirectory(participants),
    [participants]
  );
  const transcriptRows = useMemo(
    () => buildTurnTranscriptRows(domain, turns, participantDirectory),
    [domain, turns, participantDirectory]
  );
  const transcriptContentVersion = useMemo(
    () => buildTranscriptContentVersion(transcriptRows),
    [transcriptRows]
  );

  const viewport = useTranscriptViewportController({
    displayedSessionId: sessionId,
    isOpeningSelectedSession,
    windowStartTurnId: turns[0]?.turnId,
    windowEndTurnId: currentTurn?.turnId,
    renderedTranscriptRowCount: transcriptRows.length,
    transcriptContentVersion
  });

  useEffect(() => {
    setProcessVisibilityByTurnId({});
    if (sessionId) viewport.scrollToBottom(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!viewSessionId || !reloadSignal) return;
    void transport.sessionBrowser.open(viewSessionId, { forceProviderHydration: true })
      .then(() => refreshChatTree())
      .catch((error) => setStatusNotice({
        message: `Session refresh failed: ${(error as Error).message}`,
        source: "session-browser",
        ...statusNoticeErrorDetails(error)
      }));
  }, [reloadSignal]);

  const backlogRefreshRef = useRef({ startedAt: 0, inFlight: false });
  const refreshChatTreeRef = useRef(refreshChatTree);
  refreshChatTreeRef.current = refreshChatTree;
  const onBacklogPressure = useCallback((pressure: EventBacklogPressure): void => {
    const backlog = backlogRefreshRef.current;
    if (pressure.streamPendingCount < autoRefreshBacklogStreamThreshold ||
        backlog.inFlight || Date.now() - backlog.startedAt < autoRefreshBacklogCooldownMs) return;
    backlog.startedAt = Date.now();
    backlog.inFlight = true;
    void refreshChatTreeRef.current().catch(() => undefined).finally(() => { backlog.inFlight = false; });
  }, []);

  const [showChatTree, setShowChatTree] = useState(() => globalThis.localStorage?.getItem(CHAT_TREE_VISIBLE_KEY) === "1");
  const toggleChatTree = () => {
    setShowChatTree((current) => {
      globalThis.localStorage?.setItem(CHAT_TREE_VISIBLE_KEY, current ? "0" : "1");
      return !current;
    });
  };
  const visibleTranscriptRows = useMemo(
    () => filterTranscriptRowsForChatTree(transcriptRows, activeChatTree),
    [transcriptRows, activeChatTree]
  );
  const composerTurns = useMemo(
    () => filterComposerTurnsForChatTree(currentTurn ? [currentTurn] : emptyTurns, activeChatTree),
    [currentTurn, activeChatTree]
  );
  const renderedTranscriptRows = isOpeningSelectedSession ? [] : visibleTranscriptRows;
  const activeSessionApprovals = useMemo(
    () =>
      activeSessionId
        ? domain.listApprovalRequests().filter(
            (approval): approval is ApprovalRequest =>
              approval.sessionId === activeSessionId && approval.turnId === currentTurn?.turnId && approval.status === "pending"
          )
        : [],
    [activeSessionId, currentTurn?.turnId, displayedSessionRevision, domain]
  );
  const activeSessionInteractions = useMemo(
    () =>
      activeSessionId
        ? domain.listRuntimeInteractions({ sessionId: activeSessionId }).filter(
            (interaction): interaction is RuntimeInteraction =>
              interaction.sessionId === activeSessionId && interaction.turnId === currentTurn?.turnId && interaction.status === "pending"
          )
        : [],
    [activeSessionId, currentTurn?.turnId, displayedSessionRevision, domain]
  );

  useEffect(() => {
    if (!statusNotice || statusNotice.persistent) {
      return;
    }
    const timeoutId = setTimeout(() => {
      setStatusNotice((current) => (current === statusNotice ? undefined : current));
    }, 2_000);
    return () => clearTimeout(timeoutId);
  }, [statusNotice]);

  useEffect(() => {
    let disposed = false;
    void transport.engine
      .list()
      .then((list) => {
        if (!disposed) {
          setAvailableEngines(list);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Engine list failed: ${(error as Error).message}`,
            persistent: true,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport]);

  useEffect(() => {
    if (settingsHydrated && !selectedEngineId && availableEngines.length > 0) {
      setSelectedEngineId(availableEngines[0]!.engineId);
    }
  }, [availableEngines, selectedEngineId, settingsHydrated]);

  useEffect(() => {
    let disposed = false;
    void transport.settings
      .get()
      .then((settings) => {
        if (disposed) {
          return;
        }
        if (settings.defaultNewSessionEngineId) {
          setSelectedEngineId(settings.defaultNewSessionEngineId);
        }
        setAllowedModelIdsByEngineId(settings.allowedModelIdsByEngineId ?? {});
        setCustomModelReasoningOptionIdsByEngineId(
          settings.customModelReasoningOptionIdsByEngineId ?? {}
        );
        const executionPreferences = settings.executionPreferencesByEngineId ?? {};
        executionPreferencesByEngineIdRef.current = executionPreferences;
        setExecutionPreferencesByEngineId(executionPreferences);
        setSettingsHydrated(true);
      })
      .catch((error) => {
        if (!disposed) {
          setSettingsHydrated(true);
          setStatusNotice({
            message: `Settings load failed: ${(error as Error).message}`,
            persistent: true,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport]);

  useEffect(() => {
    const engineIds = [selectedEngineId, displayedEngineId].filter(
      (engineId): engineId is string => Boolean(engineId)
    );
    const nextEngineId = engineIds.find((engineId) => !engineSurfacesById[engineId]);
    if (!nextEngineId) {
      return;
    }
    let disposed = false;
    void transport.engine
      .getSurface(nextEngineId)
      .then((surface) => {
        if (!disposed) {
          setEngineSurfacesById((current) => ({
            ...current,
            [nextEngineId]: surface
          }));
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Engine surface failed: ${(error as Error).message}`,
            persistent: true,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [displayedEngineId, engineSurfacesById, selectedEngineId, transport]);

  useEffect(() => {
    let unsubscribe: (() => Promise<void>) | undefined;
    let disposed = false;
    void connectDesktopTransportToStore({
      transport,
      store,
      onBacklogPressure
    })
      .then((binding) => {
        if (disposed) {
          void binding.unsubscribe();
          return;
        }
        unsubscribe = binding.unsubscribe;
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Event subscribe failed: ${(error as Error).message}`,
            persistent: true,
            source: "subscription",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
      if (unsubscribe) {
        void unsubscribe();
      }
    };
  }, [transport, store, onBacklogPressure]);

  const onRespondApproval = useCallback(async (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
    decision?: string | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }): Promise<void> => {
    await transport.approval.respond(input);
  }, [transport]);

  const onRespondInteraction = useCallback(async (input: {
    sessionId: string;
    requestId: string;
    action: "accept" | "decline" | "cancel" | "submit" | "defer";
    response?: Record<string, unknown>;
    content?: unknown;
    answers?: Record<string, string[]>;
  }): Promise<void> => {
    await transport.interaction.respond(input);
  }, [transport]);

  const onToggleProcess = useCallback((turnId: string, defaultExpanded: boolean): void => {
    setProcessVisibilityByTurnId((current) =>
      toggleProcessVisibility(current, turnId, defaultExpanded)
    );
  }, []);

  const onPreviewImage = useCallback((image: ImageLightboxState): void => {
    setLightboxImage(image);
  }, []);

  return (
    <>
      <div className="awb-session-pane">
        <header className="awb-main__header">
          <div>
            <h2>
              {sessionId ? truncateSessionHeading(displayedSession?.title) : "新会话"}
            </h2>
          </div>
          <div className="awb-main__header-actions">
            <button
              type="button"
              className={"awb-header-toggle" + (showChatTree ? " is-on" : "")}
              aria-pressed={showChatTree}
              aria-label="对话树"
              title="对话树"
              onClick={toggleChatTree}
            >
              <GitBranch size={15} />
            </button>
          </div>
        </header>

        <div className="awb-main__body">
          <div className="awb-transcript-column">
          <TranscriptPane
            transcriptRef={viewport.transcriptRef}
            transcriptContentRef={viewport.transcriptContentRef}
            renderedTranscriptRows={renderedTranscriptRows}
            participantDirectory={participantDirectory}
            transport={transport}
            engineId={displayedEngineId}
            engineSurface={displayedEngineId ? engineSurfacesById[displayedEngineId] : undefined}
            engineExtensionRefreshSignal={state.refreshSignals.engineExtensions}
            sessionCwd={skillsCwd}
            activeSessionWindow={activeSessionWindow}
            activeSessionId={activeSessionId}
            isOpeningSelectedSession={showOpeningIndicator}
            isSwitchPending={isOpeningSelectedSession}
            loadingOlderTurns={false}
            onLoadOlder={() => undefined}
            processVisibilityByTurnId={processVisibilityByTurnId}
            onToggleProcess={onToggleProcess}
            onPreviewImage={onPreviewImage}
            onRespondApproval={onRespondApproval}
            onRespondInteraction={onRespondInteraction}
          />
          </div>
          {showChatTree && (
            <aside className="awb-chat-tree-column" aria-label="对话树">
              <section className="awb-detail__graph">
                <ChatTreePanel
                  chatTree={activeChatTree}
                  onJump={sessionId ? (nodeId) => {
                    void onJumpChatTree(nodeId).then(() => viewport.scrollToBottom(sessionId));
                  } : undefined}
                />
              </section>
            </aside>
          )}
        </div>

        <ComposerContainer
          extraExecutionControls={composerExtras}
          transport={transport}
          activeSession={activeSession}
          activeSessionId={activeSessionId}
          threadGoal={activeThreadGoal}
          selectedEngineId={displayedEngineId}
          engineSurface={
            settingsHydrated ? engineSurfacesById[displayedEngineId] : undefined
          }
          allowedModelIds={allowedModelIdsByEngineId[displayedEngineId]}
          customModelReasoningOptionIds={
            customModelReasoningOptionIdsByEngineId[displayedEngineId]
          }
          modelExecutionPreferences={
            executionPreferencesByEngineId[displayedEngineId]?.modelPreferences
          }
          lastExecution={toComposerExecution(
            resolveEngineExecutionPreference(
              executionPreferencesByEngineId[displayedEngineId]
            )
          )}
          skillsCwd={skillsCwd}
          turns={composerTurns}
          interruptTurns={composerTurns}
          allowSessionLastTurnFallback={!activeChatTree?.supportsJump}
          approvals={activeSessionApprovals}
          interactions={activeSessionInteractions}
          isOpeningSelectedSession={isOpeningSelectedSession}
          statusNotice={statusNotice}
          onStatusNotice={setStatusNotice}
          onPreviewImage={onPreviewImage}
          createSession={sessionId ? undefined : createSession}
          prepareSend={sessionId ? prepareSend : undefined}
          autoSendQueuedMessages={currentTurn?.turnId === displayedSession?.lastTurnId}
          onResumeSession={viewSessionId ? async () => {
            await transport.sessionBrowser.open(viewSessionId);
            await refreshChatTree();
          } : undefined}
          onRequestTranscriptBottom={() => { if (sessionId) viewport.scrollToBottom(sessionId); }}
          onExecutionPreferenceChange={onExecutionPreferenceChange}
          onRespondApproval={onRespondApproval}
          onRespondInteraction={onRespondInteraction}
        />
      </div>
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
};
