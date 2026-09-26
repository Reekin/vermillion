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
import { ExecutionConfigControl } from "./ExecutionConfigControl.js";
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

const threadGoalStatusLabels: Record<ThreadGoal["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  usageLimited: "用量已达上限",
  budgetLimited: "预算已达上限",
  complete: "已完成"
};

const threadGoalStatusLabel = (status: ThreadGoal["status"]): string =>
  threadGoalStatusLabels[status];

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
  pendingApprovals = [],
  pendingInteractions = [],
  contextUsage,
  threadGoal,
  beforeEditor,
  submitLabel,
  placeholder = "继续交谈，或补充工作要求…",
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
  pendingApprovals?: ApprovalRequest[];
  pendingInteractions?: RuntimeInteraction[];
  contextUsage?: ContextUsage;
  threadGoal?: ThreadGoal;
  /** Full-width content above the input and attachments. */
  beforeEditor?: ReactNode;
  submitLabel?: string;
  placeholder?: string;
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
  const primaryAction = submitLabel && hasComposedInput ? "send" : canStop && !isTurnActive
    ? "stop"
    : isTurnActive
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
    {beforeEditor ? <div className="awb-composer__before-editor">{beforeEditor}</div> : null}
    {selectedSkills.length > 0 ? (
      <div className="awb-composer-skills" aria-label="已选技能">
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
      <div className="awb-composer__attachments" aria-label="附件">
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
                aria-label={`预览 ${attachment.displayName}`}
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
              aria-label={`移除 ${attachment.displayName}`}
              onClick={() => onRemoveAttachment(attachment.attachment.attachmentId)}
            >
              ×
            </Button>
          </article>
        ))}
      </div>
    ) : null}
    {pendingApprovals.length > 0 ? (
      <section className="awb-composer-approvals" aria-label="待审批">
        <ApprovalFlowView
          approvals={pendingApprovals}
          onRespond={onRespondApproval}
        />
      </section>
    ) : null}
    {pendingInteractions.length > 0 ? (
      <section className="awb-composer-approvals" aria-label="待回答">
        <InteractionFlowView
          interactions={pendingInteractions}
          onRespond={onRespondInteraction}
        />
      </section>
    ) : null}
    <div className="awb-composer-panel__editor">
      <textarea
        ref={textareaRef}
        aria-label="消息"
        placeholder={placeholder}
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
      <div className="awb-composer-panel__editor-bottom">
        <span className="awb-composer__input-hint">Enter 发送 · Shift + Enter 换行</span>
        <Button
          variant="primary"
          size="icon"
          className="awb-composer__primary-action"
          aria-label={primaryAction === "stop" ? "停止" : submitLabel ?? (primaryAction === "steer" ? "补充到当前轮次" : "发送")}
          title={primaryAction === "stop" ? "停止" : submitLabel ?? (primaryAction === "steer" ? "补充到当前轮次" : "发送")}
          onClick={() =>
            primaryAction === "stop" ? void onStop() : void onPrimaryAction()
          }
          disabled={primaryDisabled}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {primaryAction === "stop" ? (
              <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
            ) : (
              <path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </Button>
      </div>
      <ComposerSuggestions
        suggestions={suggestions}
        onHover={onSuggestionHover}
        onSelect={onSuggestionSelect}
      />
    </div>
    <div className="awb-composer__actions awb-composer-panel__actions">
      <div className="awb-composer__meta">
        <ComposerStatusBar status={status} />
        {threadGoal ? (
          <div
            className={`awb-composer-goal awb-composer-goal--${threadGoal.status}`}
            aria-label={`目标 ${threadGoalStatusLabel(threadGoal.status)}: ${threadGoal.objective}`}
            title={threadGoal.objective}
          >
            <span className="awb-composer-goal__dot" aria-hidden="true" />
            <span className="awb-composer-goal__label">目标</span>
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
          <div className="awb-composer-execution" aria-label="本轮配置">
            {extraExecutionControls}
            <ExecutionConfigControl
              models={models}
              reasoningOptions={reasoningOptions}
              serviceTiers={serviceTiers}
              {...(selectedExecution ? { selectedExecution } : {})}
              {...(defaultReasoningLabel ? { defaultReasoningLabel } : {})}
              loading={isExecutionLoading}
              disabled={isExecutionDisabled}
              onModelChange={onModelChange}
              onReasoningOptionChange={onReasoningOptionChange}
              onServiceTierChange={onServiceTierChange}
            />
          </div>
        ) : null}
        {contextUsage ? (
          <div
            className="awb-composer-context"
            aria-label={`上下文用量 ${formatContextUsageLabel(contextUsage)}`}
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
              上下文 {formatContextUsageLabel(contextUsage)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  </footer>
  );
};
