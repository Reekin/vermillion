import { useState, type ReactNode } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  RefObject
} from "react";
import type {
  ApprovalRequest,
  ContextUsage,
  EngineModelRpc,
  EngineReasoningOptionRpc,
  EngineServiceTierRpc,
  RuntimeInteraction,
  ThreadGoal
} from "@vermillion/shared";
import { Button } from "../Button.js";
import type { ComposerAttachment } from "../composer-attachments.js";
import type { ImageLightboxState } from "../ImageLightbox.js";
import {
  ApprovalFlowView,
  type ApprovalResponseInput
} from "../ApprovalFlowView.js";
import {
  InteractionFlowView,
  type InteractionResponseInput
} from "../InteractionFlowView.js";
import { ConfigurationSelect } from "./ConfigurationControl.js";
import { ComposerQueue } from "./ComposerQueue.js";
import { ComposerStatusBar } from "./ComposerStatusBar.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";
import type {
  ComposerStatusModel,
  ComposerStatusNotice
} from "../composer-status.js";
import type {
  ComposerIntent,
  ComposerExecutionSelection,
  ComposerSkillReference,
  QueuedComposerMessage,
  ComposerSuggestionState
} from "./composer-types.js";

const composerEditorMinHeight = 76;
const composerTranscriptMinHeight = 120;

const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return String(value);
};

const contextUsagePercent = (contextUsage: ContextUsage): number | undefined => {
  if (!contextUsage.contextWindow) {
    return undefined;
  }
  return Math.min(
    100,
    Math.max(0, Math.round((contextUsage.usedTokens / contextUsage.contextWindow) * 100))
  );
};

const formatContextUsageLabel = (contextUsage: ContextUsage): string => {
  const percent = contextUsagePercent(contextUsage);
  const usedTokens = formatTokenCount(contextUsage.usedTokens);
  if (percent === undefined || !contextUsage.contextWindow) {
    return `${usedTokens} tokens`;
  }
  return `${percent}% · ${usedTokens}/${formatTokenCount(contextUsage.contextWindow)}`;
};

const threadGoalStatusLabel = (status: ThreadGoal["status"]): string => {
  switch (status) {
    case "budgetLimited":
      return "Budget";
    case "usageLimited":
      return "Usage";
    default:
      return status[0]?.toUpperCase() + status.slice(1);
  }
};

const formatThreadGoalUsage = (goal: ThreadGoal): string | undefined => {
  if (!goal.tokenBudget) {
    return goal.tokensUsed > 0 ? `${formatTokenCount(goal.tokensUsed)} tokens` : undefined;
  }
  return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
};

export const ComposerPanel = ({
  isDropTarget,
  textareaRef,
  draft,
  selectedSkills,
  attachments,
  queue,
  suggestions,
  status,
  statusNotice,
  pendingApprovals = [],
  pendingInteractions = [],
  contextUsage,
  threadGoal,
  extraExecutionControls,
  intent,
  supportsSteer,
  models = [],
  selectedExecution,
  reasoningOptions = [],
  serviceTiers = [],
  isExecutionLoading = false,
  isExecutionDisabled = false,
  hasComposedInput,
  isTurnActive,
  canSubmit,
  canStop,
  onTextareaChange,
  onTextareaSelect,
  onInputKeyDown,
  onPaste,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onRemoveSkill,
  onRemoveAttachment,
  onPreviewAttachment,
  onPrimaryAction,
  onStop,
  onModelChange,
  onReasoningOptionChange,
  onServiceTierChange,
  onSuggestionHover,
  onSuggestionSelect,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onSendQueuedMessageNow,
  onSteerQueuedMessageNow,
  onRespondApproval,
  onRespondInteraction
}: {
  isDropTarget: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  selectedSkills: ComposerSkillReference[];
  attachments: ComposerAttachment[];
  queue: QueuedComposerMessage[];
  suggestions: ComposerSuggestionState | undefined;
  status: ComposerStatusModel;
  statusNotice?: ComposerStatusNotice;
  pendingApprovals?: ApprovalRequest[];
  pendingInteractions?: RuntimeInteraction[];
  contextUsage?: ContextUsage;
  threadGoal?: ThreadGoal;
  /** Rendered before the Model select inside the turn-configuration group. */
  extraExecutionControls?: ReactNode;
  intent: ComposerIntent;
  supportsSteer: boolean;
  models: EngineModelRpc[];
  selectedExecution?: ComposerExecutionSelection;
  reasoningOptions: EngineReasoningOptionRpc[];
  serviceTiers: EngineServiceTierRpc[];
  isExecutionLoading: boolean;
  isExecutionDisabled: boolean;
  hasComposedInput: boolean;
  isTurnActive: boolean;
  canSubmit: boolean;
  canStop: boolean;
  onTextareaChange: (value: string, selectionStart?: number | null) => void;
  onTextareaSelect: (selectionStart: number) => void;
  onInputKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => Promise<void>;
  onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onRemoveSkill: (skillId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewAttachment?: (input: ImageLightboxState) => void;
  onPrimaryAction: () => Promise<void>;
  onStop: () => Promise<void>;
  onModelChange: (modelId: string) => void;
  onReasoningOptionChange: (reasoningOptionId: string) => void;
  onServiceTierChange: (serviceTierId: string) => void;
  onSuggestionHover: (index: number) => void;
  onSuggestionSelect: (index: number) => Promise<void>;
  onEditQueuedMessage: (messageId: string) => void;
  onDeleteQueuedMessage: (messageId: string) => void;
  onSendQueuedMessageNow: (messageId: string) => Promise<void>;
  onSteerQueuedMessageNow: (messageId: string) => Promise<void>;
  onRespondApproval?: (input: ApprovalResponseInput) => Promise<void>;
  onRespondInteraction?: (input: InteractionResponseInput) => Promise<void>;
}): ReactElement => {
  const [editorHeight, setEditorHeight] = useState(composerEditorMinHeight);
  const selectedModel = models.find(
    (model) => model.modelId === selectedExecution?.modelId
  );
  const defaultReasoningLabel = selectedModel?.defaultReasoningOptionId
    ? reasoningOptions.find(
        (option) => option.optionId === selectedModel.defaultReasoningOptionId
      )?.displayName ?? selectedModel.defaultReasoningOptionId
    : undefined;
  const primaryAction = isTurnActive
    ? hasComposedInput
      ? "steer"
      : "stop"
    : "send";
  const primaryDisabled =
    primaryAction === "stop"
      ? !canStop
      : !canSubmit || (primaryAction === "steer" && intent !== "steer");
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    const startY = event.clientY;
    const startHeight = editorHeight;
    const transcriptHeight =
      event.currentTarget.parentElement?.previousElementSibling?.getBoundingClientRect()
        .height ?? 0;
    const maxHeight = Math.floor(
      startHeight + Math.max(0, transcriptHeight - composerTranscriptMinHeight)
    );
    const onPointerMove = (moveEvent: PointerEvent): void => {
      const nextHeight = Math.min(
        maxHeight,
        Math.max(
          composerEditorMinHeight,
          startHeight + startY - moveEvent.clientY
        )
      );
      setEditorHeight(Math.round(nextHeight));
      moveEvent.preventDefault();
    };
    const onPointerEnd = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    event.preventDefault();
  };
  const composerStyle = {
    "--awb-composer-editor-height": `${editorHeight}px`
  } as CSSProperties;

  return (
  <footer
    className={`awb-composer awb-composer-panel${
      isDropTarget ? " is-drop-target" : ""
    }`}
    style={composerStyle}
    onDragEnter={onDragEnter}
    onDragOver={onDragOver}
    onDragLeave={onDragLeave}
    onDrop={onDrop}
  >
    <div
      className="awb-composer__resize-handle"
      onPointerDown={onResizeStart}
    >
      <span aria-hidden="true" />
    </div>
    <ComposerQueue
      queue={queue}
      currentIntent={intent}
      supportsSteer={supportsSteer}
      onEdit={onEditQueuedMessage}
      onDelete={onDeleteQueuedMessage}
      onSendNow={onSendQueuedMessageNow}
      onSteerNow={onSteerQueuedMessageNow}
    />
    {selectedSkills.length > 0 ? (
      <div className="awb-composer-skills" aria-label="Selected skills">
        {selectedSkills.map((skill) => (
          <article key={skill.id} className="awb-composer-skill">
            <div className="awb-composer-skill__copy">
              <strong>{`$${skill.name}`}</strong>
              <span>{skill.shortDescription ?? skill.description ?? skill.path}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="awb-composer-skill__remove"
              onClick={() => onRemoveSkill(skill.id)}
            >
              Remove
            </Button>
          </article>
        ))}
      </div>
    ) : null}
    {attachments.length > 0 ? (
      <div className="awb-composer__attachments" aria-label="Composer attachments">
        {attachments.map((attachment) => (
          <article
            key={attachment.attachment.attachmentId}
            className="awb-composer__attachment"
          >
            {attachment.previewUrl ? (
              <button
                type="button"
                className="awb-composer__attachment-preview"
                onClick={() =>
                  onPreviewAttachment?.({
                    src: attachment.previewUrl ?? "",
                    alt: attachment.displayName
                  })
                }
                aria-label={`Preview ${attachment.displayName}`}
                disabled={!onPreviewAttachment}
              >
                <img src={attachment.previewUrl} alt={attachment.displayName} />
              </button>
            ) : (
              <div className="awb-composer__attachment-icon" aria-hidden="true">
                FILE
              </div>
            )}
            <div className="awb-composer__attachment-copy">
              <strong>{attachment.displayName}</strong>
              <span>
                {attachment.mimeType} · {attachment.sizeLabel}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="awb-composer__attachment-remove"
              aria-label={`Remove ${attachment.displayName}`}
              onClick={() => onRemoveAttachment(attachment.attachment.attachmentId)}
            >
              ×
            </Button>
          </article>
        ))}
      </div>
    ) : null}
    {pendingApprovals.length > 0 ? (
      <section className="awb-composer-approvals" aria-label="Pending approvals">
        <ApprovalFlowView
          approvals={pendingApprovals}
          onRespond={onRespondApproval}
        />
      </section>
    ) : null}
    {pendingInteractions.length > 0 ? (
      <section className="awb-composer-approvals" aria-label="Pending interactions">
        <InteractionFlowView
          interactions={pendingInteractions}
          onRespond={onRespondInteraction}
        />
      </section>
    ) : null}
    <div className="awb-composer-panel__editor">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) =>
          onTextareaChange(
            event.target.value,
            event.currentTarget.selectionStart
          )
        }
        onSelect={(event) => onTextareaSelect(event.currentTarget.selectionStart ?? 0)}
        onClick={(event) => onTextareaSelect(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => onTextareaSelect(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => void onInputKeyDown(event)}
        onPaste={onPaste}
      />
      <Button
        variant={primaryAction === "stop" ? "danger" : "accent"}
        size="lg"
        className="awb-composer__primary-action"
        onClick={() =>
          primaryAction === "stop" ? void onStop() : void onPrimaryAction()
        }
        disabled={primaryDisabled}
      >
        {primaryAction === "steer"
          ? "Steer"
          : primaryAction === "stop"
            ? "Stop"
            : "Send"}
      </Button>
      <ComposerSuggestions
        suggestions={suggestions}
        onHover={onSuggestionHover}
        onSelect={onSuggestionSelect}
      />
    </div>
    <div className="awb-composer__actions awb-composer-panel__actions">
      <div className="awb-composer__meta">
        <ComposerStatusBar status={status} notice={statusNotice} />
        {threadGoal ? (
          <div
            className={`awb-composer-goal awb-composer-goal--${threadGoal.status}`}
            aria-label={`Goal ${threadGoalStatusLabel(threadGoal.status)}: ${threadGoal.objective}`}
            title={threadGoal.objective}
          >
            <span className="awb-composer-goal__dot" aria-hidden="true" />
            <span className="awb-composer-goal__label">Goal</span>
            <span className="awb-composer-goal__status">
              {threadGoalStatusLabel(threadGoal.status)}
            </span>
            <span className="awb-composer-goal__objective">
              {threadGoal.objective}
            </span>
            {formatThreadGoalUsage(threadGoal) ? (
              <span className="awb-composer-goal__usage">
                {formatThreadGoalUsage(threadGoal)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="awb-composer__right-rail">
        {isExecutionLoading || models.length > 0 || extraExecutionControls ? (
          <div className="awb-composer-execution" aria-label="Turn configuration">
            {extraExecutionControls}
            <ConfigurationSelect label="模型"
              aria-label="模型"
              value={selectedExecution?.modelId ?? ""}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={isExecutionDisabled || isExecutionLoading || models.length === 0}
              >
              {isExecutionLoading ? <option value="">加载中…</option> : null}
              {models.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
              </ConfigurationSelect>
            {reasoningOptions.length > 0 ? (
              <ConfigurationSelect label="推理"
                aria-label="推理"
                value={selectedExecution?.reasoningOptionId ?? ""}
                onChange={(event) => onReasoningOptionChange(event.target.value)}
                disabled={isExecutionDisabled}
              >
                <option value="">
                  {defaultReasoningLabel
                    ? `默认 (${defaultReasoningLabel})`
                    : "默认"}
                </option>
                {reasoningOptions.map((option) => (
                  <option key={option.optionId} value={option.optionId}>
                    {option.displayName}
                  </option>
                ))}
              </ConfigurationSelect>
            ) : null}
            {serviceTiers.length > 0 ? (
              <ConfigurationSelect label="速度"
                aria-label="速度"
                value={selectedExecution?.serviceTierId ?? ""}
                onChange={(event) => onServiceTierChange(event.target.value)}
                disabled={isExecutionDisabled}
              >
                <option value="">标准</option>
                {serviceTiers.map((tier) => (
                  <option
                    key={tier.tierId}
                    value={tier.tierId}
                    title={tier.description}
                  >
                    {tier.displayName}
                  </option>
                ))}
              </ConfigurationSelect>
            ) : null}
          </div>
        ) : null}
        {contextUsage ? (
          <div
            className="awb-composer-context"
            aria-label={`Context usage ${formatContextUsageLabel(contextUsage)}`}
            tabIndex={0}
            style={
              {
                "--awb-composer-context-percent": `${
                  contextUsagePercent(contextUsage) ?? 0
                }%`
              } as CSSProperties
            }
          >
            <span className="awb-composer-context__ring" aria-hidden="true" />
            <span className="awb-composer-context__tooltip" role="tooltip">
              Context {formatContextUsageLabel(contextUsage)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  </footer>
  );
};
