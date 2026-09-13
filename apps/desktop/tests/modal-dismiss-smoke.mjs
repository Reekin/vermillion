// Run with node apps/desktop/tests/modal-dismiss-smoke.mjs.
// Uses Electron's real DOM to preserve pointer/click retargeting behavior.
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "vermillion-modal-dismiss-"));
try {
  const result = await build({
    stdin: {
      resolveDir: resolve("apps/desktop"),
      loader: "tsx",
      contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Modal } from "./src/ui/app/components/Modal.tsx";
const ipc = window.require("electron").ipcRenderer;
try {
  let closes = 0;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = () => flushSync(() => root.render(
    <Modal title="Document" onClose={() => closes++}><span id="text">select this text</span></Modal>
  ));
  const backdrop = () => document.querySelector('[role="presentation"]');
  const pointerDown = (target) => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const click = (target) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

  render();
  pointerDown(document.querySelector("#text"));
  click(backdrop());
  if (closes !== 0) throw Error("Dragging from dialog content to backdrop dismissed the modal");

  pointerDown(backdrop());
  click(backdrop());
  if (closes !== 1) throw Error("A complete backdrop click did not dismiss the modal");

  render();
  document.querySelector('button[aria-label="关闭"]').click();
  if (closes !== 2) throw Error("The close button did not dismiss the modal");

  render();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (closes !== 3) throw Error("Escape did not dismiss the modal");

  flushSync(() => root.unmount());
  ipc.send("result", { ok: true });
} catch (error) { ipc.send("result", { error: error.stack }); }
`
    },
    bundle: true,
    write: false,
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' }
  });
  await writeFile(join(directory, "renderer.js"), result.outputFiles[0].text);
  await writeFile(join(directory, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  ipcMain.once("result", (_, result) => {
    console.log(result.error || "Modal dismiss smoke passed");
    app.exit(result.ok ? 0 : 1);
  });
  await window.loadURL("data:text/html,<body></body>");
  await window.webContents.executeJavaScript(fs.readFileSync(__dirname + "/renderer.js", "utf8"));
});
setTimeout(() => { console.error("Modal dismiss smoke timed out"); app.exit(1); }, 20000);
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
