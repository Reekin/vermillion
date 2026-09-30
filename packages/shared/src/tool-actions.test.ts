import { describe, expect, it } from "vitest";
import type { ToolCall } from "./domain.js";
import {
  actionsFromNamedTool,
  commandHead,
  describeToolStep,
  summarizeToolSteps,
  toolStepObjectText
} from "./tool-actions.js";

const call = (patch: Partial<ToolCall>): ToolCall => ({
  toolCallId: "tool-1",
  sessionId: "session-1",
  turnId: "turn-1",
  toolName: "commandExecution",
  status: "completed",
  startedAt: "2026-09-26T00:00:00.000Z",
  ...patch
});

const pwsh = (inner: string) => `"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "${inner}"`;
const text = (value: string) => ({ kind: "text", text: value });

describe("tool actions", () => {
  it("uses the engine's classified actions and reports output lines as printed", () => {
    const step = describeToolStep(
      call({ actions: [{ kind: "read", target: "C:\\project\\README.md" }], inputSummary: pwsh("Get-Content README.md") }),
      { text: "# Title\n\nbody\nmore\n", exitCode: 0 }
    );
    expect(step).toMatchObject({ kind: "read", object: { kind: "files", names: ["README.md"] }, result: { kind: "output", lines: 4 }, failed: false });
    expect(describeToolStep(call({ actions: [{ kind: "list", target: "src" }] }), { text: "a\nb" }))
      .toMatchObject({ kind: "list", object: { kind: "directories", paths: ["src"] }, result: { kind: "output", lines: 2 } });
    expect(describeToolStep(call({ actions: [{ kind: "list" }] }), { text: "a" }).object)
      .toEqual({ kind: "directories", paths: ["."] });
    const search = describeToolStep(call({ actions: [{ kind: "search", target: "TODO", path: "src" }] }), { text: "a:1\nb:2", exitCode: 0 });
    expect(search).toMatchObject({ kind: "search", object: { kind: "pattern", pattern: "TODO", path: "src" } });
    expect(toolStepObjectText(search.object)).toBe("\"TODO\" · src");
  });

  it("reports an applied patch by the lines it added and deleted", () => {
    const patch = "diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n+more";
    const edit = call({ toolName: "fileChange", actions: [{ kind: "edit", target: "docs/a.md" }] });
    expect(describeToolStep(edit, { text: patch }))
      .toMatchObject({ kind: "edit", object: { kind: "files", names: ["a.md"] }, result: { kind: "diff", added: 2, deleted: 1 } });
    expect(describeToolStep(edit, { text: "Wrote docs/a.md" }).result).toBeUndefined();
  });

  it("shows commands the engine did not classify as the command itself, without the shell wrapper", () => {
    const step = describeToolStep(call({ inputSummary: pwsh("git status --short") }), { text: "", exitCode: 0 });
    expect(step).toMatchObject({ kind: "run", object: text("git status --short"), result: { kind: "output", lines: 0 } });
    expect(commandHead("bash -lc 'pnpm test\nsecond line'")).toBe("pnpm test");
    // Commands that only look like reads or listings are not reinterpreted.
    expect(describeToolStep(call({ inputSummary: "bash -lc 'rg --files -g *.tmp | xargs rm'" }), { text: "", exitCode: 0 }))
      .toMatchObject({ kind: "run", object: text("rg --files -g *.tmp | xargs rm") });
    expect(describeToolStep(call({ inputSummary: "bash -lc 'cat > notes.md <<EOF\nhello\nEOF'" }), { text: "", exitCode: 0 }))
      .toMatchObject({ kind: "run", object: text("cat > notes.md <<EOF") });
    // Engine actions of mixed kinds, or with unclassified parts, read as the whole command.
    const mixed = describeToolStep(call({
      inputSummary: pwsh("Get-ChildItem; Get-Content README.md"),
      actions: [{ kind: "list" }, { kind: "read", target: "README.md" }]
    }), { text: "x", exitCode: 0 });
    expect(mixed).toMatchObject({ kind: "run", object: text("Get-ChildItem; Get-Content README.md") });
  });

  it("reports failures by exit code, not by reading the error text", () => {
    const missing = describeToolStep(
      call({ actions: [{ kind: "read", target: "AGENTS.md" }], inputSummary: pwsh("Get-Content AGENTS.md") }),
      { text: "Get-Content: Cannot find path 'C:\\p\\AGENTS.md' because it does not exist.", exitCode: 1 }
    );
    expect(missing).toMatchObject({ kind: "read", result: { kind: "failed", exitCode: 1 }, failed: true });
    expect(describeToolStep(call({ inputSummary: "pnpm build" }), { text: "error TS2322", exitCode: 2 }))
      .toMatchObject({ failed: true, result: { kind: "failed", exitCode: 2 } });
  });

  it("maps named tools and non-command tool types", () => {
    const targets = "targets: 01a0df3e-99a7-7ce1-91dd-808ee698fea9, 01a0df3e-a5b1-70c3-ae01-b3ae82f1c843";
    expect(describeToolStep(call({ toolName: "subagent.spawn", inputSummary: "Task: outline the plot\nread the notes\nmodel: gpt-5\n" + targets })))
      .toMatchObject({ kind: "agent", agentAction: "spawn", object: text("Task: outline the plot") });
    expect(describeToolStep(call({ toolName: "subagent.wait", inputSummary: targets,
      outputSummary: "01a0df3e-99a7: completed — 214 scenes\n01a0df3e-a5b1: running" })))
      .toMatchObject({ kind: "agent", agentAction: "wait", object: { kind: "agents", count: 2 },
        result: { kind: "agents", errored: 0, completed: 1 }, failed: false });
    expect(describeToolStep(call({ toolName: "subagent.close", inputSummary: targets })))
      .toMatchObject({ agentAction: "close", object: { kind: "agents", count: 2 } });
    expect(describeToolStep(call({ toolName: "subagent.wait", inputSummary: targets, outputSummary: "a: errored — boom" })))
      .toMatchObject({ result: { kind: "agents", errored: 1, completed: 0 }, failed: true });
    expect(actionsFromNamedTool("read", { path: "a/b.md" })).toEqual([{ kind: "read", target: "a/b.md" }]);
    expect(actionsFromNamedTool("grep", { pattern: "x", path: "src" })).toEqual([{ kind: "search", target: "x", path: "src" }]);
    expect(actionsFromNamedTool("write", { path: "f.ts" })).toEqual([{ kind: "edit", target: "f.ts" }]);
    expect(actionsFromNamedTool("bash", { command: "rg --files | xargs rm" })).toEqual([{ kind: "run", target: "rg --files | xargs rm" }]);
    expect(describeToolStep(call({ toolName: "read", actions: actionsFromNamedTool("read", { path: "docs/x.md" }) }), { text: "1\n2" }))
      .toMatchObject({ kind: "read", object: { kind: "files", names: ["x.md"] }, result: { kind: "output", lines: 2 } });
    expect(describeToolStep(call({ toolName: "bash", actions: actionsFromNamedTool("bash", { command: "pnpm test" }) }), { text: "" }))
      .toMatchObject({ kind: "run", object: text("pnpm test") });
    expect(describeToolStep(call({ toolName: "webSearch", inputSummary: "Open page\nurl: https://example.com/docs" })))
      .toMatchObject({ kind: "web", object: text("https://example.com/docs") });
    expect(describeToolStep(call({ toolName: "webSearch", inputSummary: "Search\nquery: tripo multiview" })))
      .toMatchObject({ kind: "web", object: text("tripo multiview") });
    expect(describeToolStep(call({ toolName: "reasoning", outputSummary: "**Plan**\nnext" })))
      .toMatchObject({ kind: "think", object: text("Plan") });
    expect(describeToolStep(call({ toolName: "exec", inputSummary: "text(await tools.web__run({}))" })))
      .toMatchObject({ kind: "other", object: text("exec") });
    expect(describeToolStep(call({ status: "running", inputSummary: "pnpm test" })).result).toEqual({ kind: "running" });
  });

  it("summarizes a turn by kind with distinct file counts and duration", () => {
    const steps = [
      describeToolStep(call({ actions: [{ kind: "list" }] }), { text: "a" }),
      describeToolStep(call({ actions: [{ kind: "read", target: "a.md" }] }), { text: "x" }),
      describeToolStep(call({ actions: [{ kind: "read", target: "b.md" }] }), { text: "x" }),
      describeToolStep(call({ inputSummary: "git status" }), { text: "", exitCode: 3 })
    ];
    expect(summarizeToolSteps(steps, { durationMs: 87_000 })).toEqual({
      counts: [{ kind: "list", count: 1 }, { kind: "read", count: 2 }, { kind: "run", count: 1 }],
      failures: 1,
      durationMs: 87_000
    });
    expect(summarizeToolSteps([], { messageCount: 2 })).toEqual({ counts: [], messageCount: 2, failures: 0 });
  });
});
