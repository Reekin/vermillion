import { Worker } from "node:worker_threads";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const threadHistoryDatabaseName = "thread_history_1.sqlite";

export type CodexHistoryProjectionClearResult = {
  status: "cleared" | "missing" | "unavailable" | "failed";
  path?: string;
};

export type CodexHistoryProjectionOptions = {
  resolveSqliteHome: () => string | undefined | Promise<string | undefined>;
  onWarning?: (message: string, details: Record<string, unknown>) => void;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Clears only Codex's rebuildable paginated history projection for one thread. */
export class CodexHistoryProjection {
  private readonly resolveSqliteHome: CodexHistoryProjectionOptions["resolveSqliteHome"];
  private readonly onWarning: NonNullable<CodexHistoryProjectionOptions["onWarning"]>;

  public constructor(options: CodexHistoryProjectionOptions) {
    this.resolveSqliteHome = options.resolveSqliteHome;
    this.onWarning = options.onWarning ?? ((message, details) => {
      console.warn("[vermillion] " + message, details);
    });
  }

  public async clearThread(threadId: string, signal?: AbortSignal): Promise<CodexHistoryProjectionClearResult> {
    signal?.throwIfAborted();
    const sqliteHome = (await this.resolveSqliteHome())?.trim();
    signal?.throwIfAborted();
    if (!sqliteHome || !threadId.trim()) {
      return { status: "unavailable" };
    }

    const path = join(sqliteHome, threadHistoryDatabaseName);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing", path };
      }
      this.warn(error, threadId, path);
      return { status: "failed", path };
    }

    signal?.throwIfAborted();
    try {
      // Each transaction owns its thread; completion includes closing the database and exiting.
      const status = await new Promise<"cleared" | "missing">((resolve, reject) => {
        const worker = new Worker(new URL("./history-projection-worker.cjs", import.meta.url), {
          workerData: { path, threadId }
        });
        let result: "cleared" | "missing" | undefined;
        let failure: Error | undefined;
        worker.once("message", (value: "cleared" | "missing") => { result = value; });
        worker.once("error", (error) => { failure = error; });
        worker.once("exit", (code) => {
          if (failure || code !== 0 || !result) {
            reject(failure ?? new Error(`History cleanup worker exited without a result (${code}).`));
          } else {
            resolve(result);
          }
        });
      });
      return { status, path };
    } catch (error) {
      this.warn(error, threadId, path);
      return { status: "failed", path };
    }
  }

  private warn(error: unknown, threadId: string, path: string): void {
    try {
      this.onWarning("Codex history projection cleanup failed.", {
        threadId,
        path,
        error: errorMessage(error)
      });
    } catch {
      // Cleanup diagnostics must not turn best-effort maintenance into a hard failure.
    }
  }
}
