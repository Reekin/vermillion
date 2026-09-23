import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DiagnosticsWriteInputRpc } from "@vermillion/shared";
import type { SessionReadProgressTracker } from "./session-read-progress.js";

type Fields = Record<string, string | number | boolean | undefined>;
type Context = { readId: string; sessionId: string; write: (entry: DiagnosticsWriteInputRpc) => void; parentSpanId?: string; progress?: SessionReadProgressTracker };
const context = new AsyncLocalStorage<Context>();

/** Only IDs, static stage names, counts and timings belong in this trace. */
export const beginSessionStage = (stage: string, fields: Fields = {}) => {
  const owner = context.getStore();
  const spanId = randomUUID();
  const startedAt = performance.now();
  const emit = (phase: string, extra: Fields = {}) => {
    if (!owner) return;
    try { if (!fields.background) owner.progress?.stage({ stage, phase, spanId, fields: { ...fields, ...extra } }); } catch { /* Observer does not own the read. */ }
    try {
      owner.write({ kind: "runtime-pipeline", severity: "info", source: "session-load",
        sessionId: owner.sessionId, requestId: owner.readId,
        occurredAt: new Date().toISOString(), message: stage,
        metrics: { durationMs: performance.now() - startedAt },
        context: { traceId: owner.readId.split("::")[0], readId: owner.readId,
          spanId, parentSpanId: owner.parentSpanId, stage, phase, pid: process.pid, ...fields, ...extra } });
    } catch { /* Diagnostics never alter a read's result. */ }
  };
  emit("begin");
  return { emit, owner: owner ? { ...owner, parentSpanId: spanId, progress: fields.background ? undefined : owner.progress } : undefined };
};

export const sessionStage = async <T>(stage: string, fields: Fields, work: () => Promise<T>): Promise<T> => {
  const span = beginSessionStage(stage, fields);
  try {
    const result = await (span.owner ? context.run(span.owner, work) : work());
    span.emit("end", { outcome: "ok" });
    return result;
  } catch (error) {
    span.emit("end", { outcome: "error", errorCode: String((error as { code?: string })?.code ?? "unknown") });
    throw error;
  }
};

export const traceSessionRead = <T>(readId: string, sessionId: string,
  write: Context["write"], work: () => Promise<T>, progress?: SessionReadProgressTracker): Promise<T> =>
  context.run({ readId, sessionId, write, progress }, () => sessionStage("server.read", {}, work));

export const reportSessionReadCounts = (completed: number, total: number): void => {
  context.getStore()?.progress?.counts(completed, total);
};
