import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench-service.js";
import { buildRolloutIndex, markdownToPlainText, readRolloutMessage } from "../src/search.js";
import { setup } from "./workflow-fixture.js";
import type { WorkbenchEvent } from "../src/contracts.js";

// Rollout records in the shape Codex writes them: timestamp, ordinal, type, payload.
let ordinal = 0;
const at = (second: number) => `2026-09-26T10:00:${String(second).padStart(2, "0")}.000Z`;
const event = (payload: Record<string, unknown>) => {
  ordinal += 1;
  return JSON.stringify({ timestamp: at(ordinal % 60), ordinal, type: "event_msg", payload });
};
const meta = JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { originator: "vermillion" } });
const node = (turnId: string, order: number) =>
  event({ type: "chat_tree_node_started", revision: 1, node_id: turnId, parent_node_id: null, turn_id: turnId, order });
const completed = (turnId: string, item: Record<string, unknown>) =>
  event({ type: "item_completed", thread_id: "thread", turn_id: turnId, item });
const user = (turnId: string, id: string, text: string) =>
  completed(turnId, { type: "UserMessage", id, content: [{ type: "text", text, text_elements: [] }] });
const agent = (turnId: string, id: string, text: string) =>
  completed(turnId, { type: "AgentMessage", id, content: [{ type: "Text", text }] });
const readFile = (turnId: string, id: string, file: string, output: string) =>
  completed(turnId, {
    type: "CommandExecution", id, command: ["bash", "-lc", `cat ${file}`],
    parsed_cmd: [{ type: "read", cmd: `cat ${file}`, name: file, path: file }], status: "completed",
    stdout: output, stderr: "", aggregated_output: output, exit_code: 0
  });
const responseMessage = (turnId: string, text: string) => JSON.stringify({
  timestamp: at(59), type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }
});

const codexEntry = (sessionId: string, rolloutPath: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, workspaceId, engineId: "codex", providerKind: "codex-thread", rolloutPath, ...extra
});

describe("workbench search", () => {
  it("returns one hit per shown message with its source, turn, time and neighbours", async () => {
    const fixture = await setup();
    try {
      const rolloutPath = join(fixture.root, "rollout-search.jsonl");
      await writeFile(rolloutPath, [
        meta,
        node("turn-1", 0),
        user("turn-1", "user-1", "please read the needle file"),
        readFile("turn-1", "cmd-read", "needle.md", "# Title\nbody\n"),
        readFile("turn-1", "cmd-other", "notes.txt", "the needle only lives in output\n"),
        agent("turn-1", "agent-1", "The needle file has a title; the needle is documented."),
        responseMessage("turn-1", "The needle file has a title; the needle is documented."),
        node("turn-2", 1),
        agent("turn-2", "agent-2", "Anything else?"),
        agent("turn-2", "agent-quoted", "run \"quoted-term\" in C:\\temp")
      ].join("\n"), "utf8");
      const item = await fixture.service.createWorkItem(fixture.workspaceId, {
        title: "Searchable work item",
        objective: "needle in objective",
        risk: "R1",
        scope: { inScope: [], outOfScope: [], allowedPaths: [] },
        acceptance: [{ text: "The result contains needle" }]
      });
      const service = new WorkbenchService({
        ...fixture.options,
        sessionSearch: async () => [codexEntry("session-1", rolloutPath, fixture.workspaceId, { title: "Searchable session" })],
        rolloutsDir: fixture.root
      });
      try {
        const result = await service.search({ query: "NEEDLE" });
        expect(result.hits[0]).toMatchObject({ kind: "workItem", workItemId: item.workItemId });
        const sessionHits = result.hits.filter((hit) => hit.kind === "session");
        // The command whose output alone mentions the query, and the raw response record, add nothing.
        expect(sessionHits.map((hit) => [hit.source, hit.toolKind])).toEqual([
          ["user", undefined],
          ["tool", "read"],
          ["agent", undefined]
        ]);
        for (const hit of sessionHits) {
          expect(hit).toMatchObject({ sessionId: "session-1", turnId: "turn-1", turnNumber: 1 });
          expect(hit.messageAt).toMatch(/^2026-09-26T10:00:/);
          const shown = hit.context.find((line) => line.line === hit.line)!;
          expect(shown.text).not.toMatch(/aggregated_output|stdout|\\n|"type"/);
          expect(hit.column).toBe(shown.matches[0]!.start + 1);
        }
        const [userHit, toolHit, agentHit] = sessionHits;
        expect(toolHit!.context.find((line) => line.line === toolHit!.line)!.text).toBe("读取 needle.md · 2 行");
        // Two matches in one reply still make one hit; neighbours are the shown messages around it.
        expect(agentHit!.context.find((line) => line.line === agentHit!.line)!.matches).toHaveLength(2);
        expect(agentHit!.context.map((line) => line.source)).toEqual(["tool", "agent", "agent"]);
        expect(agentHit!.context.at(-1)!.text).toBe("Anything else?");
        expect(userHit!.context.map((line) => line.source)).toEqual(["user", "tool"]);
        expect(result.stats.bytesScanned).toBeGreaterThan(0);

        const metadataOnly = await service.search({ query: "aggregated_output" });
        expect(metadataOnly.hits.filter((hit) => hit.kind === "session")).toEqual([]);
        const secondTurn = await service.search({ query: "anything else" });
        expect(secondTurn.hits).toMatchObject([{ kind: "session", source: "agent", turnId: "turn-2", turnNumber: 2 }]);
        // Step words and escaped characters exist only in the shown text, not in the raw record.
        const stepQuery = await service.search({ query: "读取 needle.md · 2 行" });
        expect(stepQuery.hits.filter((hit) => hit.kind === "session")).toMatchObject([{ source: "tool", toolKind: "read" }]);
        const quoted = await service.search({ query: "\"quoted-term\" in C:\\temp" });
        expect(quoted.hits.filter((hit) => hit.kind === "session")).toMatchObject([{ source: "agent" }]);
      } finally {
        await service.dispose();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("numbers legacy message events by the turns started before them", () => {
    const lines = [
      event({ type: "task_started", turn_id: "legacy-1" }),
      event({ type: "user_message", message: "first question" }),
      event({ type: "task_started", turn_id: "legacy-2" }),
      event({ type: "agent_message", message: "second answer" })
    ];
    const index = buildRolloutIndex(lines.map((text, position) => ({ line: position + 1, byteOffset: position * 1000, text })));
    expect(index.messages.map((message) => [message.source, message.turnId])).toEqual([
      ["user", "legacy-1"],
      ["agent", "legacy-2"]
    ]);
    expect(index.turnNumbers.get("legacy-2")).toBe(2);
    expect(readRolloutMessage(lines[3]!, index.messages[1]!)).toEqual({ text: "second answer" });
  });

  it("reads agent replies as the rendered text a reader sees", () => {
    expect(markdownToPlainText([
      "## 结论",
      "项目只有 **`README.md`** 一个文件，见 [说明](docs/a.md)。",
      "> *注意* ~~旧~~ 内容",
      "```ts",
      "const snake_case_name = 1;",
      "```"
    ].join("\n"))).toBe("结论\n项目只有 README.md 一个文件，见 说明。\n注意 旧 内容\nconst snake_case_name = 1;");
    const record = { line: 1, start: 0, source: "agent" as const, at: "2026-09-26T10:00:00.000Z" };
    const line = agent("t", "md", "I read **README.md**.");
    expect(readRolloutMessage(line, record)).toEqual({ id: "md", text: "I read README.md." });
  });

  it("searches only entries supplied by Vermillion without truncating later matches", async () => {
    const fixture = await setup();
    try {
      const vermillionRollout = join(fixture.root, "vermillion.jsonl");
      const otherRollout = join(fixture.root, "other-app.jsonl");
      await writeFile(vermillionRollout, [meta, agent("t", "a-1", "registered-only"), agent("t", "a-2", "registered-only")].join("\n") + "\n", "utf8");
      await writeFile(otherRollout, agent("t", "o-1", "registered-only") + "\n", "utf8");
      const service = new WorkbenchService({
        ...fixture.options,
        sessionSearch: async () => [codexEntry("vermillion-session", vermillionRollout, fixture.workspaceId)],
        rolloutsDir: fixture.root
      });
      try {
        const result = await service.search({ query: "registered-only" });
        expect(result.hits).toHaveLength(2);
        expect(result.hits[0]).toMatchObject({ sessionId: "vermillion-session", path: vermillionRollout });
        const limited = await service.search({ query: "registered-only", maxResults: 1 });
        expect(limited.hits).toHaveLength(2);
        expect(limited.stats.truncated).toBe(false);
      } finally {
        await service.dispose();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("sorts tree metadata and lists messages inherited by forks once", async () => {
    const fixture = await setup();
    try {
      const rootPath = join(fixture.root, "root.jsonl");
      const childPath = join(fixture.root, "child.jsonl");
      const otherPath = join(fixture.root, "other.jsonl");
      // The child fork copies its ancestor's records, so the shared reply carries the same item id.
      await writeFile(rootPath, [
        meta,
        agent("turn-shared", "msg-shared", "tree-a shared"),
        agent("turn-root-only", "msg-root", "tree-a root"),
        agent("turn-shared", "msg-independent", "tree-a independent")
      ].join("\n"), "utf8");
      await writeFile(childPath, [
        meta,
        "unrelated child line",
        agent("turn-shared", "msg-shared", "tree-a shared"),
        agent("turn-child-only", "msg-child", "tree-a child")
      ].join("\n"), "utf8");
      await writeFile(otherPath, [meta, agent("turn-other", "msg-other", "tree-b other")].join("\n"), "utf8");
      const tree = (sessionId: string, path: string, treeId: string, treeTitle: string, treeActivityAt: string, activityAt: string) =>
        codexEntry(sessionId, path, fixture.workspaceId, { treeId, treeTitle, treeActivityAt, activityAt });
      const service = new WorkbenchService({
        ...fixture.options,
        sessionSearch: async () => [
          tree("tree-a-root", rootPath, "tree-a", "Tree A", "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
          tree("tree-a-child", childPath, "tree-a", "Tree A", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
          tree("tree-b-root", otherPath, "tree-b", "Tree B", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z")
        ],
        rolloutsDir: fixture.root
      });
      try {
        const result = await service.search({ query: "tree" });
        expect(result.hits.map((hit) => hit.title)).toEqual(["Tree B", "Tree A", "Tree A", "Tree A", "Tree A"]);
        expect(result.hits.filter((hit) => hit.turnId === "turn-shared")).toHaveLength(2);
        expect(result.hits.filter((hit) => hit.treeId === "tree-a")).toHaveLength(4);
        expect(result.hits[1]).toMatchObject({ sessionId: "tree-a-child", treeTitle: "Tree A" });
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

  it("keeps context bounded when a message is far larger than the preview", async () => {
    const fixture = await setup();
    try {
      const rolloutPath = join(fixture.root, "oversized.jsonl");
      const filler = "x".repeat(1_900_000);
      const reply = `${filler} oversized-needle ${filler}`;
      await writeFile(rolloutPath, [meta, agent("turn-huge", "huge", reply), agent("turn-huge", "after", "done")].join("\n"), "utf8");
      const service = new WorkbenchService({
        ...fixture.options,
        sessionSearch: async () => [codexEntry("huge-session", rolloutPath, fixture.workspaceId)],
        rolloutsDir: fixture.root
      });
      try {
        const result = await service.search({ query: "oversized-needle" });
        expect(result.hits).toHaveLength(1);
        const hit = result.hits[0]!;
        expect(hit).toMatchObject({ kind: "session", line: 2, turnId: "turn-huge", source: "agent" });
        // The column counts from the start of the reply even though the preview keeps only a window.
        expect(hit.column).toBe(reply.indexOf("oversized-needle") + 1);
        for (const line of hit.context) expect(line.text.length).toBeLessThanOrEqual(4_100);
        const hitLine = hit.context.find((line) => line.line === 2)!;
        expect(hitLine.matches).toHaveLength(1);
        expect(hitLine.text.slice(hitLine.matches[0]!.start, hitLine.matches[0]!.end)).toBe("oversized-needle");
      } finally {
        await service.dispose();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("streams hits for the active query and drops the one it replaced", async () => {
    const fixture = await setup();
    try {
      await fixture.service.writeDoc(fixture.workspaceId, ".vermillion/docs/stream.md", "streamed-needle\n");
      const events: WorkbenchEvent[] = [];
      const unsubscribe = fixture.service.subscribe((entry) => { events.push(entry); });
      try {
        const replaced = fixture.service.startSearch({ query: "streamed-needle" });
        const active = fixture.service.startSearch({ query: "streamed-needle" });
        await vi.waitFor(() => expect(events.some((entry) =>
          entry.type === "search.completed" && entry.queryId === active.queryId)).toBe(true));
        const hits = events.flatMap((entry) =>
          entry.type === "search.hits" && entry.queryId === active.queryId ? entry.hits : []);
        expect(hits.map((hit) => hit.path)).toContain(".vermillion/docs/stream.md");
        expect(events.some((entry) => "queryId" in entry && entry.queryId === replaced.queryId)).toBe(false);
      } finally {
        unsubscribe();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
