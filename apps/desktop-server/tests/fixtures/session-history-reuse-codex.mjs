// Configure the isolated engine as node.exe with this file as its first argument.
// VERMILLION_HISTORY_REUSE_PROJECT must match the workspace registered by `seed`.
import readline from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeThreads } from "./session-history-reuse-data.mjs";

const cwd = process.env.VERMILLION_HISTORY_REUSE_PROJECT;
if (!cwd) throw new Error("VERMILLION_HISTORY_REUSE_PROJECT is required");
const threads = makeThreads(cwd);
const forkTips = new Map(threads.map((thread) => [thread.id, thread.turns.at(-1)]));
const codexHome = join(cwd, ".history-reuse-codex");
await mkdir(codexHome, { recursive: true });
for (const thread of threads) {
  thread.path = join(codexHome, `${thread.id}.jsonl`);
  const records = [{ timestamp: new Date(thread.createdAt * 1000).toISOString(), type: "session_meta",
    payload: { id: thread.id, cwd } }];
  for (const turn of thread.turns) {
    const timestamp = new Date(turn.startedAt * 1000).toISOString();
    records.push({ timestamp, type: "turn_context", payload: { turn_id: turn.id, cwd } });
    records.push({ timestamp, type: "response_item", payload: { type: "message", role: "user",
      content: turn.items[0].content.map((item) => item.type === "text"
        ? { type: "input_text", text: item.text } : { type: "input_image", image_url: item.url }) } });
    records.push({ timestamp, type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: turn.items[1].text }] } });
  }
  // A fixture process restart preserves the source identity used by history freshness checks.
  try { await writeFile(thread.path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
const send = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const streams = new Map();
const metadata = (thread) => ({ ...thread, turns: [], status: { type: streams.has(thread.id) ? "active" : "notLoaded" } });
const complete = (thread, status = "completed") => {
  const stream = streams.get(thread.id);
  if (!stream) return;
  clearInterval(stream.timer);
  streams.delete(thread.id);
  stream.turn.status = status;
  stream.turn.completedAt = Math.floor(Date.now() / 1000);
  notify("item/completed", { threadId: thread.id, turnId: stream.turn.id, item: stream.item });
  notify("turn/completed", { threadId: thread.id, turn: stream.turn });
  notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
};
const history = (thread) => ({ ...thread, turns: [
  ...(thread.forkedFromId ? [forkTips.get(thread.forkedFromId)] : []),
  ...thread.turns
] });
const handle = ({ id, method, params = {} }) => {
  if (id === undefined) return;
  const thread = threads.find((item) => item.id === params.threadId);
  switch (method) {
    case "initialize": return send(id, { userAgent: "history-reuse-fixture/1", codexHome,
      platformFamily: process.platform, platformOs: process.platform });
    case "thread/list": return send(id, { data: threads.filter((item) => !params.cwd || item.cwd === params.cwd).map(metadata),
      nextCursor: null, backwardsCursor: null });
    case "thread/read": return send(id, { thread: params.includeTurns ? history(thread) : metadata(thread) });
    case "thread/resume": return send(id, { thread: history(thread), model: "gpt-5.6-luna", modelProvider: "fixture",
      serviceTier: "standard", cwd, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "max", multiAgentMode: "explicitRequestOnly" });
    case "thread/turns/list": return send(id, { data: history(thread).turns, nextCursor: null, backwardsCursor: null });
    case "thread/goal/get": return send(id, { goal: null });
    case "thread/inject_items": return send(id, {});
    case "skills/list": return send(id, { data: [{ cwd, skills: [], errors: [] }] });
    case "turn/start": {
      const turnId = `history-live-${Date.now()}`;
      const item = { type: "agentMessage", id: `${turnId}-assistant`, text: "", phase: null, memoryCitation: null };
      const turn = { id: turnId, status: "inProgress", startedAt: Math.floor(Date.now() / 1000),
        completedAt: null, error: null, items: [{ type: "userMessage", id: `${turnId}-user`,
          clientId: params.clientMessageId, content: params.input ?? [] }, item] };
      thread.turns.push(turn);
      send(id, { turn });
      notify("thread/status/changed", { threadId: thread.id, status: { type: "active" } });
      notify("turn/started", { threadId: thread.id, turn });
      notify("item/started", { threadId: thread.id, turnId, item });
      let tick = 0;
      const timer = setInterval(() => {
        const delta = `Synthetic live output ${++tick}. `;
        item.text += delta;
        notify("item/agentMessage/delta", { threadId: thread.id, turnId, itemId: item.id, delta });
        if (tick === 400) complete(thread);
      }, 150);
      streams.set(thread.id, { timer, turn, item });
      return;
    }
    case "turn/interrupt": complete(thread, "interrupted"); return send(id, {});
    case "thread/unsubscribe": return send(id, { status: "unsubscribed" });
    case "getAuthStatus": return send(id, { authMethod: "apikey", authToken: null, requiresOpenaiAuth: false });
    case "config/read": return send(id, { config: { model_provider: "fixture", developer_instructions: null, model_providers: {} } });
    case "model/list": return send(id, { data: [], nextCursor: null });
    default: return process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } })}\n`);
  }
};
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  try { handle(JSON.parse(line)); } catch (error) { process.stderr.write(`${error.stack}\n`); }
}).on("close", () => {
  for (const stream of streams.values()) clearInterval(stream.timer);
});
