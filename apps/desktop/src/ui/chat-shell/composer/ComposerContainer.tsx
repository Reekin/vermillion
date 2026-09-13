import type { SessionExecutionProfileInput } from "@vermillion/shared";
import type { ReactElement, ReactNode } from "react";
import { memo, useCallback, useEffect, useRef, useLayoutEffect } from "react";
import { recordUiOperation } from "../../../diagnostics/ui-performance.js";
import type {
  ApprovalRequest,
  Attachment,
  ChatTreeSendOperation,
  ChatSession,
  EngineSurfaceRpc,
  RuntimeInteraction,
  ThreadGoal,
  Turn,
  TurnExecutionProfile
} from "@vermillion/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { ImageLightboxState } from "../ImageLightbox.js";
import type { ComposerStatusNotice } from "../composer-status.js";
import type { ApprovalResponseInput } from "../ApprovalFlowView.js";
import type { InteractionResponseInput } from "../InteractionFlowView.js";
import { useComposerController } from "../use-composer-controller.js";
import { ComposerPanel } from "./ComposerPanel.js";
import type {
  ComposerActions,
  ComposerSubmitHandler,
  ComposerExecutionSelection,
  ComposerModelExecutionPreferences
} from "./composer-types.js";

export type ComposerContainerProps = {
  transport: DesktopTransport;
  extraExecutionControls?: ReactNode;
  activeSession?: ChatSession;
  activeSessionId?: string;
  draftKey?: string;
  contentDraftKey?: string;
  onComposerChange?: (actions: ComposerActions | undefined) => void;
  threadGoal?: ThreadGoal;
  selectedEngineId: string;
  engineSurface?: EngineSurfaceRpc;
  allowedModelIds?: string[];
  customModelReasoningOptionIds?: Record<string, string[]>;
  modelExecutionPreferences?: ComposerModelExecutionPreferences;
  lastExecution?: ComposerExecutionSelection;
  activeTurnExecutionProfile?: TurnExecutionProfile;
  pendingExecution?: ComposerExecutionSelection;
  pendingBranchSend?: ChatTreeSendOperation;
  recoveredBranchSends?: ChatTreeSendOperation[];
  onRecoveredBranchSendConsumed?: (operationId: string) => void;
  skillsCwd?: string;
  turns: Turn[];
  interruptTurns: Turn[];
  allowSessionLastTurnFallback?: boolean;
  approvals: ApprovalRequest[];
  interactions: RuntimeInteraction[];
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  createSession?: (input: { content: string; attachments: Attachment[]; execution?: SessionExecutionProfileInput }) => Promise<string>;
  initializeDraftExecution?: () => Promise<SessionExecutionProfileInput>;
  prepareSend?: () => Promise<string>;
  submitBranch?: (payload: Omit<import("../../../transport/desktop-transport.js").ChatSendInput, "sessionId">) => Promise<boolean>;
  autoSendQueuedMessages?: boolean;
  onResumeSession?: () => Promise<void>;
  onBeforeStop?: (sessionId: string) => Promise<"cancelled" | void>;
  onCancelBranchSend?: (operationId: string) => Promise<void>;
  onRequestTranscriptBottom?: (sessionId: string) => void;
  onExecutionPreferenceChange?: (
    engineId: string,
    execution: ComposerExecutionSelection
  ) => void;
  onRespondApproval?: (input: ApprovalResponseInput) => Promise<void>;
  onRespondInteraction?: (input: InteractionResponseInput) => Promise<void>;
};

export const ComposerContainer = memo(({
  transport,
  extraExecutionControls,
  activeSession,
  activeSessionId,
  draftKey,
  contentDraftKey,
  onComposerChange,
  threadGoal,
  selectedEngineId,
  engineSurface,
  allowedModelIds,
  customModelReasoningOptionIds,
  modelExecutionPreferences,
  lastExecution,
  activeTurnExecutionProfile,
  pendingExecution,
  pendingBranchSend,
  recoveredBranchSends,
  onRecoveredBranchSendConsumed,
  skillsCwd,
  turns,
  interruptTurns,
  allowSessionLastTurnFallback,
  approvals,
  interactions,
  isOpeningSelectedSession,
  statusNotice,
  onStatusNotice,
  onPreviewImage,
  createSession,
  initializeDraftExecution,
  prepareSend,
  submitBranch,
  autoSendQueuedMessages,
  onResumeSession,
  onBeforeStop,
  onCancelBranchSend,
  onRequestTranscriptBottom,
  onExecutionPreferenceChange,
  onRespondApproval,
  onRespondInteraction
}: ComposerContainerProps): ReactElement => {
  const renderStartedAt = performance.now();
  useLayoutEffect(() => { recordUiOperation("react.composer.commit", renderStartedAt, undefined, "render"); });
  const composer = useComposerController({
    transport,
    activeSession,
    activeSessionId,
    draftKey,
    contentDraftKey,
    threadGoal,
    selectedEngineId,
    engineSurface,
    allowedModelIds,
    customModelReasoningOptionIds,
    modelExecutionPreferences,
    lastExecution,
    activeTurnExecutionProfile,
    pendingExecution,
    pendingBranchSend,
    recoveredBranchSends,
    onRecoveredBranchSendConsumed,
    skillsCwd,
    turns,
    interruptTurns,
    allowSessionLastTurnFallback,
    approvals,
    isOpeningSelectedSession,
    statusNotice,
    onStatusNotice,
    createSession,
    initializeDraftExecution,
    prepareSend,
    submitBranch,
    autoSendQueuedMessages,
    onResumeSession,
    onBeforeStop,
    onCancelBranchSend,
    onRequestTranscriptBottom,
    onExecutionPreferenceChange
  });

  const submitRef = useRef(composer.onSubmitUsing);
  submitRef.current = composer.onSubmitUsing;
  const submitUsing = useCallback((handler: ComposerSubmitHandler) => submitRef.current(handler), []);
  useEffect(() => {
    onComposerChange?.({ hasContent: composer.hasComposedInput, canSubmit: composer.canSubmit, submitUsing });
  }, [onComposerChange, composer.hasComposedInput, composer.canSubmit, submitUsing]);
  useEffect(() => () => onComposerChange?.(undefined), [onComposerChange]);

  return (
    <ComposerPanel
      extraExecutionControls={extraExecutionControls}
      isDropTarget={composer.isDropTarget}
      textareaRef={composer.composerTextareaRef}
      draft={composer.draft}
      selectedSkills={composer.selectedSkills}
      attachments={composer.attachments}
      queue={composer.queue}
      suggestions={composer.suggestions}
      status={composer.status}
      statusNotice={statusNotice}
      pendingApprovals={approvals.filter((approval) => approval.status === "pending")}
      pendingInteractions={interactions.filter(
        (interaction) => interaction.status === "pending"
      )}
      contextUsage={activeSession?.contextUsage}
      threadGoal={threadGoal}
      intent={composer.intent}
      supportsSteer={composer.capabilities.supportsSteer}
      models={composer.models}
      selectedExecution={composer.execution}
      reasoningOptions={composer.reasoningOptions}
      serviceTiers={composer.serviceTiers}
      isExecutionLoading={composer.isExecutionLoading}
      isExecutionDisabled={composer.isExecutionDisabled}
      hasComposedInput={composer.hasComposedInput}
      isTurnActive={composer.isTurnActive}
      canSubmit={composer.canSubmit}
      canStop={composer.canStop}
      onTextareaChange={composer.onDraftChange}
      onTextareaSelect={composer.onTextareaSelect}
      onInputKeyDown={composer.onInputKeyDown}
      onPaste={composer.onComposerPaste}
      onDragEnter={composer.onComposerDragEnter}
      onDragOver={composer.onComposerDragOver}
      onDragLeave={composer.onComposerDragLeave}
      onDrop={composer.onComposerDrop}
      onRemoveSkill={composer.onRemoveSkill}
      onRemoveAttachment={composer.onRemoveAttachment}
      onPreviewAttachment={onPreviewImage}
      onPrimaryAction={composer.onPrimaryAction}
      onStop={composer.onStop}
      onModelChange={composer.onModelChange}
      onReasoningOptionChange={composer.onReasoningOptionChange}
      onServiceTierChange={composer.onServiceTierChange}
      onSuggestionHover={composer.onSuggestionHover}
      onSuggestionSelect={async (index) => {
        const item = composer.suggestions?.items[index];
        if (item) {
          await composer.onSuggestionSelect(item);
        }
      }}
      onEditQueuedMessage={composer.onEditQueuedMessage}
      onDeleteQueuedMessage={composer.onDeleteQueuedMessage}
      onSendQueuedMessageNow={composer.onSendQueuedMessageNow}
      onSteerQueuedMessageNow={composer.onSteerQueuedMessageNow}
      onRespondApproval={onRespondApproval}
      onRespondInteraction={onRespondInteraction}
    />
  );
});
