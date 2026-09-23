import { stat } from "node:fs/promises";
import { sessionStage } from "../../session-load-trace.js";
import type { SessionIndexEntry } from "../../session-index.js";

/** Rollout metadata is an in-process freshness token, never a content revision. */
export const readRolloutSource = async (path: string): Promise<string> => {
  const value = await stat(path, { bigint: true });
  return [path, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
};

export class CodexHistorySource {
  private readonly committed = new Map<string, string>();
  private readonly readSources = new WeakMap<object, { sessionId: string; signature: string }>();

  public constructor(private readonly options: {
    resolvePath: (entry: SessionIndexEntry, signal?: AbortSignal) => Promise<string | undefined>;
    isActive: (sessionId: string) => boolean;
    rebuild: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  }) {}

  public async isCurrent(entry: SessionIndexEntry, signal?: AbortSignal): Promise<boolean> {
    const path = await this.options.resolvePath(entry, signal);
    signal?.throwIfAborted();
    return Boolean(path && this.committed.get(entry.sessionId) === await readRolloutSource(path));
  }

  /** Called only after reconciliation has committed the successful full read. */
  public confirmRead(result: object): void {
    const source = this.readSources.get(result);
    if (source) this.committed.set(source.sessionId, source.signature);
    this.readSources.delete(result);
  }

  /** This runs inside the existing shared reconciliation load, including its cancellation. */
  public async read<T extends object | undefined>(entry: SessionIndexEntry, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const sessionId = entry.sessionId;
    const path = await this.options.resolvePath(entry, signal);
    const before = path ? await readRolloutSource(path) : undefined;
    signal?.throwIfAborted();
    if (!this.options.isActive(sessionId) &&
        (!before || before !== this.committed.get(sessionId))) {
      await sessionStage("history.rebuild-source", { memberSessionId: sessionId, hasBaseline: this.committed.has(sessionId) },
        () => this.options.rebuild(sessionId, signal));
    }
    signal?.throwIfAborted();
    const result = await sessionStage("history.provider-read", { memberSessionId: sessionId }, read);
    signal?.throwIfAborted();
    if (result && before && path && before === await readRolloutSource(path)) {
      this.readSources.set(result, { sessionId, signature: before });
    }
    return result;
  }
}
