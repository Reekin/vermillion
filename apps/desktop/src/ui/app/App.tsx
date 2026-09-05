import { useCallback, useEffect, useMemo } from "react";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { ChatShellApp } from "../chat-shell/ChatShellApp.js";
import { DocEditor } from "./components/DocEditor.js";
import { DocsPanel } from "./components/DocsPanel.js";
import { InboxPanel } from "./components/InboxPanel.js";
import { Modal } from "./components/Modal.js";
import { Rail } from "./components/Rail.js";
import { SessionList } from "./components/SessionList.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { WorkspacesPanel } from "./components/WorkspacesPanel.js";
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
  const activeWorkspaceId = store((s) => s.activeWorkspaceId);
  const workspaceRevision = store((s) => s.workspaceRevision);
  const setPanel = store((s) => s.setPanel);
  const openOverlay = store((s) => s.openOverlay);
  const closeOverlay = store((s) => s.closeOverlay);
  const selectWorkspace = store((s) => s.selectWorkspace);
  const refreshWorkspaces = store((s) => s.refreshWorkspaces);
  const refreshInbox = store((s) => s.refreshInbox);

  useEffect(() => {
    void refreshWorkspaces();
    void refreshInbox();
    const timer = setInterval(() => {
      void refreshWorkspaces();
      void refreshInbox();
    }, 4000);
    return () => clearInterval(timer);
  }, [refreshWorkspaces, refreshInbox]);

  // 思考 is the home page; everything else opens as an overlay first, expands to a page on request.
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

  const workspaceLabelById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w.label])), [workspaces]);
  const workspaceRootById = useMemo(() => new Map(workspaces.map((w) => [w.workspaceId, w.rootPath])), [workspaces]);

  const renderPanel = (target: Panel) =>
    target === "inbox" ? <InboxPanel store={store} /> : <WorkspacesPanel store={store} pickDirectory={pickDirectory} />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-page-canvas text-foreground">
      <Rail panel={panel} overlay={overlay} inboxCount={inboxCount} onSelect={onSelect} />
      <div className="relative min-w-0 flex-1">
        {/* The session shell stays mounted so switching panels never loses chat state. */}
        <div className={panel === "think" ? "vm-think" : "vm-think hidden"}>
          <ChatShellApp
            store={sessionStore}
            transport={transport}
            hideSettings
            externalRefreshSignal={workspaceRevision}
            sidebarHeader={<header className="px-4 pt-3"><span className="eyebrow">思考</span></header>}
            renderSidebarBody={(context) => (
              <SessionList {...context} activeWorkspaceId={activeWorkspaceId} workspaceLabelById={workspaceLabelById} />
            )}
            composerExtras={<WorkspacePicker store={store} pickDirectory={pickDirectory} />}
            createSessionMetadata={(workspaceId) => {
              const root = workspaceRootById.get(workspaceId);
              return root ? { cwd: root.replace(/[\\/]+$/, "") + "/.vermillion" } : undefined;
            }}
            onDisplayedWorkspaceChange={(workspaceId) => {
              if (workspaceId && workspaceId !== activeWorkspaceId) void selectWorkspace(workspaceId);
            }}
            renderDetail={({ activeSessionId }) => <DocsPanel store={store} activeSessionId={activeSessionId} onFileAction={onFileAction} />}
          />
        </div>
        {panel !== "think" && (
          <div className="flex h-full flex-col">
            <header className="flex h-10 items-center border-b border-border px-4"><h1 className="text-title-sm font-medium text-strong">{panelTitles[panel]}</h1></header>
            <div className="min-h-0 flex-1 overflow-auto">{renderPanel(panel)}</div>
          </div>
        )}
      </div>
      {overlay && (
        <Modal title={panelTitles[overlay]} onClose={closeOverlay} onExpand={() => setPanel(overlay)}>
          {renderPanel(overlay)}
        </Modal>
      )}
      <DocEditor store={store} />
    </div>
  );
};
