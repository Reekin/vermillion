import { describe, expect, it } from "vitest";
import type { ToolCall } from "./domain.js";
import {
  actionsFromCommand,
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
  it("uses structured read actions and counts output lines", () => {
    const step = describeToolStep(
      call({ actions: [{ kind: "read", target: "C:\\project\\README.md" }], inputSummary: pwsh("Get-Content README.md") }),
      { text: "# Title\n\nbody\nmore\n", exitCode: 0 }
    );
    expect(step).toMatchObject({ kind: "read", verb: "读取", object: "README.md", result: "4 行", failed: false });
  });

  it("maps each structured kind", () => {
    expect(describeToolStep(call({ actions: [{ kind: "list", target: "src" }] }), { text: "a\nb" }))
      .toMatchObject({ kind: "list", object: "src", result: "2 个条目" });
    expect(describeToolStep(call({ actions: [{ kind: "search", target: "TODO", path: "src" }] }), { text: "a:1\nb:2", exitCode: 0 }))
      .toMatchObject({ kind: "search", object: "“TODO” · src", result: "2 处匹配" });
    expect(describeToolStep(call({ actions: [{ kind: "search", target: "nothing" }] }), { text: "", exitCode: 1 }))
      .toMatchObject({ kind: "search", result: "无匹配", failed: false });
  });

  it("reads unknown pwsh commands heuristically", () => {
    const command = pwsh("Get-Location; rg --files -g 'AGENTS.md' -g '!node_modules'");
    expect(actionsFromCommand(command)).toEqual([{ kind: "list" }]);
    expect(actionsFromCommand("sed -n '1,80p' src/app.ts")).toEqual([{ kind: "read", target: "src/app.ts" }]);
    expect(actionsFromCommand("rg -n useState apps/desktop | head -20"))
      .toEqual([{ kind: "search", target: "useState", path: "apps/desktop" }]);
    expect(actionsFromCommand(pwsh("Get-Content -Raw README.md"))).toEqual([{ kind: "read", target: "README.md" }]);
  });

  it("falls back to a readable run step without shell wrapper or escapes", () => {
    const step = describeToolStep(call({ inputSummary: pwsh("git status --short") }), { text: "", exitCode: 0 });
    expect(step).toMatchObject({ kind: "run", verb: "运行", object: "git status --short", result: "无输出" });
    expect(step.object).not.toContain("pwsh");
    expect(commandHead("bash -lc 'pnpm test\nsecond line'")).toBe("pnpm test");
  });

  it("counts listing entries without pwsh headers", () => {
    const listing = [
      "",
      "    Directory: C:\\p",
      "",
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "d----          2026/9/26    20:00                .vermillion",
      "-a---          2026/9/26    20:00             27 README.md",
      ""
    ].join(String.fromCharCode(10));
    expect(describeToolStep(call({ inputSummary: pwsh("Get-ChildItem") }), { text: listing, exitCode: 0 }))
      .toMatchObject({ kind: "list", result: "2 个条目" });
    expect(describeToolStep(call({ inputSummary: "ls -la" }), { text: ["total 8", ".", "..", "a.ts"].join(String.fromCharCode(10)), exitCode: 0 }).result)
      .toBe("1 个条目");
    const selected = ["", "Mode   Name", "----   ----", "d--h-- .git", "d----- .vermillion", "-a---- README.md", ""];
    expect(describeToolStep(call({ inputSummary: pwsh("Get-ChildItem -Force | Select-Object Mode, Name") }), {
      text: selected.join(String.fromCharCode(10)),
      exitCode: 0
    }).result).toBe("3 个条目");
    const localized = [
      "",
      "    目录: C:\\project",
      "",
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "d--h--          2026/9/26    20:00                .git",
      "-a----          2026/9/26    20:00             27 README.md"
    ];
    expect(describeToolStep(call({ inputSummary: pwsh("Get-ChildItem -Force") }), {
      text: localized.join(String.fromCharCode(10)),
      exitCode: 0
    }).result).toBe("2 个条目");
  });

  it("shows commands mixing action kinds, or with setup first, by their first real command", () => {
    const mixed = describeToolStep(call({ inputSummary: pwsh("Get-ChildItem; Get-Content README.md") }), { text: "x", exitCode: 0 });
    expect(mixed).toMatchObject({ kind: "run", object: "Get-ChildItem" });
    expect(describeToolStep(call({ inputSummary: "Set-Location src; $x = 1; git status" }), { text: "", exitCode: 0 }))
      .toMatchObject({ kind: "run", object: "git status" });
  });

  it("reports failures with a readable reason", () => {
    const missing = describeToolStep(
      call({ status: "failed", inputSummary: pwsh("Get-Content AGENTS.md") }),
      { text: "Get-Content: Cannot find path 'C:\\p\\AGENTS.md' because it does not exist.", exitCode: 1 }
    );
    expect(missing).toMatchObject({ kind: "read", object: "AGENTS.md", result: "不存在", failed: true });
    expect(describeToolStep(call({ inputSummary: "pnpm build" }), { text: "error TS2322", exitCode: 2 }))
      .toMatchObject({ failed: true, result: "失败 · 退出码 2" });
  });

  it("maps named tools and non-command tool types", () => {
    expect(actionsFromNamedTool("read", { path: "a/b.md" })).toEqual([{ kind: "read", target: "a/b.md" }]);
    expect(actionsFromNamedTool("grep", { pattern: "x", path: "src" })).toEqual([{ kind: "search", target: "x", path: "src" }]);
    expect(actionsFromNamedTool("write", { path: "f.ts" })).toEqual([{ kind: "edit", target: "f.ts" }]);
    expect(describeToolStep(call({ toolName: "read", inputSummary: JSON.stringify({ path: "docs/x.md" }) }), { text: "1\n2" }))
      .toMatchObject({ kind: "read", object: "x.md", result: "2 行" });
    expect(describeToolStep(call({ toolName: "reasoning", outputSummary: "**Plan**\nnext" })))
      .toMatchObject({ kind: "think", verb: "思考", object: "Plan" });
    expect(describeToolStep(call({ toolName: "mcp.docs.search", inputSummary: "{\"q\":1}" })))
      .toMatchObject({ kind: "other", object: "mcp.docs.search" });
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
