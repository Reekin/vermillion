// Run with node apps/desktop/tests/renderer-selection-smoke.mjs.
// Uses Electron's real DOM without adding a simulated DOM dependency.
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "vermillion-renderer-selection-"));
try {
  const result = await build({
    stdin: {
      resolveDir: resolve("apps/desktop"),
      loader: "tsx",
      contents: `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { parseDomainSnapshot } from "@vermillion/shared";
import { createRendererStore } from "./src/store/store.ts";
import { useRendererSessionSelection, useRendererVisibleTurnsRevision,
  useRendererConversationParticipants, useRendererStoreState } from "./src/ui/chat-shell/use-renderer-store-state.ts";
const ipc = window.require("electron").ipcRenderer;
try {
  const store = createRendererStore();
  const now = "2026-09-10T00:00:00.000Z";
  store.hydrateSnapshot(parseDomainSnapshot({
    conversations: [{ conversationId: "c", participantEngineIds: ["engine"],
      sessionIds: ["s"], createdAt: now, updatedAt: now }],
    sessions: [{ sessionId: "s", conversationId: "c", engineId: "engine",
      status: "running", lastTurnId: "hidden", createdAt: now, updatedAt: now }],
    turns: [{ turnId: "visible", sessionId: "s", status: "completed", startedAt: now },
      { turnId: "hidden", sessionId: "s", status: "streaming", startedAt: now }],
    participants: [{ participantId: "p", conversationId: "c", engineId: "engine",
      role: "primary", capabilities: ["chat"], activeSessionIds: ["s"] }]
  }));
  store.ingestEvent({ type: "session.created", sessionId: "sibling", conversationId: "c",
    engineId: "engine", status: "running" });
  let sequence = 0;
  const emit = (turnId, delta, sessionId = "s") => flushSync(() => {
    sequence++;
    store.ingestEnvelope({ eventId: "delta-" + sequence, cursor: "cursor-" + sequence,
      occurredAt: new Date(Date.parse(now) + sequence * 1000).toISOString(),
      event: { type: "message.delta", sessionId, turnId, messageId: turnId, delta }
    });
  });
  // Establish both lastTurnIds before measuring; subsequent deltas only reorder
  // the same participant's active sessions by their updated timestamps.
  emit("hidden", "");
  emit("sibling-turn", "", "sibling");
  let renders = 0;
  let selected;
  let pendingApprovals;
  function Pane({ turnId }) {
    renders++;
    useRendererStoreState(store);
    const [draft] = useState("draft survives navigation");
    selected = useRendererSessionSelection(store, "s", () => ({
      session: store.getDomainReadModel().getSession("s")
    }), ({ session }) => {
      const { updatedAt, ...controls } = session;
      return JSON.stringify(controls);
    });
    useRendererConversationParticipants(store, "c");
    pendingApprovals = useRendererSessionSelection(store, "s", () =>
      store.getDomainReadModel().listApprovalRequests().filter((approval) =>
        approval.sessionId === "s" && approval.turnId === turnId && approval.status === "pending"));
    useRendererVisibleTurnsRevision(store, [turnId]);
    const text = store.getDomainReadModel().getMessageBlock(turnId + ":md")?.text ?? "";
    return <div><output>{text}</output><input value={draft} readOnly /></div>;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  flushSync(() => root.render(<Pane turnId="visible" />));
  const initialRenders = renders;
  const initialSelection = selected;
  const initialTimestamp = selected.session.updatedAt;
  const participantOrder = () => store.getDomainReadModel().listParticipants({ conversationId: "c" })
    .find((participant) => participant.participantId === "p").activeSessionIds.join(",");
  const initialOrder = participantOrder();
  emit("hidden", "background ");
  if (participantOrder() === initialOrder) throw Error("Fixture did not reorder participant sessions");
  emit("sibling-turn", "sibling ", "sibling");
  emit("hidden", "output");
  emit("sibling-turn", "output", "sibling");
  if (renders !== initialRenders) throw Error("Alternating hidden sessions rendered current pane");
  if (store.getDomainReadModel().getMessageBlock("sibling-turn:md")?.text !== "sibling output")
    throw Error("Sibling output was lost");
  if (selected !== initialSelection) throw Error("Timestamp-only change replaced selection");
  if (selected.session.updatedAt !== initialTimestamp) throw Error("Cached original selection was mutated");
  flushSync(() => root.render(<Pane turnId="hidden" />));
  if (document.querySelector("output").textContent !== "background output") throw Error("Jump lost output");
  emit("hidden", " live");
  if (document.querySelector("output").textContent !== "background output live") throw Error("Visible delta missing");
  const beforeApproval = renders;
  flushSync(() => store.ingestEvent({ type: "approval.requested", sessionId: "s",
    turnId: "hidden", requestId: "approval", approvalKind: "command", title: "Allow command?", participantId: "p" }));
  if (renders === beforeApproval || pendingApprovals.length !== 1 ||
      selected.session.status !== "awaiting_approval") throw Error("Approval request stale");
  const beforeResolution = renders;
  flushSync(() => store.ingestEvent({ type: "approval.resolved", sessionId: "s",
    turnId: "hidden", requestId: "approval", action: "approve", participantId: "p" }));
  if (renders === beforeResolution || pendingApprovals.length !== 0) throw Error("Approval resolution stale");
  const beforeStatus = renders;
  flushSync(() => store.ingestEvent({ type: "turn.completed", sessionId: "s",
    turnId: "hidden", finishReason: "completed" }));
  if (renders === beforeStatus || selected.session.status !== "idle") throw Error("Lifecycle status stale");
  if (document.querySelector("input").value !== "draft survives navigation") throw Error("Draft lost");
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
    console.log(result.error || "Renderer selection smoke passed");
    app.exit(result.ok ? 0 : 1);
  });
  await window.loadURL("data:text/html,<body></body>");
  await window.webContents.executeJavaScript(fs.readFileSync(__dirname + "/renderer.js", "utf8"));
});
setTimeout(() => { console.error("Renderer selection smoke timed out"); app.exit(1); }, 20000);
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
