import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, GitBranch, Square } from "lucide-react";
import type { ChatTreeSnapshotRpc, Turn } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { formatRelativeActivityAge, TranscriptPane } from "./SessionPane.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import { buildParticipantDirectory } from "./participant-directory.js";
import { useRendererConversationParticipants, useRendererSessionSelection, useRendererStoreState, useRendererVisibleTurnsRevision } from "./use-renderer-store-state.js";
import { useTranscriptViewportController } from "./use-transcript-viewport-controller.js";
import { createCoalescedRefresh } from "./coalesced-refresh.js";
import { resolveProcessExpanded, toggleProcessVisibility, type ProcessVisibilityOverride } from "./process-visibility.js";
import { t } from "../../i18n/index.js";
import "./mobile-session.css";

export type MobileSessionPaneProps = {
  sessionId: string;
  store: RendererStore;
  transport: DesktopTransport;
  reloadSignal?: number;
  disabled?: boolean;
  draftCache?: Map<string, string>;
  onVisiblePathChange?: (turnIds: string[], sessionId: string) => void;
  /** Branch member chosen on the phone; its tip is read without moving the desktop's saved view. */
  branchSessionId?: string;
  title: string;
  /** Workspace name shown before the status in the top bar's second line. */
  workspaceLabel?: string;
  backLabel: string;
  onBack: () => void;
  branches?: { count: number; status: "none" | "running" | "unread_completed" };
  onOpenBranches?: () => void;
};

export const mobileSendSessionId = (path: ChatTreeSnapshotRpc): string =>
  path.currentSessionId ?? path.nodes.find((node) => node.nodeId === path.visibleNodeIds?.at(-1))?.sessionId ?? path.sessionId;

/** Mobile follows the selected branch to its tip without moving the desktop cursor. */
export const mobileVisiblePath = (path: ChatTreeSnapshotRpc): ChatTreeSnapshotRpc => {
  const memberId = mobileSendSessionId(path);
  const tip = path.nodes.filter((node) => node.sessionId === memberId)
    .reduce<ChatTreeSnapshotRpc["nodes"][number] | undefined>((latest, node) =>
      !latest || node.order > latest.order ? node : latest, undefined);
  if (!tip) return path;
  const byId = new Map(path.nodes.map((node) => [node.nodeId, node]));
  const visibleNodeIds: string[] = [];
  let node: typeof tip | undefined = tip;
  while (node) {
    visibleNodeIds.unshift(node.nodeId);
    node = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  }
  return { ...path, currentNodeId: tip.nodeId, visibleNodeIds,
    visibleTurnIds: visibleNodeIds.flatMap((id) => byId.get(id)?.turnId ? [byId.get(id)!.turnId!] : []) };
};

/** Turns read per page, and the length past which completed turns' tool and terminal text is cut until expanded. */
const PAGE_TURNS = 6;
const PAGE_TEXT_LENGTH = 600;

/** The loaded run of the path ending at its newest loaded turn; the phone never shows a gap. */
export const loadedPathRange = (turnIds: readonly string[], loaded: (turnId: string) => boolean): { start: number; end: number } => {
  let end = turnIds.length;
  while (end > 0 && !loaded(turnIds[end - 1]!)) end--;
  let start = end;
  while (start > 0 && loaded(turnIds[start - 1]!)) start--;
  return { start, end };
};

/** The mobile shell owns the single transport/store binding and reconnect signal. */
export const MobileSessionPane = (props: MobileSessionPaneProps) =>
  <MobileSessionContent key={props.sessionId} {...props} />;

const MobileSessionContent = ({
  sessionId, store, transport, reloadSignal = 0, disabled = false, onVisiblePathChange, draftCache,
  branchSessionId, title, workspaceLabel, backLabel, onBack, branches, onOpenBranches
}: MobileSessionPaneProps) => {
  const state = useRendererStoreState(store);
  const [path, setPath] = useState<ChatTreeSnapshotRpc>();
  // A branch opened directly (a Worker from Inbox or a notification) reads that member rather than the desktop's view.
  const [treeId, setTreeId] = useState<string>();
  const viewSessionId = branchSessionId ?? (treeId && treeId !== sessionId ? sessionId : undefined);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState(() => draftCache?.get(sessionId) ?? "");
  useEffect(() => { draftCache?.set(sessionId, draft); }, [draft, draftCache, sessionId]);
  const [busy, setBusy] = useState(false);
  const [visibility, setVisibility] = useState<Record<string, ProcessVisibilityOverride>>({});
  const refreshQueue = useMemo(createCoalescedRefresh, [sessionId, store, transport]);
  const mounted = useRef(true);
  const actionPending = useRef(false);
  // Turns whose tool output arrived cut, and turns the user expanded and now holds in full.
  const truncatedTurns = useRef(new Set<string>());
  const fullTurns = useRef(new Set<string>());
  /** Reads part of the viewed path; paged windows merge into what the phone already holds. */
  const readPage = useCallback(async (
    page: { turns?: number; beforeTurnId?: string; turnIds?: string[]; maxTextLength?: number },
    options: { signal?: AbortSignal; view?: string; beforeHydrate?: () => void } = {}
  ) => {
    const readId = crypto.randomUUID();
    const finish = store.beginSessionWindowRead(readId);
    try {
      const next = await transport.chatTree.get(sessionId, {
        scope: "path", readId, signal: options.signal, ...(options.view ? { viewSessionId: options.view } : {}),
        page: { ...page, ...(page.maxTextLength ? { fullTurnIds: [...fullTurns.current] } : {}) }
      });
      if (options.signal?.aborted) return undefined;
      for (const turnId of next.truncatedTurnIds ?? []) truncatedTurns.current.add(turnId);
      options.beforeHydrate?.();
      store.hydrateSessionWindows((next.windows ?? []).map((window) => ({
        sessionId: window.sessionId, snapshot: window.snapshot, cursor: window.cursor,
        replaceSessionHistory: window.replaceSessionHistory
      })), readId);
      return next;
    } finally {
      finish();
    }
  }, [sessionId, store, transport]);
  const refresh = useCallback(() => refreshQueue.request(async (signal) => {
    const next = await readPage({ turns: PAGE_TURNS, maxTextLength: PAGE_TEXT_LENGTH }, { signal, view: viewSessionId });
    if (!next) return;
    setTreeId(next.treeId ?? next.sessionId);
    setPath({ ...mobileVisiblePath(next), windows: undefined });
    setError(undefined);
  }), [readPage, refreshQueue, viewSessionId]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshQueue.cancel(); };
  }, [refreshQueue]);
  useEffect(() => {
    if (disabled) { refreshQueue.cancel(); return; }
    void refresh().catch((cause: Error) => {
      if (mounted.current) setError(cause.message);
    });
  }, [disabled, refresh, refreshQueue, reloadSignal, state.refreshSignals.chatTree]);

  const domain = store.getDomainReadModel();
  const targetSessionId = path ? mobileSendSessionId(path) : sessionId;
  const turnIds = path?.visibleTurnIds ?? [];
  const visiblePathKey = turnIds.join("\n");
  useLayoutEffect(() => {
    onVisiblePathChange?.(turnIds, targetSessionId);
    return () => onVisiblePathChange?.([], targetSessionId);
  }, [visiblePathKey, targetSessionId, onVisiblePathChange]);
  const revision = useRendererVisibleTurnsRevision(store, turnIds, path ? undefined : targetSessionId);
  const { session } = useRendererSessionSelection(store, targetSessionId,
    () => ({ session: domain.getSession(targetSessionId) }));
  const participants = useRendererConversationParticipants(store, session?.conversationId);
  const directory = useMemo(() => buildParticipantDirectory(participants), [participants]);
  const range = useMemo(() => loadedPathRange(turnIds, (id) => Boolean(domain.getTurn(id))), [domain, visiblePathKey, revision]);
  const turns = useMemo(() => path
    ? turnIds.slice(range.start, range.end).map((id) => domain.getTurn(id)).filter((turn): turn is Turn => Boolean(turn))
    : [], [domain, path, range, revision]);
  const hasOlder = Boolean(path) && range.start > 0 && range.end > 0;
  const rows = useMemo(() => buildTurnTranscriptRows(domain, turns, directory), [domain, turns, directory]);
  const currentTurn = (session?.lastTurnId ? domain.getTurn(session.lastTurnId) : undefined) ?? turns.at(-1);
  const completedVisibleKey = turns.filter((turn) => turn.status === "completed").map((turn) => turn.turnId).join("\n");
  const running = Boolean(currentTurn && currentTurn.status !== "completed");
  const awaitingApproval = session?.status === "awaiting_approval";
  const lastActivity = currentTurn?.completedAt ?? currentTurn?.startedAt;
  const status = disabled ? t("mobile.connecting")
    : awaitingApproval ? t("session.statusAwaitingApproval")
      : session?.status === "error" ? t("mobile.statusFailed")
        : running ? t("session.statusRunning")
          : !path ? t("common.loading")
            : formatRelativeActivityAge(lastActivity) ?? t("session.statusReady");
  const viewport = useTranscriptViewportController({
    displayedSessionId: sessionId, isOpeningSelectedSession: !path,
    windowStartTurnId: turns[0]?.turnId, windowEndTurnId: currentTurn?.turnId,
    renderedTranscriptRowCount: rows.length, transcriptContentVersion: revision
  });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderPending = useRef(false);
  const loadOlder = useCallback(async () => {
    const beforeTurnId = turnIds[range.start];
    if (!hasOlder || disabled || olderPending.current || !beforeTurnId) return;
    olderPending.current = true;
    setLoadingOlder(true);
    try {
      await readPage({ turns: PAGE_TURNS, beforeTurnId, maxTextLength: PAGE_TEXT_LENGTH }, {
        view: targetSessionId,
        // Keep the reader on the message they were looking at while earlier turns are inserted above it.
        beforeHydrate: () => {
          const element = viewportRef.current.transcriptRef.current;
          if (element) viewportRef.current.queuePrependScrollRestore({
            sessionId, previousScrollHeight: element.scrollHeight, previousScrollTop: element.scrollTop
          });
        }
      });
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      olderPending.current = false;
      if (mounted.current) setLoadingOlder(false);
    }
  }, [disabled, hasOlder, range.start, readPage, sessionId, targetSessionId, visiblePathKey]);
  // Reaching the top of the loaded messages loads the page before them.
  useEffect(() => {
    const element = viewport.transcriptRef.current;
    if (!element || !hasOlder) return;
    const onScroll = () => { if (element.scrollTop < 240) void loadOlder(); };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [hasOlder, loadOlder, viewport.transcriptRef]);
  const loadFullTurn = (turnId: string) => {
    truncatedTurns.current.delete(turnId);
    fullTurns.current.add(turnId);
    void readPage({ turnIds: [turnId] }, { view: targetSessionId }).catch((cause: Error) => {
      fullTurns.current.delete(turnId);
      truncatedTurns.current.add(turnId);
      if (mounted.current) setError(cause.message);
    });
  };
  const activeWindow = useMemo(() => ({ sessionId: targetSessionId, hasOlder, hasNewer: false }), [targetSessionId, hasOlder]);
  useEffect(() => { viewportRef.current.scrollToBottom(sessionId); }, [sessionId, targetSessionId]);
  useEffect(() => {
    const nodeId = path?.visibleNodeIds?.at(-1);
    if (disabled || !nodeId) return;
    const markRead = () => {
      if (document.visibilityState === "visible") {
        void transport.chatTree.markRead({ sessionId, nodeId }).catch(() => undefined);
      }
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [disabled, path?.visibleNodeIds?.at(-1), completedVisibleKey, reloadSignal, sessionId, transport]);

  const runAction = async (action: () => Promise<unknown>) => {
    if (disabled || actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      if (mounted.current) await refresh();
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const send = () => {
    const content = draft.trim();
    if (!content || !path) return;
    void runAction(async () => {
      const receipt = running && currentTurn
        ? await transport.chat.steer({ sessionId: targetSessionId, turnId: currentTurn.turnId, content })
        : await transport.chat.send({ sessionId: targetSessionId, content });
      if (!receipt.accepted) throw new Error(t("mobile.notAccepted"));
      if (mounted.current) {
        setDraft((value) => value === draft ? "" : value);
        viewportRef.current.scrollToBottom(sessionId);
      }
    });
  };

  return <div className="awb-mobile-session">
    <header className="awb-mobile-topbar">
      <button type="button" className="awb-mobile-icon" aria-label={backLabel} onClick={onBack}><ChevronLeft size={24} strokeWidth={1.8} /></button>
      <div className="awb-mobile-topbar__title">
        <strong>{title}</strong>
        <small>
          {(running || awaitingApproval) && !disabled && <i className="awb-mobile-dot" data-status="running" />}
          <span>{[workspaceLabel, status].filter(Boolean).join(" · ")}</span>
        </small>
      </div>
      {branches && onOpenBranches ? <button type="button" className="awb-mobile-icon awb-mobile-branch-button"
        aria-label={t("mobile.branches.open", { count: branches.count })} onClick={onOpenBranches}>
        <GitBranch size={21} strokeWidth={1.8} />
        <span className="awb-mobile-branch-button__count">{branches.count}</span>
        {branches.status !== "none" && <i className="awb-mobile-dot" data-status={branches.status === "running" ? "running" : "unread"} />}
      </button> : <span />}
    </header>
    <TranscriptPane
      compactProcess
      transcriptRef={viewport.transcriptRef} transcriptContentRef={viewport.transcriptContentRef}
      renderedTranscriptRows={rows} participantDirectory={directory} transport={transport}
      engineExtensionRefreshSignal={0} activeSessionId={targetSessionId}
      isOpeningSelectedSession={!path && !error} isSwitchPending={!path && !error}
      openingError={!path && !disabled ? error : undefined} onRetryOpening={() => { void runAction(refresh); }}
      activeSessionWindow={activeWindow}
      loadingOlderTurns={loadingOlder} onLoadOlder={() => { void loadOlder(); }}
      processVisibilityByTurnId={visibility}
      onToggleProcess={(id, defaultExpanded) => {
        const next = toggleProcessVisibility(visibility, id, defaultExpanded);
        if (resolveProcessExpanded(defaultExpanded, next[id]) && truncatedTurns.current.has(id)) loadFullTurn(id);
        setVisibility(next);
      }}
      onRetrySend={async () => undefined}
      onRespondApproval={disabled ? undefined : async (input) => { await transport.approval.respond(input); await refresh(); }}
      onRespondInteraction={disabled ? undefined : async (input) => { await transport.interaction.respond(input); await refresh(); }}
    />
    <MobileComposer
      draft={draft} onDraft={setDraft} onSend={send} error={disabled ? undefined : error}
      canSend={!disabled && !busy && Boolean(path) && Boolean(draft.trim())}
      placeholder={running ? t("session.runningCanSteer") : t("mobile.messagePlaceholder")}
      onStop={running && currentTurn && !disabled
        ? () => { void runAction(() => transport.chat.interrupt({ sessionId: targetSessionId, turnId: currentTurn.turnId })); }
        : undefined}
      stopping={busy}
    />
  </div>;
};

/**
 * One-line input that grows with its text. While a turn runs and nothing is typed, the send button stops
 * the turn; typed text is sent into the running turn as usual.
 */
const MobileComposer = ({ draft, onDraft, onSend, canSend, placeholder, error, onStop, stopping }: {
  draft: string; onDraft: (value: string) => void; onSend: () => void; canSend: boolean; placeholder: string; error?: string;
  onStop?: () => void; stopping: boolean;
}) => {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  const stop = onStop && !draft.trim();
  return <form className="awb-mobile-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}>
    {error && <p className="awb-mobile-composer__error" role="alert">{error}</p>}
    <div className="awb-mobile-field">
      <textarea ref={field} rows={1} aria-label={t("mobile.message")} placeholder={placeholder} value={draft}
        onChange={(event) => onDraft(event.target.value)} />
      {stop
        ? <button type="button" className="awb-mobile-send" data-action="stop" aria-label={t("session.stop")} disabled={stopping} onClick={onStop}>
          <span><Square size={12} fill="currentColor" /></span></button>
        : <button type="submit" className="awb-mobile-send" aria-label={t("session.send")} disabled={!canSend}><span><ArrowUp size={18} strokeWidth={2.2} /></span></button>}
    </div>
  </form>;
};
