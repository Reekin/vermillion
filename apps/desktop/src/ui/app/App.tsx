import { useCallback, useEffect, useMemo, useState } from "react";
import { mergeSessionExecutionProfile, resolveEngineExecutionPreference } from "@vermillion/shared";
import type { SessionExecutionProfileInput } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { SessionPane } from "../chat-shell/SessionPane.js";
import { WorkbenchChatTree } from "./components/WorkbenchChatTree.js";
import { DocsPanel } from "./components/DocsPanel.js";
import { StartWorkButton } from "./components/StartWorkButton.js";
import { InboxPanel } from "./components/InboxPanel.js";
import { Modal } from "./components/Modal.js";
import { Rail } from "./components/Rail.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { TextEditor } from "./components/TextEditor.js";
import { RoleEditor } from "./components/RoleEditor.js";
import { TaskStatusBar } from "./components/TaskStatusBar.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { InlineNotice } from "./components/ui.js";
import { WorkspacesPanel, WorkspacesSwitcher } from "./components/WorkspacesPanel.js";
import { useSessionSidebar } from "./use-session-sidebar.js";
import { useSessionActions } from "./use-session-actions.js";
import { createWorkbenchStore, type Panel } from "./workbench-store.js";
import { createRendererWorkbenchClient } from "./workbench-client.js";
import "./app.css";
import { SessionNavigationContext, renderSessionNavigation } from "./session-navigation.js";
import type { SessionNavigation } from "@vermillion/workbench/client";

type AppProps = {
  sessionStore: RendererStore;
  transport: DesktopTransport;
};

const panelTitles: Record<Panel, string> = { think: "思考", inbox: "Inbox", workspaces: "Workspaces" };


export const App = ({ sessionStore, transport }: AppProps) => {
  const store = useMemo(() => createWorkbenchStore(createRendererWorkbenchClient()), []);
  const panel = store((s) => s.panel);
  const overlay = store((s) => s.overlay);
  const inboxCount = store((s) => s.inbox.length);
  const workspaces = store((s) => s.workspaces);
  const draftWorkspaceId = store((s) => s.draftWorkspaceId);
  const setPanel = store((s) => s.setPanel);
  const openOverlay = store((s) => s.openOverlay);
  const closeOverlay = store((s) => s.closeOverlay);
  const browseWorkspace = store((s) => s.browseWorkspace);
  const connect = store((s) => s.connect);

  useEffect(() => connect(), [connect]);

  /** undefined = draft: the next message creates a session in draftWorkspaceId. */
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [workTarget, setWorkTarget] = useState<{ sessionId?: string; turnId?: string }>({});
  const [navigationTarget, setNavigationTarget] = useState<{ sessionId: string; workspaceId: string }>();
  const [navigationError, setNavigationError] = useState<string>();
  const openSessionTarget = useCallback(async (workspaceId: string, targetSessionId: string, turnId?: string) => {
    const tree = await transport.chatTree.get(targetSessionId);
    const rootId = tree.treeId ?? targetSessionId;
    const { page } = await transport.sessionBrowser.open(rootId);
    const root = page.snapshot.sessions.find((session) => session.sessionId === rootId);
    await transport.sessionBrowser.activate(targetSessionId, { focusTree: true });
    if (turnId) await transport.chatTree.jump({ sessionId: targetSessionId, nodeId: turnId });
    if (!root?.metadata?.role || root.metadata.role === "design-partner") {
      setNavigationTarget({ sessionId: targetSessionId, workspaceId });
      setSessionId(targetSessionId);
      setReloadSignal((value) => value + 1);
      store.getState().browseWorkspace(workspaceId);
      store.getState().setPanel("think");
    } else {
      store.getState().browseWorkspace(workspaceId);
      store.setState({ agentSessionId: targetSessionId, workspaceSection: "sessions", panel: "workspaces", overlay: undefined });
    }
  }, [store, transport]);
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
  const workspaceIds = useMemo(() => workspaces.map((w) => w.workspaceId), [workspaces]);
  // Think shows only the user's own design sessions; agent sessions live under Workspaces → 会话.
  const sidebar = useSessionSidebar({ transport, store: sessionStore, workspaceIds, kind: "user" });
  const workspaceLabelById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w.label])), [workspaces]);
  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w])), [workspaces]);
  const [reloadSignal, setReloadSignal] = useState(0);
  const sessionActions = useSessionActions({
    transport,
    reloadSidebar: sidebar.reload,
    onArchived: (id) => setSessionId((current) => (current === id || (current && sidebar.findSession(current)?.sessionId === id) ? undefined : current)),
    onResumed: () => setReloadSignal((n) => n + 1)
  });

  // Docs panel follows the open session's workspace; in draft it follows the picker.
  const openSession = sessionId ? sidebar.findSession(sessionId) : undefined;
  const sessionWorkspaceId = openSession?.workspaceId ?? (navigationTarget?.sessionId === sessionId ? navigationTarget?.workspaceId : undefined);
  useEffect(() => {
    if (panel === "think") browseWorkspace(sessionId ? sessionWorkspaceId : draftWorkspaceId);
  }, [panel, sessionId, sessionWorkspaceId, draftWorkspaceId, browseWorkspace]);

  const [draftRevision, setDraftRevision] = useState(0);
  const initializeDraftExecution = useCallback(async () => {
    const settings = await transport.settings.get();
    const role = draftWorkspaceId
      ? await store.getState().client.request("role.resolve", { workspaceId: draftWorkspaceId, roleId: "design-partner" })
      : undefined;
    return mergeSessionExecutionProfile(
      resolveEngineExecutionPreference(settings.executionPreferencesByEngineId.codex),
      role?.modelConfig
    );
  }, [draftWorkspaceId, draftRevision, transport, store]);

  const createSession = useCallback(
    async ({ execution }: { execution?: SessionExecutionProfileInput }) => {
      const workspace = draftWorkspaceId ? workspaceById.get(draftWorkspaceId) : undefined;
      if (!workspace) throw new Error("请先在 Composer 里选择一个 workspace。");
      const engineId = (await transport.engine.list()).find((e) => e.engineId === "codex")?.engineId ?? "codex";
      const role = await store.getState().client.request("role.resolve", { workspaceId: workspace.workspaceId, roleId: "design-partner" });
      const created = await transport.sessionBrowser.create({
        workspaceId: workspace.workspaceId,
        engineId,
        sessionProfile: execution,
        metadata: { cwd: workspace.rootPath, developerInstructions: role.content + "\n\n当前 workspaceId: " + workspace.workspaceId + "\n工作台 CLI: vermillion <method> [json]（PATH 中可用）\n" }
      });
      setSessionId(created.sessionId);
      return created.sessionId;
    },
    [draftWorkspaceId, workspaceById, transport, store]
  );

  const onSelect = useCallback(
    (next: Panel) => {
      if (next === "think") setPanel("think");
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

  const renderPanel = (target: Panel, compact: boolean) =>
    target === "inbox" ? <InboxPanel store={store} /> : <WorkspacesPanel store={store} transport={transport} sessionStore={sessionStore} pickDirectory={pickDirectory} compact={compact} onExpand={() => store.getState().showTaskBoard()} />;

  return (
    <SessionNavigationContext.Provider value={navigation}>
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-page-canvas text-foreground">
      <div className="flex min-h-0 flex-1">
      <Rail panel={panel} overlay={overlay} inboxCount={inboxCount} onSelect={onSelect} onOpenPage={setPanel} />
      <div className="relative min-w-0 flex-1">
        {/* The think page stays mounted so switching panels never loses chat state. */}
        <div className={panel === "think" ? "flex h-full" : "hidden"}>
          <SessionSidebar
            {...sidebar}
            selectedSessionId={sessionId}
            isDraft={sessionId === undefined}
            workspaceLabelById={workspaceLabelById}
            onOpen={setSessionId}
            onNewChat={() => { setSessionId(undefined); setDraftRevision((n) => n + 1); }}
            menu={sessionActions.menu}
            onOpenMenu={(event, id) => void sessionActions.openMenu(event, id)}
            onCloseMenu={sessionActions.closeMenu}
            onRunAction={(id, action) => void sessionActions.run(id, action)}
            notice={sessionActions.notice}
            onClearNotice={sessionActions.clearNotice}
          />
          <main className="relative min-w-0 flex-1">
            <SessionPane
              store={sessionStore}
              transport={transport}
              sessionId={sessionId}
              reloadSignal={reloadSignal}
              createSession={createSession}
              initializeDraftExecution={initializeDraftExecution}
              onViewChange={setWorkTarget}
              renderTurnNavigation={renderSessionNavigation}
              renderChatTree={(props) => <WorkbenchChatTree {...props} client={store.getState().client} />}
              composerExtras={
                <WorkspacePicker store={store} pickDirectory={pickDirectory} lockedWorkspaceId={sessionId ? sessionWorkspaceId : undefined} />
              }
            />
          </main>
          <aside className="w-[336px] shrink-0 border-l border-border-strong bg-app-shell" aria-label="Docs">
            <DocsPanel store={store} onFileAction={onFileAction} primaryAction={
              <StartWorkButton {...workTarget} onStart={async (input) => {
                if (!sessionWorkspaceId) throw new Error("请先选择会话。");
                await store.getState().client.request("work.start", { workspaceId: sessionWorkspaceId, ...input });
                store.getState().setDocCommit({ kind: "work", title: openSession?.title ?? "当前会话" });
              }} />
            } />
          </aside>
        </div>
        {(["inbox", "workspaces"] as const).map((target) => (
          <Modal key={target} contained presentation={overlay === target ? "modal" : panel === target ? "page" : "hidden"}
            title={panelTitles[target]} titleContent={target === "workspaces" ? <WorkspacesSwitcher store={store} /> : undefined}
            width={target === "workspaces" ? 900 : undefined} onClose={closeOverlay} onExpand={() => setPanel(target)}>
            {renderPanel(target, overlay === target || panel !== target)}
          </Modal>
        ))}
      </div>
      </div>
      {navigationError && <InlineNotice tone="error">{navigationError}</InlineNotice>}
      <TaskStatusBar store={store} />
      <TextEditor store={store} />
      <RoleEditor store={store} transport={transport} />
    </div>
    </SessionNavigationContext.Provider>
  );
};
