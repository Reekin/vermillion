import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHistorySource } from "../src/engines/codex/history-source.js";
import type { SessionIndexEntry } from "../src/session-index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "vermillion-history-source-"));
  directories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, "original history\n");
  const entry = { sessionId: "session-1" } as SessionIndexEntry;
  const rebuild = vi.fn().mockResolvedValue(undefined);
  const state = { active: false };
  const source = new CodexHistorySource({
    resolvePath: async () => path,
    isActive: () => state.active,
    rebuild
  });
  const read = vi.fn(async () => ({ turns: [] }));
  return { source, entry, path, rebuild, read, state };
};

describe("Codex rollout history source", () => {
  it("binds confirmation to the exact committed result, not the session or a later candidate", async () => {
    const { source, entry, path, read } = await setup();
    const first = await source.read(entry, read);
    source.confirmRead({ ...first });
    expect(await source.isCurrent(entry)).toBe(false);
    source.confirmRead(first);
    expect(await source.isCurrent(entry)).toBe(true);
    await appendFile(path, "changed\n");
    const uncommitted = await source.read(entry, read);
    source.confirmRead(first);
    expect(await source.isCurrent(entry)).toBe(false);
    source.confirmRead(uncommitted);
    expect(await source.isCurrent(entry)).toBe(true);
  });

  it("confirms only a successful committed full read and reuses an unchanged source", async () => {
    const { source, entry, rebuild, read } = await setup();
    expect(await source.isCurrent(entry)).toBe(false);
    const result = await source.read(entry, read);
    expect(await source.isCurrent(entry)).toBe(false);
    source.confirmRead(result);
    expect(await source.isCurrent(entry)).toBe(true);
    expect(await source.isCurrent(entry)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it.each(["edit", "append", "truncate", "replace"])("detects normal %s", async (operation) => {
    const { source, entry, path, read, rebuild } = await setup();
    source.confirmRead(await source.read(entry, read));
    if (operation === "edit") {
      await writeFile(path, "modified history\n");
      await utimes(path, new Date(), new Date(Date.now() + 1000));
    } else if (operation === "append") {
      await appendFile(path, "another turn\n");
    } else if (operation === "truncate") {
      await truncate(path, 4);
    } else {
      await rename(path, path + ".old");
      await writeFile(path, "original history\n");
    }
    expect(await source.isCurrent(entry)).toBe(false);
    source.confirmRead(await source.read(entry, read));
    expect(await source.isCurrent(entry)).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("does not confirm a moving source, failed read, or failed cleanup", async () => {
    const { source, entry, path, rebuild, read } = await setup();
    const moving = await source.read(entry, async () => {
      await appendFile(path, "during read\n");
      return {};
    });
    source.confirmRead(moving);
    expect(await source.isCurrent(entry)).toBe(false);
    await expect(source.read(entry, async () => { throw new Error("read failed"); })).rejects.toThrow("read failed");
    expect(await source.isCurrent(entry)).toBe(false);
    rebuild.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(source.read(entry, read)).rejects.toThrow("cleanup failed");
    expect(read).not.toHaveBeenCalled();
    source.confirmRead(await source.read(entry, read));
    expect(await source.isCurrent(entry)).toBe(true);
  });

  it("passes cancellation into rebuilding and never continues into history after cancellation", async () => {
    const { source, entry, rebuild, read } = await setup();
    const controller = new AbortController();
    rebuild.mockImplementationOnce(async (_id, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
    });
    await expect(source.read(entry, read, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(await source.isCurrent(entry)).toBe(false);
  });

  it("fills active history without releasing execution and never confirms a cancelled read", async () => {
    const { source, entry, rebuild, read, state } = await setup();
    state.active = true;
    const controller = new AbortController();
    await expect(source.read(entry, async () => {
      controller.abort();
      return {};
    }, controller.signal)).rejects.toThrow();
    expect(await source.isCurrent(entry)).toBe(false);
    source.confirmRead(await source.read(entry, read));
    expect(await source.isCurrent(entry)).toBe(true);
    expect(rebuild).not.toHaveBeenCalled();
  });
});
