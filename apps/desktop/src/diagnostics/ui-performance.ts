export type UiOperation = {
  name: string;
  startedAt: number;
  durationMs: number;
  kind: "sync" | "async" | "render";
  details?: Record<string, number | boolean>;
};

const operations: UiOperation[] = [];
const retentionMs = 10_000;
const maxOperations = 128;

/** Names are static instrumentation labels; details retain only counts/flags, never text. */
export const recordUiOperation = (
  name: string,
  startedAt: number,
  details?: Record<string, string | number | boolean | undefined>,
  kind: "sync" | "async" | "render" = "sync"
): void => {
  const now = performance.now();
  const durationMs = now - startedAt;
  if (!Number.isFinite(startedAt) || startedAt < 0 || durationMs < (kind === "async" ? 50 : 4)) return;
  const safeDetails = Object.fromEntries(Object.entries(details ?? {})
    .filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key)
      && !/content|text|key|prompt|path|url|token|secret|password/i.test(key)
      && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))
    .slice(0, 12)) as Record<string, number | boolean>;
  operations.push({ name: name.slice(0, 96), startedAt, durationMs, kind, details: safeDetails });
  // Keep spans by their end time: an async operation may have started much earlier.
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    if (operations[index]!.startedAt + operations[index]!.durationMs < now - retentionMs) operations.splice(index, 1);
  }
  if (operations.length > maxOperations) operations.splice(0, operations.length - maxOperations);
};

/** Overlaps plus the preceding second provide context without attributing async waits to CPU. */
export const recentUiOperations = (
  startTime = performance.now() - retentionMs,
  endTime = performance.now()
): UiOperation[] => operations
  .filter((span) => span.startedAt <= endTime && span.startedAt + span.durationMs >= startTime - 1_000)
  .map((span) => ({ ...span, details: { ...span.details } }));

/** DOM events use a monotonic timestamp, with epoch timestamps on older engines. */
export const normalizeEventTimestamp = (
  timestamp: number,
  handlerStartedAt: number,
  timeOrigin = performance.timeOrigin
): number => {
  const monotonic = timestamp > 1e12 ? timestamp - timeOrigin : timestamp;
  return Number.isFinite(monotonic) && monotonic > 0 && monotonic <= handlerStartedAt
    ? monotonic
    : handlerStartedAt;
};
