import type { DiagnosticsWriteInputRpc } from "@vermillion/shared";

type Trace = { id: string; sessionId: string; startedAt: number; seen: Set<string>; write: (entry: DiagnosticsWriteInputRpc) => Promise<unknown> };
let current: Trace | undefined;

export const sessionLoadMark = (trace: Trace | undefined, stage: string,
  fields: Record<string, string | number | boolean> = {}): void => {
  if (!trace) return;
  try {
    void trace.write({ kind: "runtime-pipeline", severity: "info", source: "session-load",
      sessionId: trace.sessionId, occurredAt: new Date().toISOString(), message: stage,
      metrics: { elapsedMs: performance.now() - trace.startedAt },
      context: { traceId: trace.id, stage, phase: "mark", ...fields } }).catch(() => {});
  } catch { /* Diagnostics must not interrupt navigation. */ }
};

export const beginSessionLoad = (sessionId: string, write: Trace["write"], origin: string): Trace => {
  if (current) sessionLoadMark(current, "navigation.leave", { displayed: current.seen.has("content.frame") });
  current = { id: globalThis.crypto.randomUUID(), sessionId, startedAt: performance.now(), seen: new Set(), write };
  sessionLoadMark(current, "navigation.click", { origin });
  return current;
};

export const sessionLoadTrace = (sessionId: string | undefined): Trace | undefined =>
  current?.sessionId === sessionId ? current : undefined;

export const sessionContentCommitted = (sessionId: string | undefined, turns: number): void => {
  const trace = sessionLoadTrace(sessionId);
  if (!trace || trace.seen.has("content.commit")) return;
  trace.seen.add("content.commit");
  sessionLoadMark(trace, "content.commit", { turns });
  // This is a frame opportunity after React commit, not a claim of GPU paint completion.
  requestAnimationFrame(() => {
    if (current !== trace) return;
    trace.seen.add("content.frame");
    sessionLoadMark(trace, "content.frame", { visibility: document.visibilityState });
  });
};
