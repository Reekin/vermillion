import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Notification,
  shell,
  Tray
} from "electron";
import { createSessionRuntimeService } from "@vermillion/desktop-server";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SESSION_IPC_EVENTS_PUSH_CHANNEL,
  SESSION_IPC_MATERIALIZE_ATTACHMENT_CHANNEL,
  SESSION_IPC_PICK_ENGINE_PROGRAM_CHANNEL,
  SESSION_IPC_REQUEST_CHANNEL,
  SESSION_IPC_WRITE_CLIPBOARD_TEXT_CHANNEL,
  WORKBENCH_IPC_EVENT_CHANNEL,
  WORKBENCH_IPC_REQUEST_CHANNEL
} from "./ipc-channels.js";
import { createSessionIpcRouter } from "./session-ipc-router.js";
import { AppLauncher, Orchestrator, RoleService, WorkbenchService, createWorkbenchRpcHandler, resolveAppCommand, startLocalEndpoint, type InboxItem } from "@vermillion/workbench";
import { createAgentRunner, createSessionAsk } from "./agent-runner.js";
import { materializeAttachmentDataUri } from "./attachment-materializer.js";
import {
  resolveWillNavigate,
  resolveWindowOpenNavigation
} from "./external-navigation.js";
import {
  createElectronDiagnosticsLogger,
  createElectronRunJournal,
  isBlankRendererHealth,
  shouldReloadForChildProcessGone,
  shouldReloadForLoadFailure,
  shouldReloadForRenderProcessGone,
  type ElectronDiagnosticsLogger,
  type RendererHealthSnapshot
} from "./electron-diagnostics.js";
import { writeVerifiedClipboardText } from "./clipboard-writer.js";
import { createAgentCompletionNotifier } from "./agent-completion-notification.js";

app.setName("Vermillion");

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const appRoot = resolve(currentDir, "..");
const bundledPreloadPath = join(currentDir, "preload.cjs");
const bundledRendererIndexPath = join(appRoot, "dist-web", "index.html");
// Shipped role prompts: resources/app/roles in a release, packages/workbench/roles in the repo.
const roleDefaultsDir = [join(appRoot, "roles"), resolve(appRoot, "../../packages/workbench/roles")].find((dir) => existsSync(dir));
// CLI entry: bundled in a release, built package output in the repo.
const cliEntryPath = [join(appRoot, "cli", "vermillion.mjs"), resolve(appRoot, "../../packages/workbench/bin/vermillion.mjs")].find((path) => existsSync(path));
// Launcher script: resources/app/scripts in a release, packages/workbench in the repo.
const launcherPackageRoot = [appRoot, resolve(appRoot, "../../packages/workbench")].find((dir) => existsSync(join(dir, "scripts", "start-on-hidden-desktop.ps1")));

/** Puts a `vermillion` command on PATH for every agent process spawned from here. */
const exposeCliOnPath = (baseDir: string): void => {
  if (!cliEntryPath) return;
  const binDir = join(baseDir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(binDir, "vermillion.cmd"), "@echo off\r\nnode \"" + cliEntryPath + "\" %*\r\n", "utf8");
  } else {
    writeFileSync(join(binDir, "vermillion"), "#!/bin/sh\nexec node \"" + cliEntryPath + "\" \"$@\"\n", { encoding: "utf8", mode: 0o755 });
  }
  process.env.PATH = binDir + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "");
  process.env.VERMILLION_PERSISTENCE_BASE_DIR = baseDir;
};
const defaultDevServerUrl = "http://127.0.0.1:4173/";
const iconFileNames =
  process.platform === "win32"
    ? ["icon.ico", "icon.png"]
    : process.platform === "darwin"
      ? ["icon.icns", "icon.png"]
      : ["icon.png"];

type WindowRecoveryState = {
  isQuitting: boolean;
  reloadInFlight: boolean;
  reloadedCauses: Set<string>;
};

const diagnostics = createElectronDiagnosticsLogger();
const runJournal = createElectronRunJournal({ logger: diagnostics });
const recoveryState: WindowRecoveryState = {
  isQuitting: false,
  reloadInFlight: false,
  reloadedCauses: new Set()
};

const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: typeof error === "string" ? error : String(error)
  };
};

const collectElectronMetricsSnapshot = async (
  window?: BrowserWindow
): Promise<Record<string, unknown>> => {
  const appMetrics = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpu: {
      percentCPUUsage: metric.cpu.percentCPUUsage,
      idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond
    },
    memory: {
      workingSetSize: metric.memory.workingSetSize,
      peakWorkingSetSize: metric.memory.peakWorkingSetSize,
      privateBytes: metric.memory.privateBytes
    }
  }));
  const memoryReader = window?.webContents as
    | {
        getProcessMemoryInfo?: () => Promise<Record<string, unknown>>;
      }
    | undefined;
  const renderer = window?.isDestroyed()
    ? undefined
    : {
        osProcessId: window?.webContents.isDestroyed()
          ? undefined
          : window?.webContents.getOSProcessId(),
        url: window?.webContents.isDestroyed() ? undefined : window?.webContents.getURL(),
        memory:
          memoryReader?.getProcessMemoryInfo && !window?.webContents.isDestroyed()
            ? await memoryReader.getProcessMemoryInfo().catch((error: unknown) => ({
                unavailable: true,
                ...describeError(error)
              }))
            : undefined
      };

  return {
    appMetrics,
    renderer
  };
};

const reloadWindowOnce = (
  window: BrowserWindow,
  cause: string,
  details: Record<string, unknown>
): void => {
  if (recoveryState.isQuitting || window.isDestroyed()) {
    return;
  }
  if (recoveryState.reloadInFlight) {
    diagnostics.log({
      severity: "warning",
      source: "electron-recovery",
      message: `Skipped renderer reload for ${cause}; recovery already in progress.`,
      details
    });
    return;
  }
  if (recoveryState.reloadedCauses.has(cause)) {
    diagnostics.log({
      severity: "warning",
      source: "electron-recovery",
      message: `Skipped repeated renderer reload for ${cause}.`,
      details
    });
    return;
  }

  recoveryState.reloadedCauses.add(cause);
  recoveryState.reloadInFlight = true;
  diagnostics.log({
    severity: "warning",
    source: "electron-recovery",
    message: `Reloading renderer after ${cause}.`,
    details
  });
  setTimeout(() => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  }, 50);
};

const resetReloadGuardsAfterHealthyRenderer = (): void => {
  if (recoveryState.reloadedCauses.size === 0 && !recoveryState.reloadInFlight) {
    return;
  }
  diagnostics.log({
    source: "electron-recovery",
    message: "Renderer recovered; reset reload guards.",
    details: {
      recoveredCauses: [...recoveryState.reloadedCauses]
    }
  });
  recoveryState.reloadedCauses.clear();
  recoveryState.reloadInFlight = false;
};

const readRendererHealthScript = `
(() => {
  const root = document.getElementById("root");
  return {
    rootExists: Boolean(root),
    rootChildCount: root ? root.childElementCount : -1,
    rootTextLength: root ? root.innerText.trim().length : -1,
    bodyTextLength: document.body ? document.body.innerText.trim().length : -1,
    readyState: document.readyState,
    href: location.href
  };
})()
`;

const resolveAppIconPath = (): string | undefined => {
  const iconRoots = [join(appRoot, "dist-web", "icons"), join(appRoot, "public", "icons")];
  for (const root of iconRoots) {
    for (const fileName of iconFileNames) {
      const iconPath = join(root, fileName);
      if (existsSync(iconPath)) {
        return iconPath;
      }
    }
  }
  return undefined;
};

const checkRendererHealth = (
  window: BrowserWindow,
  cause: string,
  logger: ElectronDiagnosticsLogger
): void => {
  setTimeout(() => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    void window.webContents
      .executeJavaScript(readRendererHealthScript, true)
      .then((snapshot: RendererHealthSnapshot) => {
        logger.log({
          source: "renderer-health",
          message: "Renderer health snapshot.",
          details: {
            cause,
            ...snapshot
          }
        });
        if (isBlankRendererHealth(snapshot)) {
          reloadWindowOnce(window, `blank-renderer:${cause}`, snapshot);
        } else {
          resetReloadGuardsAfterHealthyRenderer();
        }
      })
      .catch((error: unknown) => {
        logger.log({
          severity: "error",
          source: "renderer-health",
          message: "Failed to inspect renderer health.",
          details: {
            cause,
            ...describeError(error)
          }
        });
      });
  }, 1500);
};

const installWindowDiagnostics = (
  window: BrowserWindow,
  logger: ElectronDiagnosticsLogger
): void => {
  const { webContents } = window;
  const windowId = window.id;

  window.on("close", (event) => {
    runJournal.record("Main window close requested.", {
      windowId,
      defaultPrevented: event.defaultPrevented,
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      url: webContents.getURL()
    });
  });

  window.on("closed", () => {
    runJournal.record("Main window closed.", {
      windowId
    });
  });

  webContents.on("did-finish-load", () => {
    logger.log({
      source: "renderer-load",
      message: "Renderer finished loading.",
      details: {
        url: webContents.getURL()
      }
    });
    checkRendererHealth(window, "did-finish-load", logger);
  });

  webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const details = {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      };
      logger.log({
        severity: "error",
        source: "renderer-load",
        message: "Renderer load failed.",
        details
      });
      if (shouldReloadForLoadFailure({ errorCode, isMainFrame })) {
        reloadWindowOnce(window, "did-fail-load", details);
      }
    }
  );

  webContents.on(
    "did-fail-provisional-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const details = {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      };
      logger.log({
        severity: "error",
        source: "renderer-load",
        message: "Renderer provisional load failed.",
        details
      });
      if (shouldReloadForLoadFailure({ errorCode, isMainFrame })) {
        reloadWindowOnce(window, "did-fail-provisional-load", details);
      }
    }
  );

  webContents.on("render-process-gone", (_event, details) => {
    const record = { ...details };
    void collectElectronMetricsSnapshot(window).then((snapshot) => {
      logger.log({
        severity: "error",
        source: "renderer-process",
        message: "Renderer process gone.",
        details: {
          ...record,
          snapshot
        }
      });
    });
    if (shouldReloadForRenderProcessGone(details)) {
      reloadWindowOnce(window, "render-process-gone", record);
    }
  });

  webContents.on("unresponsive", () => {
    void collectElectronMetricsSnapshot(window).then((snapshot) => {
      logger.log({
        severity: "warning",
        source: "renderer-process",
        message: "Renderer became unresponsive.",
        details: {
          url: webContents.getURL(),
          snapshot
        }
      });
    });
  });

  webContents.on("responsive", () => {
    void collectElectronMetricsSnapshot(window).then((snapshot) => {
      logger.log({
        source: "renderer-process",
        message: "Renderer became responsive again.",
        details: {
          url: webContents.getURL(),
          snapshot
        }
      });
    });
  });

  webContents.on("console-message", (event) => {
    const { level, lineNumber, message, sourceId } = event;
    if (level !== "warning" && level !== "error") {
      return;
    }
    logger.log({
      severity: level === "error" ? "error" : "warning",
      source: "renderer-console",
      message,
      details: {
        level,
        line: lineNumber,
        sourceId
      }
    });
  });

  webContents.on("preload-error", (_event, preloadPath, error) => {
    logger.log({
      severity: "error",
      source: "renderer-preload",
      message: "Preload script failed.",
      details: {
        preloadPath,
        ...describeError(error)
      }
    });
  });
};

const installAppDiagnostics = (logger: ElectronDiagnosticsLogger): void => {
  process.on("uncaughtExceptionMonitor", (error) => {
    logger.log({
      severity: "error",
      source: "main-process",
      message: "Main process uncaught exception.",
      details: describeError(error)
    });
  });

  process.on("unhandledRejection", (reason) => {
    logger.log({
      severity: "error",
      source: "main-process",
      message: "Main process unhandled rejection.",
      details: describeError(reason)
    });
  });

  app.on("child-process-gone", (_event, details) => {
    const record = { ...details };
    void collectElectronMetricsSnapshot().then((snapshot) => {
      logger.log({
        severity: "error",
        source: "electron-child-process",
        message: "Electron child process gone.",
        details: {
          ...record,
          snapshot
        }
      });
    });
    if (!shouldReloadForChildProcessGone(details)) {
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      reloadWindowOnce(window, "child-process-gone", record);
    }
  });

  app.on("before-quit", () => {
    recoveryState.isQuitting = true;
    runJournal.record("Application before-quit event received.", {
      windowCount: BrowserWindow.getAllWindows().length
    });
  });

  app.on("will-quit", () => {
    runJournal.record("Application will-quit event received.");
  });

  app.on("quit", (_event, exitCode) => {
    runJournal.finish("app-quit", { exitCode });
  });
};

const createMainWindow = (): BrowserWindow => {
  const iconPath = resolveAppIconPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f4f6fb",
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: bundledPreloadPath
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });
  installExternalNavigationHandlers(window);
  installWindowDiagnostics(window, diagnostics);

  return window;
};

const openExternalUrl = (url: string | undefined): void => {
  if (!url) {
    return;
  }
  void shell.openExternal(url);
};

const installExternalNavigationHandlers = (window: BrowserWindow): void => {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = resolveWindowOpenNavigation(url);
    if (decision.action === "deny") {
      openExternalUrl(decision.externalUrl);
    }
    return {
      action: decision.action
    };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const decision = resolveWillNavigate(url, window.webContents.getURL());
    if (decision.action === "allow") {
      return;
    }
    event.preventDefault();
    openExternalUrl(decision.externalUrl);
  });
};

const resolveRendererTarget = (): { type: "url" | "file"; value: string } => {
  const devServerUrl = process.env.VERMILLION_VITE_DEV_SERVER_URL?.trim();
  if (devServerUrl) {
    if (process.env.NODE_ENV !== "development") {
      throw new Error("VERMILLION_VITE_DEV_SERVER_URL is only allowed in development.");
    }
    const url = new URL(devServerUrl);
    if (
      url.protocol !== "http:"
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("VERMILLION_VITE_DEV_SERVER_URL must use a loopback HTTP origin.");
    }
    return { type: "url", value: url.toString() };
  }

  return { type: "file", value: bundledRendererIndexPath };
};

const loadRendererTarget = async (window: BrowserWindow): Promise<void> => {
  const target = resolveRendererTarget();
  if (target.type === "url") {
    await window.loadURL(target.value);
  } else {
    await window.webContents.session.clearCache();
    await window.loadFile(target.value, {
      search: `v=${Date.now()}`
    });
  }
};

const boot = async (): Promise<void> => {
  runJournal.start();
  installAppDiagnostics(diagnostics);
  try {
    crashReporter.start({
      productName: "Vermillion",
      companyName: "Vermillion",
      submitURL: "",
      uploadToServer: false,
      compress: false
    });
    runJournal.record("Electron crash reporter started.", {
      crashDumpsPath: app.getPath("crashDumps")
    });
  } catch (error) {
    diagnostics.logSync({
      severity: "error",
      source: "main-process-lifecycle",
      message: "Failed to start Electron crash reporter.",
      details: describeError(error)
    });
  }
  const userDataDir = process.env.VERMILLION_USER_DATA_DIR?.trim();
  if (userDataDir) {
    app.setPath("userData", userDataDir);
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const [existingWindow] = BrowserWindow.getAllWindows();
    if (!existingWindow || existingWindow.isDestroyed()) {
      return;
    }
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
  });
  const remoteDebuggingPort = process.env.VERMILLION_REMOTE_DEBUGGING_PORT?.trim();
  if (remoteDebuggingPort) {
    app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
  }
  await app.whenReady();
  app.setAppUserModelId("com.vermillion.desktop");
  const appIconPath = resolveAppIconPath();
  if (process.platform === "darwin" && appIconPath) {
    app.dock?.setIcon(appIconPath);
  }

  if (!existsSync(bundledPreloadPath)) {
    throw new Error(`Missing bundled preload asset: ${bundledPreloadPath}`);
  }

  const persistenceBaseDir =
    process.env.VERMILLION_PERSISTENCE_BASE_DIR?.trim() || join(homedir(), ".vermillion");
  exposeCliOnPath(persistenceBaseDir);

  const service = createSessionRuntimeService({
    persistenceBaseDir,
    pickWorkspaceDirectory: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "Add workspace",
        properties: ["openDirectory", "createDirectory"]
      });
      return {
        canceled: result.canceled,
        rootPath: result.filePaths[0]
      };
    },
    openFilePath: (path) => shell.openPath(path),
    revealFilePath: (path) => {
      shell.showItemInFolder(path);
    }
  });
  let window = createMainWindow();
  let completionTray: Tray | undefined;
  let completionTrayDestroyTimer: ReturnType<typeof setTimeout> | undefined;
  const focusMainWindow = (): void => {
    if (window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  };
  /** Desktop notifications only matter when the user is elsewhere; a focused window already shows the change. */
  const isInBackground = (): boolean => window.isDestroyed() || !window.isFocused();
  const showDesktopNotification = (body: string): void => {
    const title = "Vermillion";
    if (process.platform === "win32" && appIconPath) {
      if (!completionTray || completionTray.isDestroyed()) {
        completionTray = new Tray(appIconPath);
        completionTray.setToolTip("Vermillion");
        completionTray.on("balloon-click", focusMainWindow);
      }
      completionTray.displayBalloon({
        title,
        content: body,
        icon: appIconPath,
        iconType: "custom",
        largeIcon: true,
        noSound: false,
        respectQuietTime: false
      });
      if (completionTrayDestroyTimer) {
        clearTimeout(completionTrayDestroyTimer);
      }
      completionTrayDestroyTimer = setTimeout(() => {
        completionTray?.destroy();
        completionTray = undefined;
        completionTrayDestroyTimer = undefined;
      }, 12_000);
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({
      title,
      body,
      ...(appIconPath ? { icon: appIconPath } : {})
    });
    notification.on("click", focusMainWindow);
    notification.show();
  };
  const completionNotifier = createAgentCompletionNotifier({
    notify: (completed) => {
      if (!isInBackground()) {
        return;
      }
      void service
        .getSessionBrowserItem(completed.sessionId)
        .then((session) => {
          // Agent sessions (steward / worker / supervisor) finish turns all the time; only the user's own design
          // sessions are worth a desktop notification. Their outcomes surface through the Inbox instead.
          if (session && !session.role) {
            showDesktopNotification(`「${session.title}」会话已完成`);
          }
        })
        .catch((error: unknown) => {
          diagnostics.log({
            severity: "warning",
            source: "agent-completion-notification",
            message: "Skipped completion notification because session scope could not be resolved.",
            details: {
              sessionId: completed.sessionId,
              ...describeError(error)
            }
          });
        });
    }
  });
  const router = createSessionIpcRouter({
    service,
    onPush: (push) => {
      completionNotifier.handlePush(push);
      if (!window.isDestroyed()) {
        window.webContents.send(SESSION_IPC_EVENTS_PUSH_CHANNEL, push);
      }
    },
    onPushBatch: (batch) => {
      completionNotifier.handleBatch(batch);
      if (!window.isDestroyed()) {
        window.webContents.send(SESSION_IPC_EVENTS_PUSH_CHANNEL, batch);
      }
    }
  });

  ipcMain.handle(SESSION_IPC_REQUEST_CHANNEL, (_event, payload: unknown) =>
    router.handleRequest(payload)
  );
  const roleService = new RoleService({ globalDir: join(persistenceBaseDir, "roles"), defaultsDir: roleDefaultsDir });
  await roleService.ensureGlobal();
  const workbenchService = new WorkbenchService({
    roles: roleService,
    ask: createSessionAsk(service),
    launcher: new AppLauncher({ command: resolveAppCommand(appRoot), packageRoot: launcherPackageRoot }),
    workspaces: {
      list: async () =>
        (await service.listWorkspaces()).workspaces.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          rootPath: workspace.absolutePath,
          label: workspace.label,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt
        })),
      register: async (input) => {
        const workspace = await service.addWorkspace(input);
        return {
          workspaceId: workspace.workspaceId,
          rootPath: workspace.absolutePath,
          label: workspace.label,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt
        };
      },
      remove: async (workspaceId) => {
        await service.removeWorkspace(workspaceId);
      }
    }
  });
  const workbenchRpc = createWorkbenchRpcHandler(workbenchService);
  ipcMain.handle(WORKBENCH_IPC_REQUEST_CHANNEL, (_event, payload: unknown) =>
    workbenchRpc(payload as { method: string; params: unknown })
  );
  const inboxKey = (item: InboxItem): string => (item.kind === "decision" ? item.card.decisionId : item.workItem.workItemId);
  let knownInbox = new Set((await workbenchService.listInbox()).map(inboxKey));
  const unsubscribeWorkbench = workbenchService.subscribe((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(WORKBENCH_IPC_EVENT_CHANNEL, event);
    }
    if (event.type === "decisions.changed" || event.type === "workItems.changed") {
      void workbenchService.listInbox().then((items) => {
        const fresh = items.filter((item) => !knownInbox.has(inboxKey(item)));
        knownInbox = new Set(items.map(inboxKey));
        const item = fresh[0];
        if (item && isInBackground()) {
          showDesktopNotification(item.kind === "decision" ? `需要你决定：${item.card.question}` : `待验收：${item.workItem.title}`);
        }
      });
    }
  });
  const localEndpoint = await startLocalEndpoint(persistenceBaseDir, workbenchRpc);
  const orchestrator = new Orchestrator({
    service: workbenchService,
    roles: roleService,
    runner: createAgentRunner(service, "codex"),
    patrolIntervalMs: Number(process.env.VERMILLION_PATROL_INTERVAL_MS) || undefined
  });
  orchestrator.start();
  app.on("before-quit", () => {
    orchestrator.dispose();
    unsubscribeWorkbench();
    workbenchService.dispose();
    void localEndpoint.close();
  });
  ipcMain.handle(SESSION_IPC_MATERIALIZE_ATTACHMENT_CHANNEL, (_event, payload: unknown) =>
    materializeAttachmentDataUri(
      payload as Record<string, unknown>,
      join(app.getPath("userData"), "attachments", "pasted-images")
    )
  );
  ipcMain.handle(
    SESSION_IPC_PICK_ENGINE_PROGRAM_CHANNEL,
    async (_event, engineId: unknown) => {
      const result = await dialog.showOpenDialog(window, {
        title: `Select ${String(engineId)} program`,
        properties: ["openFile"]
      });
      return {
        canceled: result.canceled,
        path: result.filePaths[0]
      };
    }
  );
  ipcMain.handle(
    SESSION_IPC_WRITE_CLIPBOARD_TEXT_CHANNEL,
    (_event, text: unknown) => {
      if (typeof text !== "string") {
        throw new TypeError("Clipboard text must be a string.");
      }
      writeVerifiedClipboardText(clipboard, diagnostics, text);
    }
  );

  await loadRendererTarget(window);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      window = createMainWindow();
      await loadRendererTarget(window);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.once("will-quit", () => {
    if (completionTrayDestroyTimer) {
      clearTimeout(completionTrayDestroyTimer);
    }
    completionTray?.destroy();
    ipcMain.removeHandler(SESSION_IPC_REQUEST_CHANNEL);
    ipcMain.removeHandler(SESSION_IPC_MATERIALIZE_ATTACHMENT_CHANNEL);
    ipcMain.removeHandler(SESSION_IPC_PICK_ENGINE_PROGRAM_CHANNEL);
    ipcMain.removeHandler(SESSION_IPC_WRITE_CLIPBOARD_TEXT_CHANNEL);
    void router.dispose();
  });
};

process.once("exit", (exitCode) => {
  runJournal.finish("process-exit", { exitCode });
});

void boot().catch((error) => {
  diagnostics.logSync({
    severity: "error",
    source: "main-process",
    message: "Failed to boot Electron app.",
    details: describeError(error)
  });
  console.error(error);
  app.exit(1);
});
