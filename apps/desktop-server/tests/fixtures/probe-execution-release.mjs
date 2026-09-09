// CLI: node apps/desktop-server/tests/fixtures/probe-execution-release.mjs <codex.exe> <source CODEX_HOME>
import { build } from "esbuild";
import { mkdtemp, mkdir, copyFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const [commandPath, sourceHome] = process.argv.slice(2);
if (!commandPath || !sourceHome) throw new Error("Pass codex.exe and source CODEX_HOME; the source is copied read-only.");
const root = await mkdtemp(join(tmpdir(), "vermillion-release-probe-"));
const codexHome = join(root, "codex-home");
const cwd = join(root, "worktree");
await mkdir(codexHome);
await mkdir(cwd);
for (const name of ["config.toml", "auth.json"]) {
  try { await copyFile(join(sourceHome, name), join(codexHome, name)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const modulePath = join(root, "runtime.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../../src/codex-app-server-runtime-port.ts", import.meta.url))],
  outfile: modulePath, bundle: true, platform: "node", format: "esm", packages: "bundle", logLevel: "silent" });
const { createCodexAppServerRuntimePort } = await import(pathToFileURL(modulePath).href);
const port = createCodexAppServerRuntimePort({ commandPath: resolve(commandPath), commandArgs: ["app-server"] });
const report = { root, binary: execFileSync(commandPath, ["--version"], { encoding: "utf8" }).trim(), stages: [] };
const stage = (name, details = {}) => { report.stages.push({ name, ...details }); console.log(JSON.stringify({ name, ...details })); };
port.rpcClient.onNotification((event) => {
  if (event.method.startsWith("thread/") || event.method === "error") stage("notification", event);
});
port.subscribe((event) => {
  if (event.type === "runtime.error") console.log(JSON.stringify({ runtimeError: event }));
});
port.processSupervisor.onStderr((line) => {
  if (/shutdown|shutting|unload|unsubscribe|error|warn/i.test(line)) stage("stderr", { line });
});
const originalRpc = port.rpc.bind(port);
port.rpc = async (...args) => {
  const result = await originalRpc(...args);
  if (args[0] === "thread/unsubscribe") stage("unsubscribe-response", result);
  return result;
};
let success = false;
try {
  await port.start({ cwd: root, env: { CODEX_HOME: codexHome, RUST_LOG: "codex_app_server=debug,codex_core=info" } });
  const { thread } = await port.rpc("thread/start", { cwd, approvalPolicy: "never", sandbox: "danger-full-access" });
  port.attachThreadToSession("probe", thread.id);
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const off = port.rpcClient.onNotification((event) => {
    if (event.method === "turn/completed" && event.params.threadId === thread.id) finish(event.params.turn);
  });
  let turnTimeout;
  try {
    await port.rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply exactly RELEASE_PROBE_OK. Do not call any tools.", text_elements: [] }], effort: "low" });
    const turn = await Promise.race([completed, new Promise((_, reject) => {
      turnTimeout = setTimeout(() => reject(new Error("Probe turn did not complete within 120 seconds")), 120000);
    })]);
    stage("turn-completed", { status: turn.status });
  } finally { clearTimeout(turnTimeout); off(); }
  const mcp = await port.rpc("mcpServerStatus/list", {});
  stage("started", { threadId: thread.id, mcp: mcp.data?.map((server) => server.name) });
  // A cwd lock must be present before release for this probe to establish the original failure.
  try { await rmdir(cwd); stage("no-lock-before-release"); await mkdir(cwd); }
  catch (error) { stage("locked-before-release", { code: error.code }); }
  try { await port.releaseSessionExecution("probe"); }
  catch (error) {
    stage("release-failed", { message: error.message, loaded: await port.rpc("thread/loaded/list", {}) });
    try { await rmdir(cwd); stage("directory-removable-despite-missing-close"); }
    catch (lock) { stage("directory-still-locked", { code: lock.code }); }
    throw error;
  }
  stage("released-after-thread-closed");
  const history = await port.readThread(thread.id, true);
  stage("history-readable", { threadId: history.id, turns: history.turns.length });
  await rmdir(cwd);
  stage("directory-removed-with-app-server-running", { runtime: port.getState() });
  await mkdir(cwd);
  const resumed = await port.resumeThread(thread.id, cwd);
  port.attachThreadToSession("probe", resumed.id);
  stage("resumed", { sameThread: resumed.id === thread.id });
  await port.releaseSessionExecution("probe");
  await rmdir(cwd);
  stage("resumed-environment-released");
  success = true;
} finally {
  await port.stop(); // This port owns only the new probe app-server.
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  await rm(codexHome, { recursive: true, force: true });
  console.log(JSON.stringify({ success, report: join(root, "report.json") }));
}
