import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { mergeSessionExecutionProfile, resolveEngineExecutionPreference } from "@vermillion/shared";
import type { SessionExecutionProfileInput } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { SessionPane } from "../chat-shell/SessionPane.js";
import type { MessageFileLinkMenuProps } from "../chat-shell/MessageMarkdownView.js";
import { WorkbenchChatTree } from "./components/WorkbenchChatTree.js";
import { DocsPanel } from "./components/DocsPanel.js";
import { StartWorkButton } from "./components/StartWorkButton.js";
import type { ComposerActions } from "../chat-shell/composer/composer-types.js";
import { InboxPanel } from "./components/InboxPanel.js";
import { Modal } from "./components/Modal.js";
import { ContextMenu } from "./components/ContextMenu.js";
import { Rail } from "./components/Rail.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { SearchDialog } from "./components/SearchDialog.js";
import { TextEditor } from "./components/TextEditor.js";
import { RoleEditor } from "./components/RoleEditor.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TaskStatusBar } from "./components/TaskStatusBar.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { CurrentWorkBar } from "./components/CurrentWorkBar.js";
import { Button, Field, InlineNotice, Tabs } from "./components/ui.js";
import { WorkspacePages, WorkspaceSwitcher } from "./components/WorkspacePages.js";
import { useSessionSidebar } from "./use-session-sidebar.js";
import { useSessionActions } from "./use-session-actions.js";
import { createWorkbenchStore, type Overlay, type Panel, type WorkspaceSection } from "./workbench-store.js";
import { createRendererWorkbenchClient } from "./workbench-client.js";
import "./app.css";
import { SessionNavigationContext, renderSessionNavigation } from "./session-navigation.js";
import type { SessionNavigation } from "@vermillion/workbench/client";
import type { SearchHit } from "@vermillion/workbench/client";

type AppProps = {
  sessionStore: RendererStore;
  transport: DesktopTransport;
};

const tabs: Array<{ id: WorkspaceSection; label: string }> = [
  { id: "sessions", label: "会话" },
  { id: "workItems", label: "工作" },
  { id: "docs", label: "文档" },
  { id: "domains", label: "领域" },
  { id: "roles", label: "角色" },
  { id: "issues", label: "Issues" },
  { id: "automation", label: "自动化" },
  { id: "manage", label: "管理" }
];


export const App = ({ sessionStore, transport }: AppProps) => {
  const store = useMemo(() => createWorkbenchStore(createRendererWorkbenchClient()), []);
  const panel = store((s) => s.panel);
  const overlay = store((s) => s.overlay);
  const section = store((s) => s.workspaceSection);
  const inboxCount = store((s) => s.inbox.length);
  const issueUnreadCount = store((s) => s.view?.issues.filter((issue) => issue.unread).length ?? 0);
  const workspaces = store((s) => s.workspaces);
  const draftWorkspaceId = store((s) => s.draftWorkspaceId);
  const setPanel = store((s) => s.setPanel);
  const openOverlay = store((s) => s.openOverlay);
  const closeOverlay = store((s) => s.closeOverlay);
  const browseWorkspace = store((s) => s.browseWorkspace);
  const setDocsSessionId = store((s) => s.setDocsSessionId);
  const connect = store((s) => s.connect);

  useEffect(() => connect(), [connect]);

  /** undefined = draft: the next message creates a session in draftWorkspaceId. */
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [workTarget, setWorkTarget] = useState<{ sessionId?: string; turnId?: string }>({});
  const workSessionId = workTarget.sessionId ?? sessionId;
  const discussionIssue = store((s) => s.view?.issues.find((issue) => issue.discussionSessionId === sessionId));
  const currentWorkRequest = store((s) => s.view?.workRequests.find((request) => {
    if (!workSessionId) return false;
    const hasOpenItems = s.view?.workItems.some((item) => item.requestId === request.requestId && !["closed", "cancelled"].includes(item.status));
    return (request.workerSessionId === workSessionId || (!request.workerSessionId && request.sourceSessionId === workSessionId && request.status === "pending")) &&
      (request.status !== "ready" || hasOpenItems);
  }));
  const currentWorkItem = store((s) => workSessionId ? s.view?.workItems.find((item) => item.run.sessionId === workSessionId && !["closed", "cancelled"].includes(item.status))
    ?? s.view?.workItems.filter((item) => item.run.sessionId === workSessionId).at(-1) : undefined);
  const decisions = store((s) => s.view?.decisions);
  const currentDecisions = (decisions ?? []).filter((card) => workSessionId && !card.answer && !card.withdrawn && card.sessionId === workSessionId);
  const [decisionMode, setDecisionMode] = useState<{ sessionId?: string; decisionId?: string; ordinary: boolean }>({ ordinary: false });
  const currentDecision = currentDecisions.find((card) => card.decisionId === decisionMode.decisionId) ?? (currentDecisions.length === 1 ? currentDecisions[0] : undefined);
  const answeringDecision = Boolean(currentDecision && !(decisionMode.sessionId === workSessionId && decisionMode.ordinary));
  const [workspaceFilterId, setWorkspaceFilterId] = useState<string | undefined>();
  const [composerActions, setComposerActions] = useState<ComposerActions>();
  const [navigationTarget, setNavigationTarget] = useState<{ sessionId: string; workspaceId: string }>();
  const [sessionEntry, setSessionEntry] = useState<{ focusTree?: boolean; turnId?: string }>();
  const [navigationError, setNavigationError] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchWorkItemTarget, setSearchWorkItemTarget] = useState<{ workspaceId: string; workItemId: string; nonce: number }>();
  const openSessionTarget = useCallback(async (workspaceId: string, targetSessionId: string, turnId?: string) => {
    setWorkTarget({});
    setSessionEntry({ focusTree: true, turnId });
    setNavigationTarget({ sessionId: targetSessionId, workspaceId });
    setSessionId(targetSessionId);
    if (workspaceFilterId && workspaceFilterId !== workspaceId) setWorkspaceFilterId(workspaceId);
    store.getState().browseWorkspace(workspaceId);
    store.setState({ workspaceSection: "sessions", panel: "workbench", overlay: undefined });
  }, [store, workspaceFilterId]);
  const openSearchWorkItem = useCallback((hit: SearchHit) => {
    if (!hit.workItemId) return;
    setSearchOpen(false);
    setSearchWorkItemTarget({ workspaceId: hit.workspaceId, workItemId: hit.workItemId, nonce: Date.now() });
    store.getState().showTask({ workspaceId: hit.workspaceId, kind: "workItem", id: hit.workItemId });
  }, [store]);
  const clearSearchWorkItemTarget = useCallback(() => setSearchWorkItemTarget(undefined), []);
  const renderFileLinkContextMenu = useCallback(({ path, location, target, onCopy, ...props }: MessageFileLinkMenuProps) => (
    <ContextMenu {...props} zIndex={1001}
      items={[
        { key: "copy-path", label: "复制路径", onSelect: () => onCopy(path) },
        ...(location
          ? [{ key: "copy-location", label: "复制文件位置", onSelect: () => onCopy(target) }]
          : [])
      ]} />
  ), []);
  const openSearchDoc = useCallback((hit: SearchHit) => {
    if (!hit.path) return;
    setSearchOpen(false);
    store.getState().browseWorkspace(hit.workspaceId);
    store.setState({ panel: "workbench", overlay: undefined, workspaceSection: "docs" });
    store.getState().openEditor({ kind: "doc", path: hit.path, line: hit.line, column: hit.column, nonce: Date.now() });
  }, [store]);
  const openSearchSession = useCallback((hit: SearchHit) => {
    if (!hit.sessionId) return;
    setSearchOpen(false);
    setNavigationError(undefined);
    void openSessionTarget(hit.workspaceId, hit.sessionId, hit.turnId)
      .catch((error: unknown) => setNavigationError(error instanceof Error ? error.message : String(error)));
  }, [openSessionTarget]);
  useEffect(() => {
    store.setState({ navigateSession: (workspaceId, id, turnId) => {
      setNavigationError(undefined);
      void openSessionTarget(workspaceId, id, turnId).catch((error: Error) => setNavigationError(error.message));
    } });
    return () => store.setState({ navigateSession: undefined });
  }, [store, openSessionTarget]);
  const navigation = useMemo(() => ({
    client: store.getState().client,
    open: (target: SessionNavigation) => openSessionTarget(target.targetWorkspaceId, target.targetSessionId)
  }), [store, openSessionTarget]);
  const workspaceIds = useMemo(() => workspaces.filter((w) => !workspaceFilterId || w.workspaceId === workspaceFilterId).map((w) => w.workspaceId), [workspaces, workspaceFilterId]);
  const sidebar = useSessionSidebar({ transport, store: sessionStore, workspaceIds });
  const workspaceLabelById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w.label])), [workspaces]);
  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w])), [workspaces]);
  const [reloadSignal, setReloadSignal] = useState(0);
  const sessionActions = useSessionActions({
    transport,
    refreshSidebar: sidebar.refresh,
    onArchived: (id) => setSessionId((current) => (current === id || (current && sidebar.findSession(current)?.sessionId === id) ? undefined : current)),
    onResumed: () => setReloadSignal((n) => n + 1)
  });
  const openSidebarSession = useCallback((id: string) => {
    setWorkTarget({});
    setSessionEntry(undefined);
    const selected = sidebar.findSession(id);
    if (selected) setNavigationTarget({ sessionId: id, workspaceId: selected.workspaceId });
    setSessionId(id);
    store.getState().setWorkspaceSection("sessions");
  }, [sidebar.findSession, store]);
  const openSidebarMenu = useCallback((event: ReactMouseEvent, id: string, title: string) => void sessionActions.openMenu(event, id, title), [sessionActions.openMenu]);

  // Docs panel follows the open session's workspace and tree; anywhere else it shows the main branch.
  const openSession = sessionId ? sidebar.findSession(sessionId) : undefined;
  const sessionWorkspaceId = openSession?.workspaceId ?? (navigationTarget?.sessionId === sessionId ? navigationTarget?.workspaceId : undefined);
  useEffect(() => {
    if (panel !== "workbench" || section !== "sessions") {
      setDocsSessionId(undefined);
      return;
    }
    browseWorkspace(sessionId ? sessionWorkspaceId : draftWorkspaceId);
    setDocsSessionId(sessionId);
  }, [panel, section, sessionId, sessionWorkspaceId, draftWorkspaceId, browseWorkspace, setDocsSessionId]);
  useEffect(() => {
    if (workspaceFilterId && !workspaces.some((workspace) => workspace.workspaceId === workspaceFilterId)) setWorkspaceFilterId(undefined);
  }, [workspaces, workspaceFilterId]);

  const [draftRevision, setDraftRevision] = useState(0);
  const resolveNewSessionEngineId = useCallback(async (): Promise<string> => {
    const [settings, engines] = await Promise.all([
      transport.settings.get(),
      transport.engine.list()
    ]);
    const preferred = settings.defaultNewSessionEngineId;
    if (preferred && engines.some((engine) => engine.engineId === preferred)) {
      return preferred;
    }
    const fallback = engines[0]?.engineId;
    if (!fallback) {
      throw new Error("没有可用的会话引擎。");
    }
    return fallback;
  }, [transport]);
  const initializeDraftExecution = useCallback(async () => {
    const settings = await transport.settings.get();
    const engineId = await resolveNewSessionEngineId();
    const role = draftWorkspaceId
      ? await store.getState().client.request("role.resolve", { workspaceId: draftWorkspaceId, roleId: "design-partner" })
      : undefined;
    return mergeSessionExecutionProfile(
      resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]),
      role?.modelConfig
    );
  }, [draftWorkspaceId, draftRevision, transport, store, resolveNewSessionEngineId]);

  const createSession = useCallback(
    async ({ execution }: { execution?: SessionExecutionProfileInput }) => {
      const workspace = draftWorkspaceId ? workspaceById.get(draftWorkspaceId) : undefined;
      if (!workspace) throw new Error("请先在 Composer 里选择一个 workspace。");
      const engineId = await resolveNewSessionEngineId();
      const created = await transport.sessionBrowser.create({
        workspaceId: workspace.workspaceId,
        engineId,
        sessionProfile: execution,
        metadata: { cwd: workspace.rootPath, role: "design-partner" }
      });
      sessionStore.dispatch({ type: "store/sessionBrowserChanged" });
      setSessionId(created.sessionId);
      setSessionEntry(undefined);
      setNavigationTarget({ sessionId: created.sessionId, workspaceId: workspace.workspaceId });
      if (workspaceFilterId && workspaceFilterId !== workspace.workspaceId) setWorkspaceFilterId(workspace.workspaceId);
      return created.sessionId;
    },
    [draftWorkspaceId, workspaceById, transport, store, workspaceFilterId, sessionStore, resolveNewSessionEngineId]
  );

  const onSelect = useCallback(
    (next: Panel | Overlay) => {
      if (next === "workbench") setPanel(next);
      else if (overlay === next) closeOverlay();
      else openOverlay(next);
    },
    [overlay, setPanel, openOverlay, closeOverlay]
  );

  const pickDirectory = useCallback(async () => {
    const result = await transport.workspace.pickDirectory();
    return result.canceled ? undefined : result.rootPath;
  }, [transport]);

  const onFileAction = useCallback(
    async (path: string, action: "open" | "reveal") => {
      await transport.file.runAction({ path, action });
    },
    [transport]
  );

  return (
    <SessionNavigationContext.Provider value={navigation}>
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-page-canvas text-foreground">
      <div className="flex min-h-0 flex-1">
      <Rail panel={panel} overlay={overlay} inboxCount={inboxCount} onSelect={onSelect} onOpenPage={setPanel} />
      <div className="relative min-w-0 flex-1">
        {/* Keep the workbench mounted while navigating so conversation drafts survive. */}
        <div className={panel === "workbench" ? "flex h-full" : "hidden"}>
          <SessionSidebar
            {...sidebar}
            selectedSessionId={sessionId}
            isDraft={sessionId === undefined}
            workspaceLabelById={workspaceLabelById}
            workspaceFilterId={workspaceFilterId}
            onWorkspaceFilter={(id) => {
              setWorkspaceFilterId(id);
              if (!sessionId && id && section === "sessions") store.getState().setDraftWorkspace(id);
            }}
            onOpen={openSidebarSession}
            onNewChat={() => {
              setSessionEntry(undefined);
              if (workspaceFilterId) store.getState().setDraftWorkspace(workspaceFilterId);
              setSessionId(undefined);
              store.getState().setWorkspaceSection("sessions");
              setDraftRevision((n) => n + 1);
            }}
            onSearch={() => setSearchOpen(true)}
            menu={sessionActions.menu}
            onOpenMenu={openSidebarMenu}
            onCloseMenu={sessionActions.closeMenu}
            onRunAction={(id, action) => void sessionActions.run(id, action)}
            renameDialog={sessionActions.renameDialog}
            notice={sessionActions.notice ?? (sidebar.error ? { text: sidebar.error, error: true } : undefined)}
            onClearNotice={() => { sessionActions.clearNotice(); if (sidebar.error) void sidebar.reload(); }}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <Tabs items={tabs.map((tab) => tab.id === "issues" && issueUnreadCount ? { ...tab, count: issueUnreadCount } : tab)} selected={section} onSelect={(id) => store.getState().setWorkspaceSection(id as WorkspaceSection)} />
            <div className={section === "sessions" ? "flex min-h-0 flex-1" : "hidden"}>
              <main className="relative min-w-0 flex-1">
                <SessionPane
                  isVisible={panel === "workbench" && section === "sessions" && !overlay}
                  store={sessionStore}
                  transport={transport}
                  sessionId={sessionId}
                  navigationEntry={sessionEntry}
                  reloadSignal={reloadSignal}
                  createSession={createSession}
                  initializeDraftExecution={initializeDraftExecution}
                  onBeforeStop={sessionWorkspaceId ? async (workerSessionId) => {
                    const preparation = store.getState().view?.workRequests.find((request) => request.workerSessionId === workerSessionId && ["pending", "preparing"].includes(request.status));
                    if (preparation) {
                      await store.getState().client.request("work.pause", { workspaceId: sessionWorkspaceId, requestId: preparation.requestId });
                      return;
                    }
                    await store.getState().client.request("workItem.pause", {
                      workspaceId: sessionWorkspaceId,
                      sessionId: workerSessionId
                    });
                  } : undefined}
                  onViewChange={setWorkTarget}
                  composerDraftKey="think"
                  onComposerChange={setComposerActions}
                  renderTurnNavigation={renderSessionNavigation}
                  renderChatTree={(props) => <WorkbenchChatTree {...props} client={store.getState().client} transport={transport} />}
                  renderImageContextMenu={({ onCopy, ...props }) => <ContextMenu {...props} zIndex={1001}
                    items={[{ key: "copy-image", label: "复制图片", onSelect: onCopy }]} />}
                  renderFileLinkContextMenu={renderFileLinkContextMenu}
                  composerHeader={currentWorkRequest || currentWorkItem || currentDecisions.length > 0 ? <>
                    {sessionWorkspaceId && <CurrentWorkBar key={currentWorkItem?.workItemId ?? currentWorkRequest?.requestId ?? workSessionId} client={store.getState().client} workspaceId={sessionWorkspaceId}
                      sourceTitle={sidebar.findSession(currentWorkRequest?.sourceSessionId ?? workSessionId ?? "")?.title ?? openSession?.title}
                      request={currentWorkRequest} item={currentWorkItem} hasDecision={currentDecisions.length > 0}
                      onOpenWorkItem={currentWorkItem ? () => store.getState().showTask({ workspaceId: sessionWorkspaceId, kind: "workItem", id: currentWorkItem.workItemId }) : undefined} />}
                    {currentDecisions.length > 0 && <section className="vm-decision-context" aria-label="决策回复">
                      {currentDecisions.length > 1 ? <Field kind="select" aria-label="选择待回复决策" compact value={currentDecision?.decisionId ?? ""}
                        onChange={(event) => setDecisionMode({ sessionId: workSessionId, decisionId: event.target.value, ordinary: false })}>
                        <option value="">选择要回复的决策</option>
                        {currentDecisions.map((card) => <option key={card.decisionId} value={card.decisionId}>{card.question}</option>)}
                      </Field> : <p className="vm-decision-context__question">{currentDecision?.question}</p>}
                      <div className="vm-decision-context__modes">
                        <Button size="sm" variant="ghost" disabled={!currentDecision} aria-pressed={answeringDecision} onClick={() => setDecisionMode({ sessionId: workSessionId, decisionId: currentDecision?.decisionId, ordinary: false })}>回复此决策</Button>
                        <Button size="sm" variant="ghost" aria-pressed={!answeringDecision} onClick={() => setDecisionMode({ sessionId: workSessionId, decisionId: currentDecision?.decisionId, ordinary: true })}>普通消息</Button>
                      </div>
                    </section>}
                  </> : undefined}
                  composerSubmitOverride={answeringDecision && currentDecision && sessionWorkspaceId ? {
                    label: "发送决策答复", placeholder: "写下你的决定…",
                    submit: async (payload) => {
                      if (payload.attachments?.length) throw new Error("决策答复使用文字；附件可切换为普通消息发送。");
                      await store.getState().client.request("decision.answer", { workspaceId: sessionWorkspaceId, decisionId: currentDecision.decisionId, note: payload.content });
                    }
                  } : undefined}
                  composerExtras={<>
                    <WorkspacePicker store={store} pickDirectory={pickDirectory} lockedWorkspaceId={sessionId ? sessionWorkspaceId : undefined} />
                    {discussionIssue && sessionWorkspaceId && <Button size="sm" variant="ghost" outlined onClick={() => store.getState().showIssue({ workspaceId: sessionWorkspaceId, issueId: discussionIssue.issueId })}>Issue</Button>}
                  </>}
                />
              </main>
              <aside className="w-[336px] shrink-0 border-l border-border-strong bg-app-shell" aria-label="文档">
                <DocsPanel store={store} onFileAction={onFileAction} primaryAction={
                  <StartWorkButton {...workTarget} composer={composerActions} onStart={async (input) => {
                    const workspaceId = sessionId ? sessionWorkspaceId : draftWorkspaceId;
                    if (!workspaceId) throw new Error("请先选择 workspace。");
                    await store.getState().client.request("work.start", { workspaceId, ...input });
                    store.getState().setDocCommit({ kind: "work", title: openSession?.title ?? "当前会话" });
                  }} />
                } />
              </aside>
            </div>
            <div className={section !== "sessions" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <div className="flex shrink-0 items-center border-b border-border px-4 py-2"><WorkspaceSwitcher store={store} /></div>
              <WorkspacePages store={store} transport={transport} pickDirectory={pickDirectory} workItemTarget={searchWorkItemTarget} onWorkItemTargetConsumed={clearSearchWorkItemTarget} />
            </div>
          </div>
        </div>
        <Modal contained presentation={overlay === "inbox" ? "modal" : panel === "inbox" ? "page" : "hidden"}
          title="Inbox" onClose={closeOverlay} onExpand={() => setPanel("inbox")}>
          <InboxPanel store={store} includeProcessed={overlay !== "inbox" && panel === "inbox"} />
        </Modal>
        <Modal contained presentation={overlay === "settings" ? "modal" : "hidden"}
          title="设置" width={640} onClose={closeOverlay}>
          <SettingsPage transport={transport} />
        </Modal>
      </div>
      </div>
      {navigationError && <InlineNotice tone="error">{navigationError}</InlineNotice>}
      <TaskStatusBar store={store} />
      <TextEditor store={store} />
      <RoleEditor store={store} transport={transport} />
      {searchOpen && <SearchDialog client={store.getState().client} onClose={() => setSearchOpen(false)} onOpenWorkItem={openSearchWorkItem} onOpenDoc={openSearchDoc} onOpenSession={openSearchSession} />}
    </div>
    </SessionNavigationContext.Provider>
  );
};
