import { describe, expect, it } from "vitest";
import type { ToolCall } from "./domain.js";
import {
  actionsFromNamedTool,
  commandHead,
  describeToolStep,
  formatDurationZh,
  summarizeToolSteps
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

describe("tool actions", () => {
  it("uses the engine's classified actions and reports output lines as printed", () => {
    const step = describeToolStep(
      call({ actions: [{ kind: "read", target: "C:\\project\\README.md" }], inputSummary: pwsh("Get-Content README.md") }),
      { text: "# Title\n\nbody\nmore\n", exitCode: 0 }
    );
    expect(step).toMatchObject({ kind: "read", verb: "读取", object: "README.md", result: "输出 4 行", failed: false });
    expect(describeToolStep(call({ actions: [{ kind: "list", target: "src" }] }), { text: "a\nb" }))
      .toMatchObject({ kind: "list", object: "src", result: "输出 2 行" });
    expect(describeToolStep(call({ actions: [{ kind: "search", target: "TODO", path: "src" }] }), { text: "a:1\nb:2", exitCode: 0 }))
      .toMatchObject({ kind: "search", object: "“TODO” · src", result: "输出 2 行" });
  });

  it("shows commands the engine did not classify as the command itself, without the shell wrapper", () => {
    const step = describeToolStep(call({ inputSummary: pwsh("git status --short") }), { text: "", exitCode: 0 });
    expect(step).toMatchObject({ kind: "run", verb: "运行", object: "git status --short", result: "无输出" });
    expect(step.object).not.toContain("pwsh");
    expect(commandHead("bash -lc 'pnpm test\nsecond line'")).toBe("pnpm test");
    // Commands that only look like reads or listings are not reinterpreted.
    expect(describeToolStep(call({ inputSummary: "bash -lc 'rg --files -g *.tmp | xargs rm'" }), { text: "", exitCode: 0 }))
      .toMatchObject({ kind: "run", object: "rg --files -g *.tmp | xargs rm" });
    expect(describeToolStep(call({ inputSummary: "bash -lc 'cat > notes.md <<EOF\nhello\nEOF'" }), { text: "", exitCode: 0 }))
      .toMatchObject({ kind: "run", object: "cat > notes.md <<EOF" });
    // Engine actions of mixed kinds, or with unclassified parts, read as the whole command.
    const mixed = describeToolStep(call({
      inputSummary: pwsh("Get-ChildItem; Get-Content README.md"),
      actions: [{ kind: "list" }, { kind: "read", target: "README.md" }]
    }), { text: "x", exitCode: 0 });
    expect(mixed).toMatchObject({ kind: "run", object: "Get-ChildItem; Get-Content README.md" });
  });

  it("reports failures by exit code, not by reading the error text", () => {
    const missing = describeToolStep(
      call({ actions: [{ kind: "read", target: "AGENTS.md" }], inputSummary: pwsh("Get-Content AGENTS.md") }),
      { text: "Get-Content: Cannot find path 'C:\\p\\AGENTS.md' because it does not exist.", exitCode: 1 }
    );
    expect(missing).toMatchObject({ kind: "read", object: "AGENTS.md", result: "失败 · 退出码 1", failed: true });
    expect(describeToolStep(call({ inputSummary: "pnpm build" }), { text: "error TS2322", exitCode: 2 }))
      .toMatchObject({ failed: true, result: "失败 · 退出码 2" });
  });

  it("maps named tools and non-command tool types", () => {
    const targets = "targets: 01a0df3e-99a7-7ce1-91dd-808ee698fea9, 01a0df3e-a5b1-70c3-ae01-b3ae82f1c843";
    expect(describeToolStep(call({ toolName: "subagent.spawn", inputSummary: "任务：提炼情节单元\n先读口径文件\nmodel: gpt-5\n" + targets })))
      .toMatchObject({ kind: "agent", verb: "启动子代理", object: "任务：提炼情节单元" });
    expect(describeToolStep(call({ toolName: "subagent.wait", inputSummary: targets,
      outputSummary: "01a0df3e-99a7: completed — 原始场景 214 条\n01a0df3e-a5b1: running" })))
      .toMatchObject({ kind: "agent", verb: "等待子代理", object: "2 个", result: "1 个已完成", failed: false });
    expect(describeToolStep(call({ toolName: "subagent.close", inputSummary: targets })))
      .toMatchObject({ verb: "关闭子代理", object: "2 个" });
    expect(describeToolStep(call({ toolName: "subagent.wait", inputSummary: targets, outputSummary: "a: errored — boom" })))
      .toMatchObject({ result: "1 个出错", failed: true });
    expect(actionsFromNamedTool("read", { path: "a/b.md" })).toEqual([{ kind: "read", target: "a/b.md" }]);
    expect(actionsFromNamedTool("grep", { pattern: "x", path: "src" })).toEqual([{ kind: "search", target: "x", path: "src" }]);
    expect(actionsFromNamedTool("write", { path: "f.ts" })).toEqual([{ kind: "edit", target: "f.ts" }]);
    expect(actionsFromNamedTool("bash", { command: "rg --files | xargs rm" })).toEqual([{ kind: "run", target: "rg --files | xargs rm" }]);
    expect(describeToolStep(call({ toolName: "read", actions: actionsFromNamedTool("read", { path: "docs/x.md" }) }), { text: "1\n2" }))
      .toMatchObject({ kind: "read", object: "x.md", result: "输出 2 行" });
    expect(describeToolStep(call({ toolName: "bash", actions: actionsFromNamedTool("bash", { command: "pnpm test" }) }), { text: "" }))
      .toMatchObject({ kind: "run", object: "pnpm test" });
    expect(describeToolStep(call({ toolName: "webSearch", inputSummary: "Open page\nurl: https://example.com/docs" })))
      .toMatchObject({ kind: "web", object: "https://example.com/docs" });
    expect(describeToolStep(call({ toolName: "webSearch", inputSummary: "Search\nquery: tripo multiview" })))
      .toMatchObject({ kind: "web", object: "tripo multiview" });
    expect(describeToolStep(call({ toolName: "reasoning", outputSummary: "**Plan**\nnext" })))
      .toMatchObject({ kind: "think", verb: "思考", object: "Plan" });
    expect(describeToolStep(call({ toolName: "mcp.docs.search", inputSummary: "{\"q\":1}" })))
      .toMatchObject({ kind: "other", object: "mcp.docs.search" });
    expect(describeToolStep(call({ toolName: "exec", inputSummary: "text(await tools.web__run({}))" })))
      .toMatchObject({ kind: "other", verb: "调用", object: "exec" });
    expect(describeToolStep(call({ status: "running", inputSummary: "pnpm test" })).result).toBe("进行中");
  });

  it("summarizes a turn by kind with duration", () => {
    const steps = [
      describeToolStep(call({ actions: [{ kind: "list" }] }), { text: "a" }),
      describeToolStep(call({ actions: [{ kind: "read", target: "a.md" }] }), { text: "x" }),
      describeToolStep(call({ actions: [{ kind: "read", target: "b.md" }] }), { text: "x" }),
      describeToolStep(call({ inputSummary: "git status" }), { text: "", exitCode: 0 })
    ];
    expect(summarizeToolSteps(steps, { durationMs: 87_000 }))
      .toBe("列目录 1 次 · 读取 2 个文件 · 运行 1 条命令 · 1 分 27 秒");
    expect(summarizeToolSteps([], { messageCount: 2 })).toBe("2 条过程消息");
    expect(formatDurationZh(4_000)).toBe("4 秒");
    expect(formatDurationZh(3_900_000)).toBe("1 小时 5 分");
  });
});
