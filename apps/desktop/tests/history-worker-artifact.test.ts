import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { desktopRoot, electronBuildOptions } from "../scripts/electron-build-options.mjs";

describe("Codex history projection worker", () => {
  it("loads the bundled worker and clears only the requested thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "verm-history-artifact-"));
    try {
      const options = electronBuildOptions(directory);
      // Bundle the production projection at main's output location, without starting the app shell.
      await build({ ...options.main, logLevel: "silent",
        entryPoints: [resolve(desktopRoot, "../desktop-server/src/engines/codex/history-projection.ts")] });
      await build({ ...options.historyWorker, logLevel: "silent" });
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      const databasePath = join(directory, "thread_history_1.sqlite");
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("CREATE TABLE thread_turns (thread_id TEXT); INSERT INTO thread_turns VALUES ('target'), ('keep')");
      } finally { database.close(); }
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        const { CodexHistoryProjection } = await import(${JSON.stringify(pathToFileURL(options.main.outfile).href)});
        const projection = new CodexHistoryProjection({ resolveSqliteHome: () => ${JSON.stringify(directory)} });
        console.log(JSON.stringify(await projection.clearThread("target")));
      `], { timeout: 10_000 });
      expect(JSON.parse(stdout)).toMatchObject({ status: "cleared", path: databasePath });
      const remaining = new DatabaseSync(databasePath);
      try {
        expect(remaining.prepare("SELECT thread_id FROM thread_turns").all()).toEqual([{ thread_id: "keep" }]);
      } finally { remaining.close(); }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 20_000);
});
