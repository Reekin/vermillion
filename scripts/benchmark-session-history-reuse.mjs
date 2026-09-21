import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { memberCount, totalTurns, providerId, sessionId, turnId, turnCount,
  makeSnapshot } from "../apps/desktop-server/tests/fixtures/session-history-reuse-data.mjs";

// pnpm exec tsx scripts/benchmark-session-history-reuse.mjs [--baseline <checkout>]
// pnpm exec tsx scripts/benchmark-session-history-reuse.mjs seed --data-dir <empty isolated dir> --project <isolated workspace>
// Seed only while that isolated instance is stopped. Never point it at user data.
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  assert(args[index + 1] && !args[index + 1].startsWith("--"), `${name} needs a value`);
  return args[index + 1];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (args.includes("--help")) {
  console.log("benchmark-session-history-reuse [--baseline <checkout>] [--output <new directory>]\n" +
    "benchmark-session-history-reuse seed --data-dir <empty isolated directory> --project <isolated workspace>\n" +
    "Build @vermillion/shared and @vermillion/core in each checkout first. Run through pnpm exec tsx.\n" +
    "GUI: seed with the instance stopped; set VERMILLION_CODEX_BIN to the absolute path of\n" +
    "apps/desktop-server/tests/fixtures/session-history-reuse-codex.cmd, and set\n" +
    "VERMILLION_HISTORY_REUSE_PROJECT to the exact registered project path.\n" +
    "Add --verify-provider to seed to check the production service composition without launching the app.\n" +
    "The provider is synthetic; timing covers reconciliation, real runtime/tree services and JSON serialization,\n" +
    "not Codex disk scanning, network transfer, rendering, or a complete session.open cycle.");
  process.exit(0);
}
const checkout = resolve(option("--checkout") ?? root);
const load = (name) => import(pathToFileURL(join(checkout, "apps/desktop-server/src", `${name}.ts`)).href);
const [{ SessionIndexStore }, { WorkspaceRegistryService }] = await Promise.all([
  load("session-index"), load("workspace-registry")
]);

async function seed(dataDir, project) {
  await mkdir(project, { recursive: true });
  const index = new SessionIndexStore({ baseDir: dataDir });
  const registry = new WorkspaceRegistryService({ baseDir: dataDir });
  await Promise.all([index.ready(), registry.ready()]);
  assert.equal(index.listEntries().length, 0, "Refusing to seed a nonempty session index");
  assert.equal(registry.getState().workspaces.length, 0, "Refusing to seed registered workspace data");
  const workspace = await registry.registerWorkspace({ absolutePath: project, label: "History reuse benchmark" });
  for (let member = 0; member < memberCount; member++) {
    const snapshot = makeSnapshot(member, workspace.workspaceId, project);
    await index.upsertSession({ workspaceId: workspace.workspaceId, session: snapshot.session,
      providerKind: "codex-thread", providerSessionId: providerId(member) });
    if (member) await index.upsertRelation({ workspaceId: workspace.workspaceId,
      parentSessionId: sessionId(member - 1), childSessionId: sessionId(member), relationType: "fork",
      sourceTurnId: turnId(member - 1, turnCount(member - 1) - 1) });
  }
  return { index, registry, workspace };
}

if (args[0] === "seed") {
  assert(option("--data-dir") && option("--project"), "seed requires --data-dir and --project");
  const dataDir = resolve(option("--data-dir"));
  const project = resolve(option("--project"));
  const { workspace } = await seed(dataDir, project);
  if (args.includes("--verify-provider")) {
    process.env.VERMILLION_HISTORY_REUSE_PROJECT = project;
    const { createSessionRuntimeService } = await load("prod-service");
    const service = createSessionRuntimeService({ persistenceBaseDir: dataDir,
      engineCommands: { codex: process.platform === "win32"
        ? { path: join(root, "apps/desktop-server/tests/fixtures/session-history-reuse-codex.cmd"), args: [] }
        : { path: process.execPath, args: [join(root, "apps/desktop-server/tests/fixtures/session-history-reuse-codex.mjs")] } } });
    try {
      const response = await service.getChatTree(sessionId(12), "path");
      assert.equal(response.visibleTurnIds.length, totalTurns);
      assert.equal(response.windows.length, memberCount);
      const bytes = Buffer.byteLength(JSON.stringify(response));
      assert(bytes > 30_000_000);
      const knownWindows = Object.fromEntries(response.windows.map((window) =>
        [window.sessionId, { revision: window.revision, cursor: window.cursor }]));
      const stable = await service.getChatTree(sessionId(12), "path", knownWindows);
      assert.equal(stable.windows.length, 0);
      const verification = { windows: response.windows.length, bytes,
        stableWindows: stable.windows.length, stableBytes: Buffer.byteLength(JSON.stringify(stable)) };
      await writeFile(join(dataDir, "provider-verification.json"), JSON.stringify(verification, null, 2));
      console.log(`Production provider verified: ${JSON.stringify(verification)}`);
    } finally { await service.dispose(); }
  }
  console.log(JSON.stringify({ dataDir, project, workspaceId: workspace.workspaceId,
    sessionId: sessionId(12), members: memberCount, turns: totalTurns,
    environment: { VERMILLION_HISTORY_REUSE_PROJECT: project,
      VERMILLION_CODEX_BIN: join(root, "apps/desktop-server/tests/fixtures/session-history-reuse-codex.cmd") } }, null, 2));
  process.exit(0);
}

const output = option("--output") ? resolve(option("--output"))
  : await mkdtemp(join(tmpdir(), "vermillion-history-reuse-"));
if (option("--output") && !args.includes("--child")) await mkdir(output);
const label = option("--label") ?? "candidate";
const dataDir = await mkdtemp(join(output, `${label}-data-`));
const { index, registry, workspace } = await seed(dataDir, join(dataDir, "project"));
const [{ SessionRuntimeService }, { SessionReconciliationService }, { WrapperChatTreeService }] = await Promise.all([
  load("runtime-service"), load("session-discovery"), load("wrapper-chat-tree")
]);
const runtime = new SessionRuntimeService({ sessionIndexStore: index, workspaceRegistry: registry,
  engines: [{ engineId: "codex", displayName: "Codex", capabilities: ["chat"] }] });
let providerReads = 0;
const snapshots = Array.from({ length: memberCount }, (_, member) =>
  makeSnapshot(member, workspace.workspaceId, join(dataDir, "project")));
const reconciliation = new SessionReconciliationService({ workspaceRegistry: registry,
  sessionIndexStore: index, runtimeService: runtime, providers: [{ engineId: "codex",
    hydrateSession: async (entry) => {
      providerReads++;
      const snapshot = snapshots.find((item) => item.session.sessionId === entry.sessionId);
      assert(snapshot, `Unknown fixture member ${entry.sessionId}`);
      return structuredClone(snapshot);
    }
  }] });
const tree = new WrapperChatTreeService({ sessionIndexStore: index, runtimeService: runtime,
  reconciliation, capabilities: {} });
const known = {};
const samples = [];
async function measure(phase, before) {
  const readsBefore = providerReads;
  const start = performance.now();
  await before?.();
  const refreshed = performance.now();
  const response = await tree.get(sessionId(12), "path", Object.keys(known).length ? known : undefined);
  const built = performance.now();
  const json = JSON.stringify(response);
  const serialized = performance.now();
  assert.equal(response.visibleTurnIds.length, totalTurns);
  assert.equal(response.memberSessionIds.length, memberCount);
  for (const window of response.windows ?? []) {
    known[window.sessionId] = { revision: window.revision, cursor: window.cursor };
  }
  samples.push({ phase, providerReads: providerReads - readsBefore,
    windows: response.windows?.length ?? 0, responseBytes: Buffer.byteLength(json),
    refreshMs: +(refreshed - start).toFixed(2), getMs: +(built - refreshed).toFixed(2),
    serializeMs: +(serialized - built).toFixed(2), totalMs: +(serialized - start).toFixed(2) });
  return response;
}
try {
  await measure("first-read");
  assert(samples[0].responseBytes > 30_000_000, "Fixture must exercise 30 MB image history");
  for (let repeat = 0; repeat < 5; repeat++) await measure(`stable-${repeat + 1}`);
  snapshots[12] = makeSnapshot(12, workspace.workspaceId, join(dataDir, "project"), 1);
  const changed = await measure("one-member-rebuilt", () =>
    reconciliation.ensureSessionLoaded(sessionId(12), { force: true, requireFull: true }));
  assert(changed.windows.some((window) => window.snapshot.messageBlocks.some((block) => block.text?.includes("generation 1"))),
    "Changed member must reach the client");
  await measure("stable-after-rebuild");
  if (typeof runtime.hasSessionWindow === "function") {
    assert(samples.slice(1, 6).every((sample) => sample.windows === 0 && sample.providerReads === 0));
    assert.equal(samples[6].windows, 1);
    assert.equal(samples[6].providerReads, 1);
    assert.equal(samples[7].windows, 0);
  }
  const git = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const status = spawnSync("git", ["-C", checkout, "status", "--short", "-z"], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const report = { label, checkout, commit: git.stdout.trim(), dirtyPaths: status.stdout.split("\0").filter(Boolean),
    node: process.version, platform: process.platform, arch: process.arch, members: memberCount, turns: totalTurns,
    measurement: "Synthetic provider -> real reconciliation/runtime/tree -> JSON. Provider reads count hydration calls, not filesystem reads.",
    samples };
  await writeFile(join(output, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.table(samples);
  console.log(`Evidence: ${join(output, `${label}.json`)}`);
} finally {
  tree.dispose();
  await runtime.dispose();
}
if (option("--baseline") && !args.includes("--child")) {
  // The same Node binary and tsx loader evaluate the other checkout in a fresh process.
  const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url),
    "--child", "--checkout", resolve(option("--baseline")), "--label", "baseline", "--output", output],
  { stdio: "inherit", cwd: root });
  assert.equal(result.status, 0, "Baseline benchmark failed");
}
