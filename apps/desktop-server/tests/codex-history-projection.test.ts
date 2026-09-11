import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHistoryProjection } from "../src/codex-history-projection.js";

const threadHistorySchema = [
  "CREATE TABLE thread_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL)",
  "CREATE TABLE thread_realtime_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL)",
  "CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL)",
  "CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL)"
];

describe("CodexHistoryProjection", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const directory = tempDirs.pop();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears only the selected thread from every rebuildable projection table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vermillion-history-projection-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "thread_history_1.sqlite");
    const database = new DatabaseSync(databasePath);
    for (const statement of threadHistorySchema) database.exec(statement);
    for (const table of ["thread_items", "thread_realtime_items", "thread_turns"]) {
      database.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run("target", "target-item");
      database.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run("other", "other-item");
    }
    database.prepare("INSERT INTO thread_history_projection_state VALUES (?, ?, ?)")
      .run("target", 12, 4);
    database.prepare("INSERT INTO thread_history_projection_state VALUES (?, ?, ?)")
      .run("other", 24, 8);
    database.close();

    const projection = new CodexHistoryProjection({
      resolveSqliteHome: () => directory
    });
    await expect(projection.clearThread("target")).resolves.toMatchObject({
      status: "cleared",
      path: databasePath
    });

    const verify = new DatabaseSync(databasePath);
    for (const table of [
      "thread_items",
      "thread_realtime_items",
      "thread_turns",
      "thread_history_projection_state"
    ]) {
      expect(verify.prepare(`SELECT thread_id FROM ${table}`).all()).toHaveLength(1);
      expect(verify.prepare(`SELECT thread_id FROM ${table}`).get()).toMatchObject({ thread_id: "other" });
    }
    verify.close();
  });

  it("treats a missing projection database as an empty rebuild target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vermillion-history-projection-"));
    tempDirs.push(directory);
    const projection = new CodexHistoryProjection({
      resolveSqliteHome: () => directory
    });

    await expect(projection.clearThread("target")).resolves.toMatchObject({
      status: "missing",
      path: join(directory, "thread_history_1.sqlite")
    });
  });
});
