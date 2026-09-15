// @ts-check
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");

const projectionTables = [
  "thread_items",
  "thread_realtime_items",
  "thread_turns",
  "thread_history_projection_state"
];

const database = new DatabaseSync(workerData.path);
let result = "missing";
try {
  database.exec("PRAGMA busy_timeout = 2000");
  const existingTables = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)")
      .all(...projectionTables).map((row) => row.name)
  );
  if (existingTables.size > 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of projectionTables) {
        if (existingTables.has(table)) {
          database.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(workerData.threadId);
        }
      }
      database.exec("COMMIT");
      result = "cleared";
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }
} finally {
  database.close();
}
parentPort?.postMessage(result);
