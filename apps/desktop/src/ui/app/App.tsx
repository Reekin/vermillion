import { useCallback, useEffect, useMemo, useState } from "react";
import { mergeSessionExecutionProfile, resolveEngineExecutionPreference } from "@vermillion/shared";
import type { SessionExecutionProfileInput } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { SessionPane } from "../chat-shell/SessionPane.js";
import { DocsPanel } from "./components/DocsPanel.js";
import { InboxPanel } from "./components/InboxPanel.js";
import { Modal } from "./components/Modal.js";
import { Rail } from "./components/Rail.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { TextEditor } from "./components/TextEditor.js";
import { RoleEditor } from "./components/RoleEditor.js";
import { TaskStatusBar } from "./components/TaskStatusBar.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { ConfigurationSelect, InlineNotice } from "./components/ui.js";
import { useThinkMode } from "./use-think-mode.js";
import { WorkspacesPanel, WorkspacesSwitcher } from "./components/WorkspacesPanel.js";
import { useSessionSidebar } from "./use-session-sidebar.js";
import { useSessionActions } from "./use-session-actions.js";
import { createWorkbenchStore, type Panel } from "./workbench-store.js";
import { createRendererWorkbenchClient } from "./workbench-client.js";
import "./app.css";
import { SessionNavigationContext } from "./session-navigation.js";
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
  const [navigationTarget, setNavigationTarget] = useState<{ sessionId: string; workspaceId: string }>();
  const navigation = useMemo(() => ({
    client: store.getState().client,
    open: (target: SessionNavigation) => {
      if (target.role === "design-partner") {
        setNavigationTarget({ sessionId: target.targetSessionId, workspaceId: target.targetWorkspaceId });
        setSessionId(target.targetSessionId);
        store.getState().browseWorkspace(target.targetWorkspaceId);
        store.getState().setPanel("think");
      } else {
        store.getState().showAgentSession(target.targetWorkspaceId, target.targetSessionId);
      }
    }
  }), [store]);
  const thinkMode = useThinkMode(transport, sessionId);
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
      await transport.chatTree.setMode({ sessionId: created.sessionId, mode: thinkMode.mode });
      setSessionId(created.sessionId);
      return created.sessionId;
    },
    [draftWorkspaceId, workspaceById, transport, store, thinkMode.mode]
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
              getSendOptions={thinkMode.getSendOptions}
              composerExtras={<>
                <WorkspacePicker store={store} pickDirectory={pickDirectory} lockedWorkspaceId={sessionId ? sessionWorkspaceId : undefined} />
                <ConfigurationSelect label="模式" aria-label="模式" value={thinkMode.mode} disabled={!thinkMode.ready}
                  onChange={(event) => void thinkMode.choose(event.target.value as import("@vermillion/shared").ThinkMode)}>
                  <option value="dispatch">发单</option>
                  <option value="execute">现做</option>
                </ConfigurationSelect>
                {thinkMode.error && <InlineNotice tone="error">{thinkMode.error}</InlineNotice>}
              </>}
            />
          </main>
          <aside className="w-[336px] shrink-0 border-l border-border-strong bg-app-shell" aria-label="Docs">
            <DocsPanel store={store} activeSessionId={sessionId} onFileAction={onFileAction} />
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
      <TaskStatusBar store={store} />
      <TextEditor store={store} />
      <RoleEditor store={store} transport={transport} />
    </div>
    </SessionNavigationContext.Provider>
  );
};
