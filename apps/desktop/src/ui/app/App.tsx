import { useCallback, useEffect, useMemo, useState } from "react";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { SessionPane } from "../chat-shell/SessionPane.js";
import { DocsPanel } from "./components/DocsPanel.js";
import { InboxPanel } from "./components/InboxPanel.js";
import { Modal } from "./components/Modal.js";
import { Rail } from "./components/Rail.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { TextEditor } from "./components/TextEditor.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { WorkspacesPanel } from "./components/WorkspacesPanel.js";
import { useSessionSidebar } from "./use-session-sidebar.js";
import { useSessionActions } from "./use-session-actions.js";
import { createWorkbenchStore, type Panel } from "./workbench-store.js";
import { createRendererWorkbenchClient } from "./workbench-client.js";
import "./app.css";

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
  const workspaceIds = useMemo(() => workspaces.map((w) => w.workspaceId), [workspaces]);
  // Think shows only the user's own design sessions; agent sessions live under Workspaces → 会话.
  const sidebar = useSessionSidebar({ transport, store: sessionStore, workspaceIds, kind: "user" });
  const workspaceLabelById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w.label])), [workspaces]);
  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w])), [workspaces]);
  const [reloadSignal, setReloadSignal] = useState(0);
  const sessionActions = useSessionActions({
    transport,
    reloadSidebar: sidebar.reload,
    onForked: setSessionId,
    onArchived: (id) => setSessionId((current) => (current === id ? undefined : current)),
    onResumed: () => setReloadSignal((n) => n + 1)
  });

  // Docs panel follows the open session's workspace; in draft it follows the picker.
  const openSession = sessionId ? sidebar.findSession(sessionId) : undefined;
  useEffect(() => {
    browseWorkspace(sessionId ? openSession?.workspaceId : draftWorkspaceId);
  }, [sessionId, openSession?.workspaceId, draftWorkspaceId, browseWorkspace]);

  const createSession = useCallback(
    async ({ content, attachments }: { content: string; attachments: import("@vermillion/shared").Attachment[] }) => {
      const workspace = draftWorkspaceId ? workspaceById.get(draftWorkspaceId) : undefined;
      if (!workspace) throw new Error("请先在 Composer 里选择一个 workspace。");
      const engineId = (await transport.engine.list()).find((e) => e.engineId === "codex")?.engineId ?? "codex";
      const role = await store.getState().client.request("role.resolve", { workspaceId: workspace.workspaceId, roleId: "design-partner" });
      const created = await transport.sessionBrowser.create({
        workspaceId: workspace.workspaceId,
        engineId,
        metadata: { cwd: workspace.rootPath, developerInstructions: role.content + "\n\n当前 workspaceId: " + workspace.workspaceId + "\n工作台 CLI: vermillion <method> [json]（PATH 中可用）\n" }
      });
      void content;
      void attachments;
      setSessionId(created.sessionId);
      return created.sessionId;
    },
    [draftWorkspaceId, workspaceById, transport, store]
  );

  const onSelect = useCallback(
    (next: Panel) => {
      if (next === "think") setPanel("think");
      else if (panel === next) setPanel(next);
      else openOverlay(next);
    },
    [panel, setPanel, openOverlay]
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
    target === "inbox" ? <InboxPanel store={store} /> : <WorkspacesPanel store={store} transport={transport} sessionStore={sessionStore} pickDirectory={pickDirectory} compact={compact} />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-page-canvas text-foreground">
      <Rail panel={panel} overlay={overlay} inboxCount={inboxCount} onSelect={onSelect} />
      <div className="relative min-w-0 flex-1">
        {/* The think page stays mounted so switching panels never loses chat state. */}
        <div className={panel === "think" ? "flex h-full" : "hidden"}>
          <SessionSidebar
            {...sidebar}
            selectedSessionId={sessionId}
            isDraft={sessionId === undefined}
            workspaceLabelById={workspaceLabelById}
            onOpen={setSessionId}
            onNewChat={() => setSessionId(undefined)}
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
              composerExtras={<WorkspacePicker store={store} pickDirectory={pickDirectory} lockedWorkspaceId={sessionId ? openSession?.workspaceId : undefined} />}
            />
          </main>
          <aside className="w-[336px] shrink-0 border-l border-border-strong bg-app-shell" aria-label="Docs">
            <DocsPanel store={store} activeSessionId={sessionId} onFileAction={onFileAction} />
          </aside>
        </div>
        {panel !== "think" && (
          <div className="flex h-full flex-col">
            <header className="flex h-10 items-center border-b border-border px-4"><h1 className="text-title-sm font-medium text-strong">{panelTitles[panel]}</h1></header>
            <div className="min-h-0 flex-1 overflow-auto">{renderPanel(panel, false)}</div>
          </div>
        )}
      </div>
      {overlay && (
        <Modal title={panelTitles[overlay]} onClose={closeOverlay} onExpand={() => setPanel(overlay)}>
          {renderPanel(overlay, true)}
        </Modal>
      )}
      <TextEditor store={store} />
    </div>
  );
};
