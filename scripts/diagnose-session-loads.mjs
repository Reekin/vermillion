import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
if (args.includes("--help")) {
  console.log("diagnose-session-loads [--minutes 30] [--session <wrapper/provider ID>] [--trace <ID>] [--base-dir <dataDir>] [--json]\nDurations are wall time. Nested/parallel spans must not be added together. Engine wait includes engine scheduling, execution and transfer; content.frame is a frame opportunity, not GPU paint confirmation.");
  process.exit(0);
}
const baseDir = option("--base-dir") ?? join(homedir(), ".vermillion");
const minutes = Number(option("--minutes") ?? 30);
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--minutes must be positive");
const since = Date.now() - minutes * 60_000;
let sessionId = option("--session");
if (sessionId) {
  try {
    const index = JSON.parse(await readFile(join(baseDir, "session-index.json"), "utf8"));
    sessionId = index.entries.find((entry) => entry.providerSessionId === sessionId)?.sessionId ?? sessionId;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
const logDir = join(baseDir, "logs");
const files = (await readdir(logDir)).filter((name) => {
  const match = /^perf-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.\d+)?$/.exec(name);
  return match && Date.parse(match[1] + "T00:00:00Z") + 86_400_000 >= since;
});
const traces = new Map();
let malformedLines = 0;
for (const file of files) {
  for (const line of (await readFile(join(logDir, file), "utf8")).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { malformedLines++; continue; }
    const id = entry.context?.traceId;
    if (entry.source !== "session-load" || !id || Date.parse(entry.occurredAt) < since ||
        (sessionId && entry.sessionId !== sessionId) || (option("--trace") && id !== option("--trace"))) continue;
    const entries = traces.get(id) ?? [];
    entries.push(entry);
    traces.set(id, entries);
  }
}
const reports = [...traces].map(([traceId, entries]) => {
  entries.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const click = entries.find((entry) => entry.context.stage === "navigation.click");
  const frame = entries.find((entry) => entry.context.stage === "content.frame");
  const ended = new Set(entries.filter((entry) => entry.context.phase === "end").map((entry) => entry.context.spanId));
  return { traceId, sessionId: entries[0].sessionId, clickedAt: click?.occurredAt,
    displayMs: frame?.metrics.elapsedMs,
    unfinished: entries.filter((entry) => entry.context.phase === "begin" && !ended.has(entry.context.spanId)).map((entry) => ({ stage: entry.context.stage, spanId: entry.context.spanId })),
    entries };
});
if (args.includes("--json")) console.log(JSON.stringify({ malformedLines, traces: reports }, null, 2));
else {
  console.log("Wall-clock spans; do not sum nested/parallel durations. Missing ends may mean in-flight work, interruption or rotated logs.");
  for (const report of reports) {
    console.log(`\n${report.clickedAt ?? "CLI/background"} ${report.sessionId}\ntrace=${report.traceId} display=${report.displayMs?.toFixed(1) ?? "unobserved"}ms unfinished=${report.unfinished.length}`);
    console.table(report.entries.map((entry) => ({
      time: entry.occurredAt.slice(11, 23), stage: entry.context.stage, phase: entry.context.phase,
      ms: (entry.metrics.durationMs ?? entry.metrics.elapsedMs)?.toFixed(1),
      method: entry.context.method ?? "", engineId: entry.context.engineRequestId ?? "",
      member: entry.context.memberSessionId ?? entry.context.threadId ?? "",
      outcome: entry.context.outcome ?? (entry.context.late ? "late response" : ""),
      bytes: entry.context.responseBytes ?? "", parseMs: entry.context.parseMs?.toFixed(1) ?? ""
    })));
  }
  if (!reports.length) console.log("No matching session-load traces in this interval.");
  if (malformedLines) console.log(`Ignored ${malformedLines} incomplete/malformed log lines.`);
}
