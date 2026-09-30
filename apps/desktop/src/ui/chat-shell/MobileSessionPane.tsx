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
import { toggleProcessVisibility, type ProcessVisibilityOverride } from "./process-visibility.js";
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
  const refresh = useCallback(() => refreshQueue.request(async (signal) => {
    const readId = crypto.randomUUID();
    const finish = store.beginSessionWindowRead(readId);
    try {
      const next = await transport.chatTree.get(sessionId, {
        scope: "path", knownWindows: store.getKnownSessionWindows(), readId, signal, ...(viewSessionId ? { viewSessionId } : {})
      });
      if (signal.aborted) return;
      setTreeId(next.treeId ?? next.sessionId);
      store.hydrateSessionWindows((next.windows ?? []).map((window) => ({
        sessionId: window.sessionId, snapshot: window.snapshot, cursor: window.cursor,
        replaceSessionHistory: window.replaceSessionHistory,
        revision: !window.hasOlder && !window.hasNewer ? window.revision : undefined
      })), readId);
      setPath({ ...mobileVisiblePath(next), windows: undefined });
      setError(undefined);
    } finally {
      finish();
    }
  }), [refreshQueue, sessionId, store, transport, viewSessionId]);

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
  const turns = useMemo(() => path
    ? turnIds.map((id) => domain.getTurn(id)).filter((turn): turn is Turn => Boolean(turn))
    : [], [domain, path, revision]);
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
      loadingOlderTurns={false} onLoadOlder={() => undefined}
      processVisibilityByTurnId={visibility}
      onToggleProcess={(id, expanded) => setVisibility((value) => toggleProcessVisibility(value, id, expanded))}
      onRetrySend={async () => undefined}
      onRespondApproval={disabled ? undefined : async (input) => { await transport.approval.respond(input); await refresh(); }}
      onRespondInteraction={disabled ? undefined : async (input) => { await transport.interaction.respond(input); await refresh(); }}
    />
    <MobileComposer
      draft={draft} onDraft={setDraft} onSend={send} error={disabled ? undefined : error}
      canSend={!disabled && !busy && Boolean(path) && Boolean(draft.trim())}
      placeholder={running ? t("session.runningCanSteer") : t("mobile.messagePlaceholder")}
      run={running && currentTurn && !disabled ? {
        label: awaitingApproval ? t("mobile.runningAwaitingApproval") : t("session.statusRunning"),
        stopping: busy,
        onStop: () => { void runAction(() => transport.chat.interrupt({ sessionId: targetSessionId, turnId: currentTurn.turnId })); }
      } : undefined}
    />
  </div>;
};

/** One-line input that grows with its text; a run strip with Stop appears above it only while a turn runs. */
const MobileComposer = ({ draft, onDraft, onSend, canSend, placeholder, error, run }: {
  draft: string; onDraft: (value: string) => void; onSend: () => void; canSend: boolean; placeholder: string; error?: string;
  run?: { label: string; stopping: boolean; onStop: () => void };
}) => {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  return <form className="awb-mobile-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}>
    {run && <div className="awb-mobile-runbar" role="status">
      <span><i className="awb-mobile-dot" data-status="running" />{run.label}</span>
      <button type="button" className="awb-mobile-stop" disabled={run.stopping} onClick={run.onStop}><span><Square size={9} fill="currentColor" />{t("session.stop")}</span></button>
    </div>}
    {error && <p className="awb-mobile-composer__error" role="alert">{error}</p>}
    <div className="awb-mobile-field">
      <textarea ref={field} rows={1} aria-label={t("mobile.message")} placeholder={placeholder} value={draft}
        onChange={(event) => onDraft(event.target.value)} />
      <button type="submit" className="awb-mobile-send" aria-label={t("session.send")} disabled={!canSend}><span><ArrowUp size={18} strokeWidth={2.2} /></span></button>
    </div>
  </form>;
};
