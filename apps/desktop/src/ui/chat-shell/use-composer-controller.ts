import type {
  SessionExecutionProfile,
  SessionExecutionProfileInput,
  TurnExecutionProfile
} from "@vermillion/shared";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import type {
  ApprovalRequest,
  Attachment,
  ChatTreeSendOperation,
  ChatInteractionCapabilitiesRpc,
  ChatSession,
  EngineModelCatalogRpc,
  EngineModelRpc,
  EngineSurfaceRpc,
  SkillDescriptorRpc,
  ThreadGoal,
  Turn
} from "@vermillion/shared";
import { readSessionExecutionProfile } from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  createComposerAttachments,
  extractPastedMessageImages,
  mergeComposerAttachments,
  releaseComposerAttachments,
  restoreComposerAttachment,
  writeComposerAttachmentDraft,
  type ComposerAttachment
} from "./composer-attachments.js";
import {
  resolveComposerStatusModel,
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";
import { resolveSlashSuggestionItems } from "./composer/composer-suggestions.js";
import type {
  ComposerSkillReference,
  ComposerSubmitHandler,
  ComposerExecutionSelection,
  ComposerModelExecutionPreferences,
  ComposerIntent,
  ComposerSuggestionItem,
  ComposerSuggestionQuery,
  ComposerSuggestionState,
  ComposerViewModel,
  QueuedComposerMessage
} from "./composer/composer-types.js";

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.types ?? []).includes("Files");

const hasStringTransfer = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.items ?? []).some((item) => item.kind === "string");

const collectPastedImageFiles = (dataTransfer: DataTransfer | null): File[] => {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.items)
    .filter(
      (item) =>
        item.kind === "file" && item.type.toLowerCase().startsWith("image/")
    )
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
};

const filterSkills = (
  skills: SkillDescriptorRpc[],
  query: string
): SkillDescriptorRpc[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return skills;
  }
  return skills.filter((skill) =>
    [skill.name, skill.shortDescription, skill.description, skill.scope]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized))
  );
};

const dedupeSkills = (skills: SkillDescriptorRpc[]): SkillDescriptorRpc[] => {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.path}:${skill.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const toComposerSkillReference = (
  skill: SkillDescriptorRpc
): ComposerSkillReference => ({
  id: `${skill.path}:${skill.name}`,
  name: skill.name,
  path: skill.path,
  scope: skill.scope,
  enabled: skill.enabled,
  shortDescription: skill.shortDescription ?? undefined,
  description: skill.description
});

const serializeComposerContent = (
  text: string,
  skills: ComposerSkillReference[]
): string => {
  const normalizedText = text.trim();
  const serializedSkills = skills
    .map((skill) => `[$${skill.name}](${skill.path})`)
    .join("\n");

  if (serializedSkills && normalizedText) {
    return `${serializedSkills}\n\n${normalizedText}`;
  }
  if (serializedSkills) {
    return serializedSkills;
  }
  return normalizedText;
};

export const parseGoalSlashCommand = (
  text: string
):
  | { kind: "set"; objective: string }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "edit" }
  | { kind: "empty" }
  | undefined => {
  const trimmed = text.trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const argument = (match[1] ?? "").trim();
  if (!argument) {
    return { kind: "empty" };
  }
  switch (argument.toLocaleLowerCase()) {
    case "clear":
      return { kind: "clear" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "edit":
      return { kind: "edit" };
    default:
      return { kind: "set", objective: argument };
  }
};

export const goalCommandBlockedReason = (
  command: ReturnType<typeof parseGoalSlashCommand>,
  threadGoal?: ThreadGoal
): string | undefined => {
  if (command?.kind === "set" && threadGoal) {
    return "A goal is already set. Use /goal clear before setting a new goal.";
  }
  if (command?.kind === "edit") {
    return "Goal editing is not available here yet. Use /goal clear before setting a new goal.";
  }
  return undefined;
};

export const extractComposerSuggestionQuery = (
  text: string,
  cursor: number
): ComposerSuggestionQuery | undefined => {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)([/$])([^\s/$]*)$/u.exec(before);
  if (!match) {
    return undefined;
  }
  const trigger = match[1] as ComposerSuggestionQuery["trigger"];
  const query = match[2] ?? "";
  return {
    trigger,
    query,
    start: cursor - query.length - 1,
    end: cursor
  };
};

export const resolveComposerIntent = (input: {
  activeSession?: ChatSession;
  supportsSteer: boolean;
  activeTurnId?: string;
}): ComposerIntent => {
  if (
    input.activeSession?.status === "running" ||
    input.activeSession?.status === "awaiting_approval"
  ) {
    if (input.supportsSteer && input.activeTurnId) {
      return "steer";
    }
    return "queue";
  }
  return "send";
};

export const resolveComposerModels = (input: {
  catalog?: EngineModelCatalogRpc;
  allowedModelIds?: string[];
  customModelReasoningOptionIds?: Record<string, string[]>;
}): EngineModelRpc[] => {
  if (!input.catalog) {
    return [];
  }
  const configuredIds = input.allowedModelIds ?? [];
  if (configuredIds.length === 0) {
    return input.catalog.models;
  }
  const catalogById = new Map(
    input.catalog.models.map((model) => [model.modelId, model] as const)
  );
  return configuredIds.map(
    (modelId): EngineModelRpc =>
      catalogById.get(modelId) ?? {
        modelId,
        displayName: modelId,
        reasoningOptions: (
          input.customModelReasoningOptionIds?.[modelId] ?? []
        ).map((optionId) => ({ optionId, displayName: optionId })),
        serviceTiers: [],
        isDefault: false
      }
  );
};

export const snapshotComposerExecution = (
  execution?: ComposerExecutionSelection
): ComposerExecutionSelection | undefined =>
  execution ? { ...execution } : undefined;

const resolveComposerServiceTierId = (
  model: EngineModelRpc,
  preferredServiceTierId: string | null | undefined
): string | null | undefined => {
  if (model.serviceTiers.length === 0) {
    return undefined;
  }
  if (preferredServiceTierId === null) {
    return null;
  }
  if (
    preferredServiceTierId &&
    model.serviceTiers.some((tier) => tier.tierId === preferredServiceTierId)
  ) {
    return preferredServiceTierId;
  }
  if (
    model.defaultServiceTierId &&
    model.serviceTiers.some((tier) => tier.tierId === model.defaultServiceTierId)
  ) {
    return model.defaultServiceTierId;
  }
  return null;
};

export const resolveComposerExecutionSelection = (input: {
  models: EngineModelRpc[];
  currentModelId?: string;
  persistedProfile?: SessionExecutionProfile;
  lastExecution?: ComposerExecutionSelection;
  modelExecutionPreferences?: ComposerModelExecutionPreferences;
}): ComposerExecutionSelection | undefined => {
  const currentModel = input.currentModelId
    ? input.models.find((model) => model.modelId === input.currentModelId)
    : undefined;
  const persistedModel = input.persistedProfile?.modelId
    ? input.models.find(
        (model) => model.modelId === input.persistedProfile?.modelId
      )
    : undefined;
  const lastModel = input.lastExecution
    ? input.models.find((model) => model.modelId === input.lastExecution?.modelId)
    : undefined;
  const defaultModel =
    currentModel ??
    persistedModel ??
    lastModel ??
    input.models.find((model) => model.isDefault) ??
    input.models[0];
  if (!defaultModel) {
    return undefined;
  }
  const modelPreference =
    input.modelExecutionPreferences?.[defaultModel.modelId];
  const fallbackProfile = currentModel
    ? undefined
    : persistedModel
      ? input.persistedProfile
      : { ...input.lastExecution, ...(!input.persistedProfile?.modelId ? input.persistedProfile : undefined) };
  const preferredReasoningOptionId =
    modelPreference && Object.hasOwn(modelPreference, "reasoningOptionId")
      ? modelPreference.reasoningOptionId ?? undefined
      : fallbackProfile?.reasoningOptionId;
  const preferredServiceTierId =
    modelPreference && Object.hasOwn(modelPreference, "serviceTierId")
      ? modelPreference.serviceTierId
      : fallbackProfile?.serviceTierId;
  const serviceTierId = resolveComposerServiceTierId(
    defaultModel,
    preferredServiceTierId
  );
  return {
    modelId: defaultModel.modelId,
    reasoningOptionId: defaultModel.reasoningOptions.some(
      (option) => option.optionId === preferredReasoningOptionId
    )
      ? preferredReasoningOptionId
      : undefined,
    ...(serviceTierId !== undefined ? { serviceTierId } : {})
  };
};

export const resolveInterruptTurnId = (input: {
  activeSession?: ChatSession;
  turns: Turn[];
}): string | undefined => {
  const activeTurn = [...input.turns]
    .reverse()
    .find((turn) => turn.status !== "completed");
  if (activeTurn) {
    return activeTurn.turnId;
  }
  return input.activeSession?.status === "running" ||
    input.activeSession?.status === "awaiting_approval"
    ? input.activeSession.lastTurnId
    : undefined;
};

type UseComposerControllerInput = {
  transport: DesktopTransport;
  activeSession?: ChatSession;
  activeSessionId?: string;
  /** Stable through the transition from an accepted branch operation to its session. */
  draftKey?: string;
  /** Keeps unsent content across navigation without sharing session configuration or queues. */
  contentDraftKey?: string;
  threadGoal?: ThreadGoal;
  selectedEngineId: string;
  engineSurface?: EngineSurfaceRpc;
  allowedModelIds?: string[];
  customModelReasoningOptionIds?: Record<string, string[]>;
  modelExecutionPreferences?: ComposerModelExecutionPreferences;
  lastExecution?: ComposerExecutionSelection;
  /** Execution profile recorded for the node currently shown in the composer. */
  activeTurnExecutionProfile?: TurnExecutionProfile;
  /** Configuration captured when an asynchronous branch send was submitted. */
  pendingExecution?: ComposerExecutionSelection;
  recoveredBranchSends?: ChatTreeSendOperation[];
  onRecoveredBranchSendConsumed?: (operationId: string) => void;
  pendingBranchSend?: ChatTreeSendOperation;
  /** Working directory used to resolve project-scoped skills. */
  skillsCwd?: string;
  turns: Turn[];
  interruptTurns: Turn[];
  allowSessionLastTurnFallback?: boolean;
  approvals: ApprovalRequest[];
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  /** Draft state only: creates the session for the first message and returns its id. */
  createSession?: (input: { content: string; attachments: Attachment[]; execution?: SessionExecutionProfileInput }) => Promise<string>;
  initializeDraftExecution?: () => Promise<SessionExecutionProfileInput>;
  prepareSend?: () => Promise<string>;
  submitBranch?: (payload: Omit<import("../../transport/desktop-transport.js").ChatSendInput, "sessionId">) => Promise<boolean>;
  autoSendQueuedMessages?: boolean;
  onResumeSession?: () => Promise<void>;
  onBeforeStop?: (sessionId: string) => Promise<"cancelled" | void>;
  onCancelBranchSend?: (operationId: string) => Promise<void>;
  onRequestTranscriptBottom?: (sessionId: string) => void;
  onExecutionPreferenceChange?: (
    engineId: string,
    execution: ComposerExecutionSelection
  ) => void;
};

export type UseComposerControllerResult = ComposerViewModel & {
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isDropTarget: boolean;
  onDraftChange: (
    value: string,
    selectionStart?: number | null
  ) => void;
  onTextareaSelect: (selectionStart: number) => void;
  onPrimaryAction: () => Promise<void>;
  onSubmitUsing: (handler: ComposerSubmitHandler) => Promise<void>;
  onQueueCurrent: () => void;
  onStop: () => Promise<void>;
  onSuggestionHover: (index: number) => void;
  onSuggestionSelect: (item: ComposerSuggestionItem) => Promise<void>;
  onInputKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => Promise<void>;
  onComposerPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onComposerDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onRemoveSkill: (skillId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onEditQueuedMessage: (messageId: string) => void;
  onDeleteQueuedMessage: (messageId: string) => void;
  onSendQueuedMessageNow: (messageId: string) => Promise<void>;
  onSteerQueuedMessageNow: (messageId: string) => Promise<void>;
  onModelChange: (modelId: string) => void;
  onReasoningOptionChange: (reasoningOptionId: string) => void;
  onServiceTierChange: (serviceTierId: string) => void;
};

export const useComposerController = (
  input: UseComposerControllerInput
): UseComposerControllerResult => {
  const isExplicitExecutionKey = input.draftKey !== undefined;
  const draftKey = input.draftKey ?? input.activeSessionId;
  const contentDraftKey = input.contentDraftKey ?? draftKey;
  const [draftBySessionId, setDraftBySessionId] = useState<Record<string, string>>({});
  const [detachedDraft, setDetachedDraft] = useState("");
  const [detachedAttachments, setDetachedAttachments] = useState<ComposerAttachment[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<ComposerSkillReference[]>([]);
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [queueBySessionId, setQueueBySessionId] = useState<
    Record<string, QueuedComposerMessage[]>
  >({});
  const [modelSelection, setModelSelection] = useState<
    { key: string; modelId: string } | undefined
  >();
  const [modelIdBySessionId, setModelIdBySessionId] = useState<
    Record<string, string | undefined>
  >({});
  const [draftProfile, setDraftProfile] = useState<SessionExecutionProfileInput>();
  const [recoveredExecution, setRecoveredExecution] = useState<ComposerExecutionSelection>();
  const [draftProfileReady, setDraftProfileReady] = useState(!input.initializeDraftExecution);
  const [detachedModelId, setDetachedModelId] = useState<string>();
  const [modelCatalog, setModelCatalog] = useState<EngineModelCatalogRpc>();
  const [isExecutionLoading, setIsExecutionLoading] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [capabilities, setCapabilities] = useState<ChatInteractionCapabilitiesRpc>({
    supportsSteer: false,
    supportsAttachments: false,
    slashSuggestions: []
  });
  const [availableSkills, setAvailableSkills] = useState<SkillDescriptorRpc[]>([]);
  const [isSkillsLoading, setIsSkillsLoading] = useState(false);
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(0);
  const mountedRef = useRef(true);
  const contentRevisionRef = useRef(0);
  const selectedSkillsRef = useRef<ComposerSkillReference[]>([]);
  const attachmentDraftsRef = useRef<Record<string, ComposerAttachment[]>>({});
  const detachedAttachmentsRef = useRef<ComposerAttachment[]>([]);
  const queueRef = useRef<Record<string, QueuedComposerMessage[]>>({});
  const dragDepthRef = useRef(0);
  const previousContentDraftKeyRef = useRef(contentDraftKey);
  const executionKey = draftKey ?? input.activeSessionId;
  const previousExecutionKeyRef = useRef(executionKey);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isExplicitExecutionKey || previousExecutionKeyRef.current === executionKey) {
      return;
    }
    previousExecutionKeyRef.current = executionKey;
    setModelSelection(undefined);
    setRecoveredExecution(undefined);
  }, [executionKey, isExplicitExecutionKey]);

  useEffect(() => {
    if (input.activeSessionId) return;
    let cancelled = false;
    setDetachedModelId(undefined);
    setDraftProfile(undefined);
    setDraftProfileReady(!input.initializeDraftExecution);
    if (input.initializeDraftExecution) {
      void input.initializeDraftExecution().then((profile) => {
        if (cancelled) return;
        setDraftProfile(profile);
        setDraftProfileReady(true);
      }).catch((error: unknown) => {
        if (!cancelled) input.onStatusNotice({
          message: `Failed to load draft configuration: ${String(error)}`,
          source: "send"
        });
      });
    }
    return () => { cancelled = true; };
  }, [input.activeSessionId, input.initializeDraftExecution]);

  const activeTurnId = useMemo(() => {
    const latestTurn = [...input.turns]
      .reverse()
      .find((turn) => turn.status !== "completed");
    return latestTurn?.turnId ??
      (input.allowSessionLastTurnFallback ? input.activeSession?.lastTurnId : undefined);
  }, [
    input.turns,
    input.allowSessionLastTurnFallback,
    input.activeSession?.lastTurnId
  ]);
  const interruptTurnId = useMemo(
    () =>
      resolveInterruptTurnId({
        activeSession: input.activeSession,
        turns: input.interruptTurns
      }),
    [input.activeSession, input.interruptTurns]
  );

  const draft = contentDraftKey
    ? (draftBySessionId[contentDraftKey] ?? "")
    : detachedDraft;
  const attachments = contentDraftKey
    ? (attachmentDrafts[contentDraftKey] ?? [])
    : detachedAttachments;
  const queue = input.activeSessionId
    ? (queueBySessionId[input.activeSessionId] ?? [])
    : [];
  const currentModelId = isExplicitExecutionKey
    ? modelSelection?.key === executionKey ? modelSelection?.modelId : undefined
    : input.activeSessionId
      ? modelIdBySessionId[input.activeSessionId]
      : detachedModelId;
  const supportsTurnConfiguration = Boolean(
    input.engineSurface?.sharedCapabilities.includes("turnConfiguration")
  );
  const supportsDraftAttachments = Boolean(
    input.engineSurface?.sharedCapabilities.includes("attachments")
  );
  const models = useMemo<EngineModelRpc[]>(() => {
    if (!supportsTurnConfiguration || !modelCatalog) {
      return [];
    }
    return resolveComposerModels({
      catalog: modelCatalog,
      allowedModelIds: input.allowedModelIds,
      customModelReasoningOptionIds: input.customModelReasoningOptionIds
    });
  }, [
    input.allowedModelIds,
    input.customModelReasoningOptionIds,
    modelCatalog,
    supportsTurnConfiguration
  ]);
  const execution = useMemo(
    () =>
      resolveComposerExecutionSelection({
        models,
        currentModelId,
        persistedProfile: input.activeSessionId
          ? input.pendingExecution
            ? {
                engineId: input.selectedEngineId,
                ...input.pendingExecution
              }
            : recoveredExecution
            ? {
                engineId: input.selectedEngineId,
                ...recoveredExecution
              }
            : input.activeTurnExecutionProfile
            ? {
                engineId: input.selectedEngineId,
                ...input.activeTurnExecutionProfile
              }
            : readSessionExecutionProfile(input.activeSession?.metadata)
          : { engineId: input.selectedEngineId, ...draftProfile },
        lastExecution: input.lastExecution,
        modelExecutionPreferences: currentModelId ? input.modelExecutionPreferences : undefined
      }),
    [
      currentModelId,
      input.activeSession?.metadata,
      input.activeSessionId,
      input.activeTurnExecutionProfile,
      input.pendingExecution,
      recoveredExecution,
      input.selectedEngineId,
      draftProfile,
      input.lastExecution,
      input.modelExecutionPreferences,
      models
    ]
  );
  const selectedModel = models.find((model) => model.modelId === execution?.modelId);
  const reasoningOptions = selectedModel?.reasoningOptions ?? [];
  const serviceTiers = selectedModel?.serviceTiers ?? [];
  const intent = resolveComposerIntent({
    activeSession: input.activeSession,
    supportsSteer: capabilities.supportsSteer,
    activeTurnId
  });

  const status = resolveComposerStatusModel({
    selectedEngineId: input.selectedEngineId,
    activeSession: input.activeSession,
    approvals: input.approvals,
    notice: input.statusNotice,
    queuedCount: queue.length,
    supportsSteer: capabilities.supportsSteer
  });

  const hasComposedInput =
    draft.trim().length > 0 ||
    selectedSkills.length > 0 ||
    attachments.length > 0;
  const isTurnActive = Boolean(
    input.activeSession?.status === "running" ||
      input.activeSession?.status === "awaiting_approval"
  );
  const canSubmit =
    hasComposedInput &&
    Boolean(input.activeSessionId || input.createSession) &&
    !input.isOpeningSelectedSession &&
    (Boolean(input.activeSessionId) || draftProfileReady) &&
    !isDispatching;
  const canQueue =
    Boolean(input.activeSessionId) &&
    !input.isOpeningSelectedSession &&
    !isDispatching &&
    (draft.trim().length > 0 ||
      selectedSkills.length > 0 ||
      attachments.length > 0) &&
    isTurnActive;
  const cancellableBranchSend = input.pendingBranchSend &&
    (input.pendingBranchSend.status === "creating" || input.pendingBranchSend.status === "sending" || input.pendingBranchSend.status === "sent")
    ? input.pendingBranchSend : undefined;
  const canStop = Boolean(cancellableBranchSend) ||
    (Boolean(input.activeSessionId && interruptTurnId) && isTurnActive);

  useEffect(() => {
    selectedSkillsRef.current = selectedSkills;
  }, [selectedSkills]);

  useEffect(() => {
    queueRef.current = queueBySessionId;
  }, [queueBySessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      selectedSkillsRef.current = [];
      releaseComposerAttachments(detachedAttachmentsRef.current);
      for (const draftAttachments of Object.values(attachmentDraftsRef.current)) {
        releaseComposerAttachments(draftAttachments);
      }
      for (const queuedMessages of Object.values(queueRef.current)) {
        for (const item of queuedMessages) {
          releaseComposerAttachments(item.attachments);
        }
      }
    };
  }, []);

  useEffect(() => {
    if (previousContentDraftKeyRef.current === contentDraftKey) {
      return;
    }
    previousContentDraftKeyRef.current = contentDraftKey;
    contentRevisionRef.current += 1;
    selectedSkillsRef.current = [];
    setSelectedSkills([]);
  }, [contentDraftKey]);

  useEffect(() => {
    if (!input.selectedEngineId || !supportsTurnConfiguration) {
      setModelCatalog(undefined);
      setIsExecutionLoading(false);
      return;
    }
    let cancelled = false;
    setModelCatalog(undefined);
    setIsExecutionLoading(true);
    void input.transport.engine
      .listModels(input.selectedEngineId)
      .then((catalog) => {
        if (!cancelled) {
          setModelCatalog(catalog);
          setIsExecutionLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setModelCatalog(undefined);
          setIsExecutionLoading(false);
          input.onStatusNotice({
            message: `Model catalog failed: ${(error as Error).message}`,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    input.onStatusNotice,
    input.selectedEngineId,
    input.transport,
    supportsTurnConfiguration
  ]);

  useEffect(() => {
    if (!input.activeSessionId) {
      setCapabilities({
        supportsSteer: false,
        supportsAttachments: supportsDraftAttachments,
        slashSuggestions: []
      });
      return;
    }
    let cancelled = false;
    void input.transport.chat
      .getCapabilities(input.activeSessionId)
      .then((nextCapabilities) => {
        if (!cancelled) {
          setCapabilities(nextCapabilities);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCapabilities({
            supportsSteer: false,
            supportsAttachments: false,
            slashSuggestions: []
          });
          input.onStatusNotice({
            message: `Capability lookup failed: ${(error as Error).message}`,
            source: "send",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [input.activeSessionId, input.onStatusNotice, input.transport, supportsDraftAttachments]);

  useEffect(() => {
    let cancelled = false;
    setIsSkillsLoading(true);
    void input.transport.skills
      .list({
        cwds: input.skillsCwd ? [input.skillsCwd] : undefined
      })
      .then((skills) => {
        if (cancelled) {
          return;
        }
        setAvailableSkills(dedupeSkills(skills));
        setIsSkillsLoading(false);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setAvailableSkills([]);
        setIsSkillsLoading(false);
        input.onStatusNotice({
          message: `Skills lookup failed: ${(error as Error).message}`,
          persistent: true,
          source: "send",
          ...statusNoticeErrorDetails(error)
        });
      });

    return () => {
      cancelled = true;
    };
  }, [input.skillsCwd, input.onStatusNotice, input.transport]);

  const setDraft = (value: string): void => {
    contentRevisionRef.current += 1;
    if (contentDraftKey) {
      setDraftBySessionId((current) => ({
        ...current,
        [contentDraftKey]: value
      }));
      return;
    }
    setDetachedDraft(value);
  };

  const onDraftChange = (
    value: string,
    selectionStart?: number | null
  ): void => {
    setDraft(value);
    if (typeof selectionStart === "number") {
      setCursorPosition(selectionStart);
      return;
    }
    setCursorPosition(value.length);
  };

  const replaceSelectedSkills = (nextSkills: ComposerSkillReference[]): void => {
    contentRevisionRef.current += 1;
    selectedSkillsRef.current = nextSkills;
    setSelectedSkills(nextSkills);
  };

  const suggestionQuery = useMemo(() => {
    if (input.isOpeningSelectedSession) {
      return undefined;
    }
    return extractComposerSuggestionQuery(draft, cursorPosition);
  }, [cursorPosition, draft, input.isOpeningSelectedSession]);

  const suggestions = useMemo<ComposerSuggestionState | undefined>(() => {
    if (!suggestionQuery) {
      return undefined;
    }

    if (suggestionQuery.trigger === "/") {
      const items: ComposerSuggestionItem[] = resolveSlashSuggestionItems({
        capabilities,
        query: suggestionQuery.query,
        canResumeSession: Boolean(input.onResumeSession),
        canInterrupt: canStop
      });
      return {
        query: suggestionQuery,
        items,
        highlightedIndex:
          items.length === 0
            ? 0
            : Math.min(highlightedSuggestionIndex, items.length - 1),
        loading: false
      };
    }

    const items = filterSkills(availableSkills, suggestionQuery.query).map(
      (skill): ComposerSuggestionItem => ({
        id: `skill:${skill.path}`,
        kind: "skill",
        label: `$${skill.name}`,
        detail:
          skill.shortDescription ??
          `${skill.description} · ${skill.scope} · ${skill.enabled ? "enabled" : "disabled"}`,
        insertionText: `[${`$${skill.name}`}](${skill.path})`,
        skill
      })
    );
    return {
      query: suggestionQuery,
      items,
      highlightedIndex:
        items.length === 0
          ? 0
          : Math.min(highlightedSuggestionIndex, items.length - 1),
      loading: isSkillsLoading
    };
  }, [
    availableSkills,
    capabilities,
    canStop,
    highlightedSuggestionIndex,
    input.onResumeSession,
    isSkillsLoading,
    suggestionQuery
  ]);

  useEffect(() => {
    setHighlightedSuggestionIndex(0);
  }, [suggestionQuery?.trigger, suggestionQuery?.query]);

  const getAttachmentsForSession = (
    sessionId = contentDraftKey
  ): ComposerAttachment[] =>
    sessionId ? (attachmentDraftsRef.current[sessionId] ?? []) : detachedAttachmentsRef.current;

  const replaceAttachmentsForSession = (
    sessionId: string | undefined,
    nextAttachments: ComposerAttachment[],
    options: {
      releaseCurrent?: boolean;
    } = {}
  ): void => {
    const currentAttachments = getAttachmentsForSession(sessionId);
    contentRevisionRef.current += 1;
    if (options.releaseCurrent ?? true) {
      releaseComposerAttachments(currentAttachments);
    }
    if (!sessionId) {
      detachedAttachmentsRef.current = nextAttachments;
      setDetachedAttachments(nextAttachments);
      return;
    }
    const nextDrafts = writeComposerAttachmentDraft(
      attachmentDraftsRef.current,
      sessionId,
      nextAttachments
    );
    attachmentDraftsRef.current = nextDrafts;
    setAttachmentDrafts(nextDrafts);
  };

  useEffect(() => {
    const recovered = input.recoveredBranchSends?.[0];
    if (!recovered ||
      draft.trim().length > 0 || attachments.length > 0 || selectedSkills.length > 0) return;
    onDraftChange(recovered.content);
    setRecoveredExecution(recovered.execution?.modelId
      ? { modelId: recovered.execution.modelId,
          reasoningOptionId: recovered.execution.reasoningOptionId,
          serviceTierId: recovered.execution.serviceTierId }
      : undefined);
    replaceAttachmentsForSession(contentDraftKey,
      recovered.attachments.map((attachment) => restoreComposerAttachment(attachment)));
    input.onRecoveredBranchSendConsumed?.(recovered.operationId);
  }, [attachments.length, contentDraftKey, draft, input.recoveredBranchSends, input.onRecoveredBranchSendConsumed, selectedSkills.length]);

  const appendQueueItem = (
    item: Omit<QueuedComposerMessage, "id" | "createdAt">
  ): void => {
    if (!input.activeSessionId) {
      return;
    }
    const queuedItem: QueuedComposerMessage = {
      id: createOpaqueId("queued"),
      createdAt: new Date().toISOString(),
      ...item
    };
    setQueueBySessionId((current) => ({
      ...current,
      [input.activeSessionId!]: [...(current[input.activeSessionId!] ?? []), queuedItem]
    }));
  };

  const removeQueueItem = (
    messageId: string,
    options: { release: boolean }
  ): QueuedComposerMessage | undefined => {
    if (!input.activeSessionId) {
      return undefined;
    }
    const items = queueRef.current[input.activeSessionId] ?? [];
    const removed = items.find((item) => item.id === messageId);
    if (!removed) {
      return undefined;
    }
    setQueueBySessionId((current) => ({
      ...current,
      [input.activeSessionId!]: (current[input.activeSessionId!] ?? []).filter(
        (item) => item.id !== messageId
      )
    }));
    if (options.release) {
      releaseComposerAttachments(removed.attachments);
    }
    return removed;
  };

  const setTextareaCursor = (position: number): void => {
    queueMicrotask(() => {
      const element = composerTextareaRef.current;
      if (!element) {
        return;
      }
      element.focus();
      element.setSelectionRange(position, position);
      setCursorPosition(position);
    });
  };

  const moveCurrentInputToQueue = (
    source: QueuedComposerMessage["source"],
    text = draft.trim()
  ): void => {
    const currentSkills = selectedSkillsRef.current;
    const currentAttachments = getAttachmentsForSession();
    if (!text && currentSkills.length === 0 && currentAttachments.length === 0) {
      return;
    }
    appendQueueItem({
      text,
      skills: currentSkills,
      attachments: currentAttachments,
      execution: snapshotComposerExecution(execution),
      source
    });
    replaceSelectedSkills([]);
    if (input.activeSessionId) {
      replaceAttachmentsForSession(contentDraftKey, [], {
        releaseCurrent: false
      });
    }
    onDraftChange("");
    input.onStatusNotice({
      message: "Queued follow-up.",
      source: "send"
    });
  };

  const dispatchPayload = async (payload: {
    text: string;
    payloadSkills: ComposerSkillReference[];
    payloadAttachments: ComposerAttachment[];
    mode: "send" | "steer";
    turnId?: string;
    execution?: ComposerExecutionSelection;
  }): Promise<boolean> => {
    if (!input.activeSessionId && !input.createSession) {
      return false;
    }
    const content = serializeComposerContent(payload.text, payload.payloadSkills);
    if (!content && payload.payloadAttachments.length === 0) {
      return false;
    }
    const attachments = payload.payloadAttachments.map((item) => item.attachment);
    setIsDispatching(true);
    input.onStatusNotice({
      message:
        payload.mode === "steer" ? "Steering active turn…" : "Sending…",
      persistent: true,
      source: "send"
    });
    try {
      // Draft state: the first message creates the session, then becomes its first turn.
      if (payload.mode === "send" && input.submitBranch && await input.submitBranch({
        content, attachments, execution: payload.execution
      })) {
        input.onStatusNotice(undefined);
        if (input.activeSessionId) input.onRequestTranscriptBottom?.(input.activeSessionId);
        return true;
      }
      const sessionId = input.activeSessionId
        ? payload.mode === "send" && input.prepareSend
          ? await input.prepareSend()
          : input.activeSessionId
        : await input.createSession!({ content, attachments, execution: payload.execution });
      if (payload.mode === "steer" && payload.turnId) {
        const receipt = await input.transport.chat.steer({
          sessionId,
          turnId: payload.turnId,
          content,
          attachments
        });
        if (!receipt.accepted) {
          throw new Error("The current runtime does not accept steer requests.");
        }
      } else {
        const receipt = await input.transport.chat.send({
          sessionId,
          content,
          attachments,
          execution: payload.execution
        });
        if (!receipt.accepted) {
          throw new Error("The current runtime rejected the send request.");
        }
      }
      input.onStatusNotice({
        message: payload.mode === "steer" ? "Steer sent." : "Message sent.",
        source: "send"
      });
      input.onRequestTranscriptBottom?.(sessionId);
      return true;
    } catch (error) {
      input.onStatusNotice({
        message: `Send failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
      return false;
    } finally {
      setIsDispatching(false);
    }
  };

  const dispatchGoalCommand = async (
    command:
      | { kind: "set"; objective: string }
      | { kind: "clear" }
      | { kind: "pause" }
      | { kind: "resume" }
  ): Promise<boolean> => {
    if (!input.activeSessionId) {
      return false;
    }
    const actionLabel =
      command.kind === "clear"
        ? "Clearing goal"
        : command.kind === "pause"
          ? "Pausing goal"
          : command.kind === "resume"
            ? "Resuming goal"
            : "Setting goal";
    setIsDispatching(true);
    input.onStatusNotice({
      message: `${actionLabel}…`,
      persistent: true,
      source: "send"
    });
    try {
      const receipt =
        command.kind === "clear"
          ? await input.transport.chat.clearGoal({
              sessionId: input.activeSessionId
            })
          : await input.transport.chat.setGoal({
              sessionId: input.activeSessionId,
              objective: command.kind === "set" ? command.objective : undefined,
              status:
                command.kind === "pause"
                  ? "paused"
                  : command.kind === "resume"
                    ? "active"
                    : "active"
            });
      if (!receipt.accepted) {
        throw new Error("The current runtime rejected the goal request.");
      }
      input.onStatusNotice({
        message:
          command.kind === "clear"
            ? "Goal cleared."
            : command.kind === "pause"
              ? "Goal paused."
              : command.kind === "resume"
                ? "Goal resumed."
                : "Goal set.",
        source: "send"
      });
      return true;
    } catch (error) {
      input.onStatusNotice({
        message: `Goal failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
      return false;
    } finally {
      setIsDispatching(false);
    }
  };

  const onPrimaryAction = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    const goalCommand = parseGoalSlashCommand(draft);
    if (goalCommand?.kind === "empty") {
      input.onStatusNotice({
        message: "Add a goal after /goal.",
        source: "send"
      });
      return;
    }
    const goalBlockReason = goalCommandBlockedReason(goalCommand, input.threadGoal);
    if (goalBlockReason) {
      input.onStatusNotice({
        message: goalBlockReason,
        source: "send"
      });
      return;
    }
    if (goalCommand?.kind === "edit") {
      return;
    }
    if (goalCommand) {
      if (
        selectedSkillsRef.current.length > 0 ||
        getAttachmentsForSession().length > 0
      ) {
        input.onStatusNotice({
          message: "Goal commands only use the text after /goal.",
          source: "send"
        });
        return;
      }
      const submittedRevision = contentRevisionRef.current;
      const succeeded = await dispatchGoalCommand(goalCommand);
      if (!succeeded || submittedRevision !== contentRevisionRef.current) {
        return;
      }
      onDraftChange("");
      return;
    }
    await submitCurrentInput(draft);
  };

  const submitCurrentInput = async (text: string): Promise<void> => {
    if (intent === "queue") {
      moveCurrentInputToQueue("user-queue", text.trim());
      return;
    }
    const currentAttachments = getAttachmentsForSession();
    const submittedRevision = contentRevisionRef.current;
    const succeeded = await dispatchPayload({
      text,
      payloadSkills: selectedSkillsRef.current,
      payloadAttachments: currentAttachments,
      mode: intent,
      turnId: activeTurnId,
      execution: intent === "steer" ? undefined : execution
    });
    if (!succeeded || submittedRevision !== contentRevisionRef.current) {
      return;
    }
    onDraftChange("");
    replaceSelectedSkills([]);
    replaceAttachmentsForSession(contentDraftKey, [], {
      releaseCurrent: true
    });
  };

  const onSubmitUsing = async (handler: ComposerSubmitHandler): Promise<void> => {
    if (!canSubmit) return;
    const submittedRevision = contentRevisionRef.current;
    const payload = {
      content: serializeComposerContent(draft, selectedSkillsRef.current),
      attachments: getAttachmentsForSession().map((item) => item.attachment),
      execution: snapshotComposerExecution(execution)
    };
    setIsDispatching(true);
    try {
      const sessionId = input.activeSessionId ?? await input.createSession!(payload);
      await handler({ sessionId, ...payload });
      input.onStatusNotice(undefined);
      if (submittedRevision === contentRevisionRef.current) {
        onDraftChange("");
        replaceSelectedSkills([]);
        replaceAttachmentsForSession(contentDraftKey, [], { releaseCurrent: true });
      }
    } finally {
      setIsDispatching(false);
    }
  };

  const onQueueCurrent = (): void => {
    if (!canQueue) {
      return;
    }
    moveCurrentInputToQueue(intent === "steer" ? "steer-fallback" : "user-queue");
  };

  const onStop = async (): Promise<void> => {
    if (cancellableBranchSend) {
      try {
        await input.onCancelBranchSend?.(cancellableBranchSend.operationId);
      } catch (error) {
        input.onStatusNotice({
          message: `Cancel send failed: ${(error as Error).message}`,
          persistent: true,
          source: "send",
          ...statusNoticeErrorDetails(error)
        });
      }
      return;
    }
    if (!input.activeSessionId || !interruptTurnId || !canStop) {
      return;
    }
    setIsDispatching(true);
    try {
      let pauseError: unknown;
      try {
        const stopHandling = await input.onBeforeStop?.(input.activeSessionId);
        if (stopHandling === "cancelled") return;
      } catch (error) {
        pauseError = error;
      }
      await input.transport.chat.interrupt({
        sessionId: input.activeSessionId,
        turnId: interruptTurnId
      });
      input.onStatusNotice({
        message: pauseError
          ? `Interrupt requested; Worker pause recording failed: ${pauseError instanceof Error ? pauseError.message : String(pauseError)}`
          : "Interrupt requested.",
        persistent: Boolean(pauseError),
        source: "send"
      });
    } catch (error) {
      input.onStatusNotice({
        message: `Stop failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsDispatching(false);
    }
  };

  const replaceRangeInDraft = (
    start: number,
    end: number,
    value: string
  ): void => {
    const nextDraft = `${draft.slice(0, start)}${value}${draft.slice(end)}`;
    onDraftChange(nextDraft, start + value.length);
    setTextareaCursor(nextDraft.length);
  };

  const onSuggestionSelect = async (
    item: ComposerSuggestionItem
  ): Promise<void> => {
    if (!suggestions) {
      return;
    }
    if (item.kind === "skill") {
      replaceSelectedSkills(
        selectedSkillsRef.current.some((skill) => skill.id === `${item.skill.path}:${item.skill.name}`)
          ? selectedSkillsRef.current
          : [...selectedSkillsRef.current, toComposerSkillReference(item.skill)]
      );
      replaceRangeInDraft(
        suggestions.query.start,
        suggestions.query.end,
        ""
      );
      return;
    }
    if (item.action === "resume-session") {
      await input.onResumeSession?.();
      return;
    }
    if (item.action === "interrupt") {
      await onStop();
      return;
    }
    replaceRangeInDraft(
      suggestions.query.start,
      suggestions.query.end,
      `${item.replacement ?? ""} `
    );
  };

  const onInputKeyDown = async (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ): Promise<void> => {
    if (suggestions && suggestions.items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedSuggestionIndex(
          (current) => (current + 1) % suggestions.items.length
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedSuggestionIndex(
          (current) => (current - 1 + suggestions.items.length) % suggestions.items.length
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = suggestions.items[suggestions.highlightedIndex];
        if (item) {
          await onSuggestionSelect(item);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCursorPosition(-1);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await onPrimaryAction();
    }
  };

  const appendComposerAttachments = async (
    files: Iterable<File>,
    origin: "picker" | "drop" | "paste"
  ): Promise<void> => {
    const targetSessionId = contentDraftKey;
    if (input.isOpeningSelectedSession || isDispatching) {
      return;
    }
    if (!capabilities.supportsAttachments) {
      input.onStatusNotice({
        message: "Attachments are unavailable for this session.",
        source: "send"
      });
      return;
    }
    const nextAttachments = await createComposerAttachments(files, origin);
    if (!mountedRef.current) {
      releaseComposerAttachments(nextAttachments);
      return;
    }
    if (nextAttachments.length === 0) {
      return;
    }
    const currentAttachments = getAttachmentsForSession(targetSessionId);
    const result = mergeComposerAttachments(currentAttachments, nextAttachments);
    releaseComposerAttachments([...result.replaced, ...result.skipped]);
    replaceAttachmentsForSession(targetSessionId, result.attachments, {
      releaseCurrent: false
    });
  };

  const onComposerPaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>
  ): void => {
    const extracted = extractPastedMessageImages(
      event.clipboardData.getData("text/plain")
    );
    const files =
      extracted?.files ?? collectPastedImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    if (extracted) {
      event.preventDefault();
      const start = event.currentTarget.selectionStart ?? draft.length;
      const end = event.currentTarget.selectionEnd ?? start;
      const nextDraft = `${draft.slice(0, start)}${extracted.text}${draft.slice(end)}`;
      const nextCursor = start + extracted.text.length;
      onDraftChange(nextDraft, nextCursor);
      setTextareaCursor(nextCursor);
    } else if (!hasStringTransfer(event.clipboardData)) {
      event.preventDefault();
    }
    void appendComposerAttachments(files, "paste").catch((error) => {
      input.onStatusNotice({
        message: `Paste attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    });
  };

  const onComposerDragEnter = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDropTarget(true);
  };

  const onComposerDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropTarget(true);
  };

  const onComposerDragLeave = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDropTarget(false);
    }
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDropTarget(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }
    void appendComposerAttachments(files, "drop").catch((error) => {
      input.onStatusNotice({
        message: `Drop attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    });
  };

  const onRemoveAttachment = (attachmentId: string): void => {
    const currentAttachments = getAttachmentsForSession();
    const removed = currentAttachments.find(
      (attachment) => attachment.attachment.attachmentId === attachmentId
    );
    if (!removed) {
      return;
    }
    releaseComposerAttachments([removed]);
    const next = currentAttachments.filter(
      (attachment) => attachment.attachment.attachmentId !== attachmentId
    );
    replaceAttachmentsForSession(contentDraftKey, next, {
      releaseCurrent: false
    });
  };

  const onRemoveSkill = (skillId: string): void => {
    replaceSelectedSkills(
      selectedSkillsRef.current.filter((skill) => skill.id !== skillId)
    );
  };

  const onEditQueuedMessage = (messageId: string): void => {
    const item = removeQueueItem(messageId, { release: false });
    if (!item) {
      return;
    }
    onDraftChange(item.text);
    replaceSelectedSkills(item.skills);
    replaceAttachmentsForSession(contentDraftKey, item.attachments, {
      releaseCurrent: true
    });
    if (item.execution) {
      setExecution(item.execution);
    }
    setTextareaCursor(item.text.length);
  };

  const onDeleteQueuedMessage = (messageId: string): void => {
    removeQueueItem(messageId, { release: true });
  };

  const dispatchQueuedMessage = async (
    messageId: string,
    mode: "send" | "steer"
  ): Promise<void> => {
    const item = queue.find((candidate) => candidate.id === messageId);
    if (!item) {
      return;
    }
    const succeeded = await dispatchPayload({
      text: item.text,
      payloadSkills: item.skills,
      payloadAttachments: item.attachments,
      mode,
      turnId: activeTurnId,
      execution: mode === "send" ? item.execution : undefined
    });
    if (succeeded) {
      removeQueueItem(messageId, { release: true });
    }
  };

  const onSendQueuedMessageNow = async (messageId: string): Promise<void> => {
    await dispatchQueuedMessage(messageId, "send");
  };

  const onSteerQueuedMessageNow = async (messageId: string): Promise<void> => {
    await dispatchQueuedMessage(messageId, "steer");
  };

  useEffect(() => {
    if (
      !input.activeSessionId ||
      input.autoSendQueuedMessages === false ||
      isDispatching ||
      input.activeSession?.status !== "idle" ||
      queue.length === 0
    ) {
      return;
    }
    const nextQueued = queue[0];
    let cancelled = false;
    void (async () => {
      const succeeded = await dispatchPayload({
        text: nextQueued.text,
        payloadSkills: nextQueued.skills,
        payloadAttachments: nextQueued.attachments,
        mode: "send",
        execution: nextQueued.execution
      });
      if (!cancelled && succeeded) {
        removeQueueItem(nextQueued.id, { release: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    input.autoSendQueuedMessages,
    input.activeSession?.status,
    input.activeSessionId,
    input.transport,
    isDispatching,
    queue
  ]);

  function setExecution(nextExecution: ComposerExecutionSelection): void {
    if (input.selectedEngineId) {
      input.onExecutionPreferenceChange?.(input.selectedEngineId, nextExecution);
    }
    if (input.activeSessionId) {
      if (isExplicitExecutionKey) {
        setModelSelection({ key: draftKey!, modelId: nextExecution.modelId });
      } else {
        setModelIdBySessionId((current) => ({
          ...current,
          [input.activeSessionId!]: nextExecution.modelId
        }));
      }
      return;
    }
    setDetachedModelId(nextExecution.modelId);
  }

  const onModelChange = (modelId: string): void => {
    if (!supportsTurnConfiguration || intent === "steer") {
      return;
    }
    const nextExecution = resolveComposerExecutionSelection({
      models,
      lastExecution: { modelId },
      modelExecutionPreferences: input.modelExecutionPreferences
    });
    if (nextExecution) {
      setExecution(nextExecution);
    }
  };

  const onReasoningOptionChange = (reasoningOptionId: string): void => {
    if (!supportsTurnConfiguration || intent === "steer" || !execution?.modelId) {
      return;
    }
    setExecution({
      modelId: execution.modelId,
      reasoningOptionId: reasoningOptionId || undefined,
      serviceTierId: execution.serviceTierId
    });
  };

  const onServiceTierChange = (serviceTierId: string): void => {
    if (!supportsTurnConfiguration || intent === "steer" || !execution?.modelId) {
      return;
    }
    setExecution({
      modelId: execution.modelId,
      reasoningOptionId: execution.reasoningOptionId,
      serviceTierId: serviceTierId || null
    });
  };

  return {
    draft,
    selectedSkills,
    attachments,
    queue,
    status,
    intent,
    capabilities,
    models,
    execution,
    reasoningOptions,
    serviceTiers,
    isExecutionLoading: isExecutionLoading || (!input.activeSessionId && !draftProfileReady),
    isExecutionDisabled: intent === "steer" || isDispatching,
    suggestions,
    isDispatching,
    hasComposedInput,
    isTurnActive,
    canSubmit,
    canQueue,
    canStop,
    activeTurnId,
    composerTextareaRef,
    isDropTarget,
    onDraftChange,
    onTextareaSelect: setCursorPosition,
    onPrimaryAction,
    onSubmitUsing,
    onQueueCurrent,
    onStop,
    onSuggestionHover: setHighlightedSuggestionIndex,
    onSuggestionSelect,
    onInputKeyDown,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onRemoveSkill,
    onRemoveAttachment,
    onEditQueuedMessage,
    onDeleteQueuedMessage,
    onSendQueuedMessageNow,
    onSteerQueuedMessageNow,
    onModelChange,
    onReasoningOptionChange,
    onServiceTierChange
  };
};
