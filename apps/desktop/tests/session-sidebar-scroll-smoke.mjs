// Run with node apps/desktop/tests/session-sidebar-scroll-smoke.mjs.
// Uses Electron's real DOM because the sidebar's scroll anchoring depends on real layout.
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "vermillion-session-sidebar-scroll-"));
try {
  const result = await build({
    stdin: {
      resolveDir: resolve("apps/desktop"),
      loader: "tsx",
      contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SessionSidebar } from "./src/ui/app/components/SessionSidebar.tsx";
const ipc = window.require("electron").ipcRenderer;
try {
  const style = document.createElement("style");
  style.textContent = ".vm-session-list { height: 220px; overflow: auto; } .vm-session-list li { height: 40px; }";
  document.head.appendChild(style);

  const ids = Array.from({ length: 24 }, (_, index) => "s" + index);
  const session = (sessionId, index) => ({
    sessionId, engineId: "engine", title: "Session " + sessionId, statusDot: "none",
    isActive: false, isPinned: false, workspaceId: "w", sortAt: String(1000 - index),
    activityAt: new Date(Date.parse("2026-09-19T00:00:00.000Z") - index * 60000).toISOString(), subagents: []
  });
  const noop = () => {};
  const props = {
    loading: false, isDraft: false, workspaceLabelById: new Map([["w", "workspace"]]),
    workspaceFilterId: "w", onWorkspaceFilter: noop, onOpen: noop, onNewChat: noop, onSearch: noop,
    menu: undefined, onOpenMenu: noop, onCloseMenu: noop, onRunAction: noop,
    renameDialog: { state: undefined, open: noop, close: noop, submit: noop },
    notice: undefined, onClearNotice: noop
  };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (order, selectedSessionId) => flushSync(() => root.render(
    <SessionSidebar {...props} sessions={order.map(session)} selectedSessionId={selectedSessionId} />
  ));
  const list = () => document.querySelector(".vm-session-list");
  const rowOf = (sessionId) => document.querySelector('[data-session-row="' + sessionId + '"]');
  const isVisible = (sessionId) => {
    const bounds = list().getBoundingClientRect();
    const row = rowOf(sessionId).getBoundingClientRect();
    return row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1;
  };
  const topRowId = () => [...document.querySelectorAll("[data-session-row]")]
    .find((row) => row.getBoundingClientRect().bottom > list().getBoundingClientRect().top + 1).dataset.sessionRow;

  // Opening a session that sits below the fold reveals its row.
  render(ids, "s18");
  if (list().scrollTop === 0 || !isVisible("s18")) throw Error("Opening a session did not reveal its row");

  // Another session's activity must not move what the reader is looking at.
  const parked = topRowId();
  const scrolled = list().scrollTop;
  render(["s23", ...ids.filter((id) => id !== "s23")], "s18");
  if (topRowId() !== parked || list().scrollTop === scrolled) throw Error("Background reorder moved the reader's rows");

  // Activity in the open session promotes it to the top, and the list follows it there.
  render(["s18", ...ids.filter((id) => id !== "s18" && id !== "s23"), "s23"], "s18");
  if (!isVisible("s18") || list().scrollTop !== 0) throw Error("Promoted open session stayed above the viewport");

  // A session opened from elsewhere is revealed even when the list has not reordered.
  render(["s18", ...ids.filter((id) => id !== "s18" && id !== "s23"), "s23"], "s23");
  if (!isVisible("s23")) throw Error("Selecting a far session did not reveal its row");

  flushSync(() => root.unmount());
  ipc.send("result", { ok: true });
} catch (error) { ipc.send("result", { error: error.stack }); }
`
    },
    bundle: true,
    write: false,
    platform: "browser",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' }
  });
  await writeFile(join(directory, "renderer.js"), result.outputFiles[0].text);
  await writeFile(join(directory, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  ipcMain.once("result", (_, result) => {
    console.log(result.error || "Session sidebar scroll smoke passed");
    app.exit(result.ok ? 0 : 1);
  });
  await window.loadURL("data:text/html,<body></body>");
  await window.webContents.executeJavaScript(fs.readFileSync(__dirname + "/renderer.js", "utf8"));
});
setTimeout(() => { console.error("Session sidebar scroll smoke timed out"); app.exit(1); }, 20000);
`);
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [join(directory, "main.cjs")], { stdio: "inherit", windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 25000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timeout); resolveExit(code); });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
