// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ComposerPanel } from "../src/ui/chat-shell/composer/ComposerPanel.js";
import type { ComposerAttachment } from "../src/ui/chat-shell/composer-attachments.js";

afterEach(cleanup);

const imageAttachment = (
  attachmentId: string,
  name: string,
  previewUrl: string
): ComposerAttachment => ({
  attachment: {
    attachmentId,
    mimeType: "image/png",
    name,
    uri: previewUrl
  },
  dedupeKey: attachmentId,
  displayName: name,
  isImage: true,
  mimeType: "image/png",
  previewUrl,
  releasePreviewUrl: false,
  size: 4,
  sizeLabel: "4 B"
});

const baseProps: ComponentProps<typeof ComposerPanel> = {
  isDropTarget: false,
  textareaRef: { current: null },
  draft: "",
  selectedSkills: [],
  attachments: [],
  queue: [],
  suggestions: undefined,
  status: { kind: "idle", label: "Ready" },
  intent: "send",
  supportsSteer: true,
  models: [],
  reasoningOptions: [],
  serviceTiers: [],
  isExecutionLoading: false,
  isExecutionDisabled: false,
  hasComposedInput: false,
  isTurnActive: false,
  canSubmit: true,
  canStop: false,
  onTextareaChange: () => undefined,
  onTextareaSelect: () => undefined,
  onInputKeyDown: async () => undefined,
  onPaste: () => undefined,
  onDragEnter: () => undefined,
  onDragOver: () => undefined,
  onDragLeave: () => undefined,
  onDrop: () => undefined,
  onRemoveSkill: () => undefined,
  onRemoveAttachment: () => undefined,
  onPreviewAttachment: () => undefined,
  onPrimaryAction: async () => undefined,
  onStop: async () => undefined,
  onModelChange: () => undefined,
  onReasoningOptionChange: () => undefined,
  onServiceTierChange: () => undefined,
  onSuggestionHover: () => undefined,
  onSuggestionSelect: async () => undefined,
  onEditQueuedMessage: () => undefined,
  onDeleteQueuedMessage: () => undefined,
  onSendQueuedMessageNow: async () => undefined,
  onSteerQueuedMessageNow: async () => undefined
};

describe("ComposerPanel", () => {
  it("renders provider-native model and reasoning options and locks them while steering", () => {
    render(
      <ComposerPanel
        {...baseProps}
        draft="Refine the current turn"
        status={{ kind: "running", label: "Running" }}
        intent="steer"
        models={[
          {
            modelId: "gpt-5.5-codex",
            displayName: "GPT-5.5 Codex",
            reasoningOptions: [
              { optionId: "xhigh", displayName: "Extra high" }
            ],
            serviceTiers: [
              { tierId: "priority", displayName: "Fast" },
              { tierId: "ultrafast", displayName: "Ultrafast" }
            ],
            isDefault: true
          }
        ]}
        selectedExecution={{
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "xhigh",
          serviceTierId: "ultrafast"
        }}
        reasoningOptions={[
          { optionId: "xhigh", displayName: "Extra high" }
        ]}
        serviceTiers={[
          { tierId: "priority", displayName: "Fast" },
          { tierId: "ultrafast", displayName: "Ultrafast" }
        ]}
        isExecutionDisabled={true}
        hasComposedInput={true}
        isTurnActive={true}
        canStop={true}
        onPreviewAttachment={undefined}
      />
    );

    for (const [name, value] of [["模型", "gpt-5.5-codex"], ["推理", "xhigh"], ["速度", "ultrafast"]]) {
      const select = screen.getByRole<HTMLSelectElement>("combobox", { name });
      expect(select.value).toBe(value);
      expect(select.disabled).toBe(true);
    }
    expect(screen.getByRole("option", { name: "标准" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "默认" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
  });

  it("previews and removes the selected attachment", async () => {
    const preview = vi.fn();
    const remove = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerPanel
        {...baseProps}
        attachments={[
          imageAttachment("image-1", "first.png", "data:image/png;base64,AAAA"),
          imageAttachment("image-2", "second.png", "data:image/png;base64,BBBB")
        ]}
        hasComposedInput={true}
        onPreviewAttachment={preview}
        onRemoveAttachment={remove}
      />
    );

    expect(screen.getAllByRole("button", { name: /^Preview / })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Preview second.png" }));
    expect(preview).toHaveBeenCalledExactlyOnceWith({ src: "data:image/png;base64,BBBB", alt: "second.png" });
    await user.click(screen.getByRole("button", { name: "Remove first.png" }));
    expect(remove).toHaveBeenCalledExactlyOnceWith("image-1");
  });

  it("shows active session context usage when available", () => {
    render(
      <ComposerPanel
        {...baseProps}
        contextUsage={{
          usedTokens: 42000,
          contextWindow: 128000,
          inputTokens: 40000,
          cachedInputTokens: 12000,
          outputTokens: 1200,
          reasoningOutputTokens: 800,
          lastUsedTokens: 2200
        }}
      />
    );

    expect(screen.getByLabelText("Context usage 33% · 42.0k/128k")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toBe("Context 33% · 42.0k/128k");
  });

  it("renders the goal badge as passive status text", () => {
    render(
      <ComposerPanel
        {...baseProps}
        threadGoal={{
          sessionId: "session-1",
          threadId: "thread-1",
          objective: "Keep the goal badge tidy",
          status: "active",
          tokenBudget: 12000,
          tokensUsed: 4000,
          timeUsedSeconds: 10,
          createdAt: 1700000000000,
          updatedAt: 1700000001000
        }}
      />
    );

    const goal = screen.getByText("Keep the goal badge tidy");
    expect(screen.getByText("4.0k/12.0k")).toBeTruthy();
    expect(goal.closest("button, a, input, select, textarea, [tabindex]")).toBeNull();
  });

  it("submits the selected pending approval", async () => {
    const respond = vi.fn(async () => {});
    render(
      <ComposerPanel
        {...baseProps}
        status={{ kind: "awaiting_approval", label: "Awaiting approval" }}
        pendingApprovals={[
          {
            requestId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            approvalKind: "command",
            status: "pending",
            title: "Run shell command",
            details: "echo hello",
            availableActions: [],
            requestedAt: "2026-04-26T00:00:00.000Z"
          }
        ]}
        isTurnActive={true}
        canSubmit={false}
        onRespondApproval={respond}
      />
    );

    const approval = within(screen.getByRole("region", { name: "Pending approvals" }));
    expect(approval.getByText("Run shell command")).toBeTruthy();
    expect(approval.getByText("echo hello")).toBeTruthy();
    await userEvent.setup().click(approval.getByRole("button", { name: "Approve" }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1", requestId: "approval-1", action: "approve", decision: "accept"
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});
