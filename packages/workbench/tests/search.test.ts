import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { setup } from "./workflow-fixture.js";

describe("workbench search", () => {
  it("searches work item content and registered rollout files with context", async () => {
    const fixture = await setup();
    try {
      const rolloutPath = join(fixture.root, "rollout-search.jsonl");
      await writeFile(rolloutPath, [
        JSON.stringify({ type: "session_meta", payload: { session_id: "provider-1", originator: "vermillion" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] }, internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "needle in rollout" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } }),
        JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn-2" } })
      ].join("\n"), "utf8");
      const item = await fixture.service.createWorkItem(fixture.workspaceId, {
        title: "Searchable work item",
        objective: "needle in objective",
        risk: "R1",
        scope: { inScope: [], outOfScope: [], allowedPaths: [] },
        acceptance: [{ text: "The result contains needle" }]
      });
      const sessionSearch = async () => [{
        sessionId: "session-1",
        providerSessionId: "provider-1",
        workspaceId: fixture.workspaceId,
        engineId: "codex",
        providerKind: "codex-thread",
        title: "Searchable session",
        rolloutPath
      }];
      const service = new WorkbenchService({
        ...fixture.options,
        sessionSearch,
        rolloutsDir: fixture.root
      });
      try {
        const result = await service.search({ query: "needle in", contextLines: 1 });
        expect(result.hits.map((hit) => hit.kind)).toEqual(["workItem", "session"]);
        expect(result.hits[0]).toMatchObject({ kind: "workItem", workItemId: item.workItemId });
        expect(result.hits[1]).toMatchObject({
          kind: "session",
          sessionId: "session-1",
          turnId: "turn-1",
          line: 3
        });
        expect(result.hits[1]!.column).toBeGreaterThan(0);
        expect(result.hits[1]!.context.map((line) => line.line)).toEqual([2, 3, 4]);
        expect(result.hits[1]!.context[1]!.matches.length).toBeGreaterThan(0);
        expect(result.stats.sourcesScanned).toBe(2);
        expect(result.stats.bytesScanned).toBeGreaterThan(0);
      } finally {
        await service.dispose();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("limits rollout search to entries supplied by Vermillion", async () => {
    const fixture = await setup();
    try {
      const vermillionRollout = join(fixture.root, "vermillion.jsonl");
      const otherRollout = join(fixture.root, "other-app.jsonl");
      await writeFile(vermillionRollout, "{\"type\":\"session_meta\",\"payload\":{\"originator\":\"vermillion\"}}\nregistered-only\nregistered-only\n", "utf8");
      await writeFile(otherRollout, "registered-only\n", "utf8");
      const service = new WorkbenchService({
        ...fixture.options,
        sessionSearch: async () => [{ sessionId: "vermillion-session", workspaceId: fixture.workspaceId, engineId: "codex", providerKind: "codex-thread", rolloutPath: vermillionRollout }],
        rolloutsDir: fixture.root
      });
      try {
        const result = await service.search({ query: "registered-only" });
        expect(result.hits).toHaveLength(2);
        expect(result.hits[0]).toMatchObject({ sessionId: "vermillion-session", path: vermillionRollout });
        const limited = await service.search({ query: "registered-only", maxResults: 1 });
        expect(limited.hits).toHaveLength(1);
        expect(limited.stats.truncated).toBe(true);
      } finally {
        await service.dispose();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("searches text files under the workspace docs directory", async () => {
    const fixture = await setup();
    try {
      await fixture.service.writeDoc(fixture.workspaceId, ".vermillion/docs/search.md", "before\ndocs-search-needle\nafter\n");
      const result = await fixture.service.search({ query: "docs-search-needle", contextLines: 1 });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toMatchObject({
        kind: "doc",
        path: ".vermillion/docs/search.md",
        title: "search.md",
        line: 2,
        column: 1
      });
      expect(result.hits[0]!.context.map((line) => line.line)).toEqual([1, 2, 3]);
    } finally {
      await fixture.cleanup();
    }
  });
});
