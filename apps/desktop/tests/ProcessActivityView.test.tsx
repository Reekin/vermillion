// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { TerminalStream, ToolCall } from "@vermillion/shared";
import { ProcessActivityView } from "../src/ui/chat-shell/ProcessActivityView.js";

afterEach(cleanup);

const tool = (patch: Partial<ToolCall>): ToolCall => ({
  toolCallId: "tool-1",
  sessionId: "session-1",
  turnId: "turn-1",
  toolName: "commandExecution",
  status: "completed",
  startedAt: "2026-04-18T00:00:01.000Z",
  completedAt: "2026-04-18T00:00:02.000Z",
  ...patch
});

const stream = (patch: Partial<TerminalStream>): TerminalStream => ({
  terminalId: "tool-1",
  sessionId: "session-1",
  turnId: "turn-1",
  toolCallId: "tool-1",
  status: "completed",
  outputText: "",
  exitCode: 0,
  startedAt: "2026-04-18T00:00:01.000Z",
  completedAt: "2026-04-18T00:00:02.000Z",
  ...patch
});

const pwsh = (inner: string) => `"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "${inner}"`;

describe("ProcessActivityView", () => {
  it("shows a command as one readable step and reveals the raw command only when opened", async () => {
    const { container } = render(
      <ProcessActivityView
        toolCalls={[tool({ inputSummary: pwsh("git status --short"), outputSummary: "fallback output" })]}
        terminalStreams={[stream({ outputText: " M src/app.ts\n" })]}
      />
    );

    const steps = container.querySelectorAll(".awb-process-step");
    expect(steps).toHaveLength(1);
    const summary = screen.getByText("运行").closest("summary")!;
    expect(summary.textContent).toContain("git status --short");
    expect(summary.textContent).toContain("输出 1 行");
    expect(summary.textContent).not.toContain("pwsh");
    expect(summary.textContent).not.toMatch(/Shell|completed|exit/);

    const details = steps[0] as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(details.querySelector(".awb-process-step__input")?.textContent).toContain("pwsh.exe");
    expect(details.querySelector(".awb-process-step__output")?.textContent).toContain("M src/app.ts");
  });

  it("marks a failed read with a readable reason", () => {
    const { container } = render(
      <ProcessActivityView
        toolCalls={[tool({ status: "failed", inputSummary: pwsh("Get-Content AGENTS.md") })]}
        terminalStreams={[
          stream({ status: "failed", exitCode: 1, outputText: "Get-Content: Cannot find path 'C:\\p\\AGENTS.md' because it does not exist." })
        ]}
      />
    );

    const step = container.querySelector(".awb-process-step")!;
    expect(step.getAttribute("data-failed")).toBe("true");
    expect(step.querySelector(".awb-process-step__verb")?.textContent).toBe("读取");
    expect(step.querySelector(".awb-process-step__object")?.textContent).toBe("AGENTS.md");
    expect(step.querySelector(".awb-process-step__result")?.textContent).toBe("不存在");
  });

  it("uses structured actions and shows running steps as in progress", () => {
    const { container } = render(
      <ProcessActivityView
        toolCalls={[
          tool({ toolCallId: "list", actions: [{ kind: "list", target: "src" }], inputSummary: "ls src" }),
          tool({ toolCallId: "compact", toolName: "contextCompaction", status: "running", startedAt: "2026-04-18T00:00:03.000Z" })
        ]}
        terminalStreams={[stream({ terminalId: "list", toolCallId: "list", outputText: "a.ts\nb.ts\n" })]}
      />
    );

    const rows = [...container.querySelectorAll(".awb-process-step__row")].map((row) => row.textContent);
    expect(rows).toEqual(["列目录src2 项", "压缩上下文进行中"]);
  });

  it("shows image output as a preview with the cache-busted URL", async () => {
    const onPreviewImage = vi.fn();
    const { container } = render(
      <ProcessActivityView
        toolCalls={[
          tool({
            toolCallId: "image-1",
            toolName: "imageView",
            inputSummary: "I:/images/image (1).png",
            outputSummary: "![Viewed image](file:///I:/images/image%20(1).png)\npath: I:/images/image (1).png"
          })
        ]}
        terminalStreams={[]}
        onPreviewImage={onPreviewImage}
      />
    );

    expect(container.querySelector(".awb-process-step__object")?.textContent).toBe("image (1).png");
    await userEvent.click(container.querySelector("summary")!);
    await userEvent.click(container.querySelector(".awb-inline-image-button")!);
    expect(onPreviewImage).toHaveBeenCalledWith({
      src: "file:///I:/images/image%20(1).png?awb_image_cache=tool%3Aimage-1",
      alt: "Viewed image"
    });
    expect(container.textContent).not.toContain("path: I:/images/image (1).png");
  });
});
