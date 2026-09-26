#!/usr/bin/env node
// Connects only to an existing isolated app.start target; never starts/stops Electron.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const usage = `Usage:
  node apps/desktop/tests/mobile-web-smoke.mjs --target <app.start descriptor.json> --url <https://desktop.example> --browser <absolute agent-browser executable> --session-id <existing real test session> --evidence <output directory> [--insecure-localhost]

Requires a running isolated app.start instance with its HTTPS tunnel configured,
and an idle real-engine test conversation. Sends one pure-text no-tools prompt.
Uses a fresh browser session, pairs through the GUI, checks session list, opens
the conversation, verifies an actual agent response via bound session.read and
the rendered assistant bubble, then opens Inbox. Writes screenshots/report.json.
Always closes its browser and revokes its uniquely named paired test device.
Does not start/stop Electron, change tunnel settings, or create conversations.
--insecure-localhost permits a local Caddy certificate only on localhost/127.0.0.1.
On Windows pass the native agent-browser .exe, not a .cmd shim.
`;
if (process.argv.includes("--help")) { console.log(usage); process.exit(0); }
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--insecure-localhost") { args.insecure = true; continue; }
  if (!/^--(target|url|browser|session-id|evidence)$/.test(flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(usage);
  args[flag.slice(2)] = process.argv[++i];
}
for (const name of ["target", "url", "browser", "session-id", "evidence"]) assert.ok(args[name], `Missing --${name}. ${usage}`);
assert.ok(isAbsolute(args.browser), "--browser must be an absolute executable path");
assert.ok(!/\.(cmd|bat)$/i.test(args.browser), "--browser must be the native executable, not a shell shim");
const url = new URL(args.url);
assert.equal(url.protocol, "https:", "--url must use HTTPS through the configured tunnel");
assert.ok(!url.username && !url.password && !url.search && !url.hash, "--url must not contain credentials, query, or fragment");
assert.ok(!args.insecure || ["localhost", "127.0.0.1"].includes(url.hostname), "--insecure-localhost only supports localhost/127.0.0.1");
args.target = resolve(args.target);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repository, "packages/workbench/bin/vermillion.mjs");
const execute = promisify(execFile);
const nonce = randomBytes(8).toString("hex");
const browserSession = `vermillion-mobile-smoke-${nonce}`;
const deviceName = `Mobile web smoke ${nonce}`;
const replyText = `MOBILE_SMOKE_REPLY_${nonce}`;
const prompt = `This is a connection check. Do not use tools, read files, run commands, or change anything. Reply with exactly this plain text and nothing else: ${replyText}`;
const checks = [];
const cleanupErrors = [];
const secrets = [];
const redact = (value) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
let interrupted = false;
let browserStarted = false;
let pairingAttempted = false;
let deviceId;
let failure;
let responseEvidence;
const onSignal = () => { interrupted = true; };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
await mkdir(resolve(args.evidence), { recursive: true });
const evidence = await mkdtemp(join(resolve(args.evidence), "mobile-web-"));
const browserConfig = join(evidence, "browser-config.json");
await writeFile(browserConfig, "{}\n", { mode: 0o600 });
// Do not inherit a shared CDP connection, profile, restore key or launch script.
const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_BROWSER_")));
browserEnv.AGENT_BROWSER_DEFAULT_TIMEOUT = "120000";
const browserFlags = ["--session", browserSession, "--json"];
let browserConfigured = false;

async function run(program, argv, label, env = process.env, timeout = 135_000) {
  try {
    return (await execute(program, argv, { cwd: repository, env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout;
  } catch (error) { throw new Error(`${label} failed: ${redact(error.stderr || error.message).slice(0, 4000)}`); }
}
async function cli(method, params = {}) {
  const stdout = await run(process.execPath, [cliPath, "--target", args.target, method, JSON.stringify(params)], `Bound CLI ${method}`);
  try { return JSON.parse(stdout); } catch { throw new Error(`Invalid CLI response: ${method}`); }
}
async function browser(...argv) {
  const launchFlags = !browserConfigured && argv[0] === "open"
    ? ["--config", browserConfig, ...(args.insecure ? ["--ignore-https-errors"] : [])] : [];
  if (argv[0] === "open") browserConfigured = true;
  const stdout = await run(args.browser, [...launchFlags, ...browserFlags, ...argv], `Browser ${argv[0]}`, browserEnv);
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error(`Invalid browser response: ${argv[0]}`); }
  if (result.success === false) throw new Error(`Browser ${argv[0]} failed: ${redact(JSON.stringify(result.error)).slice(0, 4000)}`);
  return result.data;
}
async function until(label, predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Smoke interrupted");
    if (await predicate()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const capture = (name) => browser("screenshot", join(evidence, `${name}.png`));
const visible = (expression) => browser("wait", "--fn", `Boolean(${expression})`);

try {
  const descriptor = JSON.parse(await readFile(args.target, "utf8"));
  assert.ok(descriptor.instanceId && descriptor.dataDir && Number.isInteger(descriptor.pid), "Invalid isolated app.start target descriptor");
  await access(args.browser);
  const help = await run(args.browser, ["--help"], "Browser compatibility check", browserEnv, 10_000);
  for (const flag of ["--session", "--json", "--config", "--ignore-https-errors"]) assert.ok(help.includes(flag), `agent-browser must support ${flag}`);
  for (const method of ["remote.pair", "remote.device.list", "remote.device.revoke", "session.read"]) {
    await run(process.execPath, [cliPath, method, "--help"], `CLI compatibility ${method}`, process.env, 10_000);
  }
  const status = await cli("remote.status");
  assert.equal(status.state, "connected", "The existing target tunnel must be connected");
  const baseline = await cli("session.read", { sessionId: args["session-id"], limit: 200, maxChars: 200000 });
  assert.ok(Array.isArray(baseline.messages) && Array.isArray(baseline.turns), "Expected real session transcript");
  assert.ok(baseline.activity?.status !== "active" && !baseline.activeTurnId, "Test conversation must be idle");
  const oldMessages = new Set(baseline.messages.map((message) => message.messageId));
  browserStarted = true;
  await browser("open", url.href);
  await browser("set", "viewport", "390", "844");
  await browser("wait", "--text", "连接桌面");
  await capture("pairing");
  const pairing = await cli("remote.pair");
  assert.ok(typeof pairing.code === "string", "Pairing code missing");
  secrets.push(pairing.code);
  const pairingUrl = new URL(pairing.qrContent);
  assert.equal(new URL(pairingUrl.searchParams.get("url")).origin, url.origin, "--url must match the bound desktop public URL");
  pairingAttempted = true;
  await browser("find", "label", "设备名称", "fill", deviceName);
  await browser("find", "label", "配对码", "fill", pairing.code);
  await browser("find", "role", "button", "click", "--name", "配对", "--exact");
  await browser("wait", "--text", "会话列表");
  await until("paired smoke device", async () => {
    deviceId = (await cli("remote.device.list")).find((device) => device.name === deviceName)?.deviceId;
    return !!deviceId;
  });
  check("Browser GUI paired with the bound isolated desktop");
  await visible("document.querySelector('.vm-mobile-layout ul li') !== null");
  await capture("session-list");
  check("Session list rendered actual desktop conversations");
  const conversationUrl = new URL(url.href);
  conversationUrl.hash = `/session/${encodeURIComponent(args["session-id"])}`;
  await browser("open", conversationUrl.href);
  await visible("document.querySelector('textarea[aria-label=\"消息\"]') && !document.querySelector('textarea[aria-label=\"消息\"]').disabled");
  await browser("fill", 'textarea[aria-label="消息"]', prompt);
  await visible(`document.querySelector('textarea[aria-label="消息"]').value === ${JSON.stringify(prompt)}`);
  await capture("before-send");
  await visible("document.querySelector('.awb-mobile-composer button[type=submit]:not(:disabled)') !== null");
  await browser("find", "role", "button", "click", "--name", "发送", "--exact");
  check("Unique pure-text prompt submitted through the mobile composer");
  await until("real agent reply and completed turn", async () => {
    const transcript = await cli("session.read", { sessionId: args["session-id"], limit: 200, maxChars: 200000 });
    const user = transcript.messages.find((message) => message.sender === "user" && !oldMessages.has(message.messageId) && message.text.includes(replyText));
    if (!user) return false;
    const reply = transcript.messages.find((message) => message.sender === "agent" && !oldMessages.has(message.messageId)
      && message.turnId === user.turnId && message.text.trim() === replyText);
    const turn = transcript.turns.find((entry) => entry.turnId === user.turnId);
    if (!reply || turn?.status !== "completed") return false;
    assert.ok(!transcript.activity?.running?.some((entry) => entry.turnId === turn.turnId), "Prompt unexpectedly started a tool");
    assert.ok(transcript.activity?.recentCompleted?.turnId !== turn.turnId, "Prompt unexpectedly used a tool");
    responseEvidence = { sessionId: transcript.sessionId, userMessageId: user.messageId, agentMessageId: reply.messageId, turnId: turn.turnId, sender: reply.sender, text: reply.text, status: turn.status };
    return true;
  }, 180_000);
  await visible(`Array.from(document.querySelectorAll('.awb-message.is-assistant')).some(node => node.innerText.includes(${JSON.stringify(replyText)}))`);
  await capture("agent-reply");
  check("New completed agent reply confirmed by session.read and rendered assistant bubble, excluding user echo");
  await browser("find", "role", "button", "click", "--name", "Inbox");
  await visible("location.hash.startsWith('#/inbox') && !document.body.innerText.includes('正在读取 Inbox') && !document.body.innerText.includes('Inbox 加载失败') && (document.body.innerText.includes('没有待处理事项') || document.querySelector('.vm-mobile-layout ul li'))");
  await capture("inbox");
  check("Inbox opened from mobile navigation");
} catch (error) {
  failure = error instanceof Error ? error.message : "Smoke failed";
} finally {
  // Close even after a failed open. No other browser sessions are touched.
  if (browserStarted) {
    try {
      await browser("close");
      await until("owned browser session cleanup", async () => {
        const listing = await run(args.browser, ["--json", "session", "list"], "Browser cleanup verification", browserEnv, 15_000);
        return !listing.includes(browserSession);
      }, 15_000);
      await until("owned browser process cleanup", async () => {
        const processes = process.platform === "win32"
          ? await run("pwsh", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(agent-browser.*|chrome|node)\\.exe$' -and $_.CommandLine -like ('*' + $env.SMOKE_BROWSER_SESSION + '*') } | Select-Object -ExpandProperty ProcessId"], "Browser process cleanup verification", { ...browserEnv, SMOKE_BROWSER_SESSION: browserSession }, 15_000)
          : await run("ps", ["-ax", "-o", "pid=,command="], "Browser process cleanup verification", browserEnv, 15_000);
        return process.platform === "win32" ? !processes.trim()
          : !processes.split("\n").some((line) => line.includes(browserSession) && /agent-browser|chrome/i.test(line));
      }, 15_000);
      check("Owned browser session closed");
    } catch (error) { cleanupErrors.push("Could not confirm owned browser session cleanup: " + redact(error.message)); }
  }
  if (pairingAttempted) {
    try {
      // Discover by unique name even when pairing succeeded but its UI wait failed.
      const devices = await cli("remote.device.list");
      const owned = devices.filter((device) => device.name === deviceName || device.deviceId === deviceId);
      for (const device of owned) await cli("remote.device.revoke", { deviceId: device.deviceId });
      assert.ok(!(await cli("remote.device.list")).some((device) => device.name === deviceName), "Paired smoke device remains authorized");
      check("Paired smoke device revoked");
    } catch { cleanupErrors.push("Could not revoke or verify the paired smoke device"); }
  }
  const report = { passed: !failure && cleanupErrors.length === 0, checks, browserSession, response: responseEvidence, ...(failure ? { failure } : {}), cleanupErrors };
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
console.log(`Evidence: ${evidence}`);
if (failure || cleanupErrors.length) { console.error([failure, ...cleanupErrors].filter(Boolean).join("\n")); process.exitCode = 1; }
