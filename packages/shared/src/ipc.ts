import { z } from "zod";
import {
  zConversationId,
  zCursor,
  zEngineId,
  zIsoDateTime,
  zJsonRecord,
  zRequestId,
  zSessionId,
  zTurnId
} from "./common.js";
import { commandTypes, zCommandEnvelopeSchema, zChatTreeSendInputSchema, zChatTreeSendOperationSchema } from "./commands.js";
import { zChatSessionSchema, zDomainSnapshotSchema } from "./domain.js";
import {
  zEngineDefinitionRpcSchema,
  zEngineModelCatalogRpcSchema,
  zEngineSharedCapabilitySchema,
  zEngineSurfaceRpcSchema
} from "./engine-control.js";
import { eventTypes, zEventEnvelopeSchema } from "./events.js";
import {
  zExecutionPreferencesByEngineIdSchema,
  zSessionExecutionProfileInputSchema,
  zSessionExecutionProfileSchema
} from "./session-profile.js";

export const sessionRpcMethods = [
  "engine.list",
  "engine.getSurface",
  "engine.listModels",
  "engine.select",
  "settings.get",
  "settings.update",
  "domain.snapshot",
  "session.list",
  "workspace.list",
  "workspace.pickDirectory",
  "workspace.add",
  "workspace.remove",
  "workspace.select",
  "sessionBrowser.list",
  "sessionBrowser.repair",
  "sessionBrowser.create",
  "sessionBrowser.open",
  "sessionBrowser.activate",
  "sessionBrowser.loadOlder",
  "sessionBrowser.getActions",
  "sessionBrowser.runAction",
  "sessionBrowser.rename",
  "chat.getCapabilities",
  "skills.list",
  "chatTree.get",
  "chatTree.nodeAction",
  "chatTree.jump",
  "chatTree.markRead",
  "chatTree.prepareSend",
  "chatTree.submit",
  "chatTree.retry",
  "chatTree.cancel",
  "chatTree.remove",
  "chatTree.operations",
  "delegation.get",
  "worktree.get",
  "checkpoint.get",
  "diagnostics.get",
  "diagnostics.write",
  "backgroundRun.get",
  "errorLog.write",
  "file.runAction",
  "codex.hookActivity.get",
  "codex.turnChanges.get",
  "codex.turnChanges.undo",
  "runtime.command",
  "events.subscribe",
  "events.unsubscribe",
  "events.replay"
] as const;

export type SessionRpcMethod = (typeof sessionRpcMethods)[number];

const zSessionEventType = z.enum(eventTypes);
const zSessionCommandType = z.enum(commandTypes);

const zWorkspaceRecordSchema = z.object({
  workspaceId: z.string().min(1),
  absolutePath: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const zSessionSettingsSchema = z.object({
  defaultNewSessionEngineId: z.string().min(1).optional(),
  /** 会话标题生成使用的模型；未设置时使用内置默认模型。 */
  titleGenerationModelId: z.string().min(1).optional(),
  engineProgramPathsByEngineId: z.record(z.string(), z.string().min(1)).default({}),
  engineProgramResolutionsByEngineId: z
    .record(
      z.string(),
      z.object({
        path: z.string().min(1),
        source: z.enum(["custom", "configured", "environment", "default"]),
        environmentVariable: z.string().min(1).optional(),
        /** 解析出的可执行文件是否存在；用于设置页直接告诉用户这个引擎能不能启动。 */
        found: z.boolean(),
        resolvedPath: z.string().min(1).optional()
      })
    )
    .default({}),
  allowedModelIdsByEngineId: z.record(z.string(), z.array(z.string().min(1))).default({}),
  customModelReasoningOptionIdsByEngineId: z
    .record(z.string(), z.record(z.string(), z.array(z.string().min(1))))
    .default({}),
  executionPreferencesByEngineId: zExecutionPreferencesByEngineIdSchema
});

const zComposerSlashSuggestionRpcSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  replacement: z.string().min(1).optional(),
  sourceCapability: zEngineSharedCapabilitySchema.optional()
});

const zChatInteractionCapabilitiesRpcSchema = z.object({
  supportsSteer: z.boolean(),
  supportsAttachments: z.boolean(),
  slashSuggestions: z.array(zComposerSlashSuggestionRpcSchema).default([])
});

const zSkillDescriptorRpcSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  shortDescription: z.string().min(1).optional(),
  path: z.string().min(1),
  scope: z.string().min(1),
  enabled: z.boolean()
});

const zSessionStatusDotSchema = z.enum(["none", "running", "unread_completed"]);

export const zProviderSessionHandleSchema = z.object({
  providerKind: z.string().min(1),
  providerSessionId: z.string().min(1)
});

export type ProviderSessionHandle = z.infer<typeof zProviderSessionHandleSchema>;

export type SessionBrowserItemRpc = {
  sessionId: string;
  /** Linear sessions in this fork tree, including its root (`sessionId`); excludes subagents. */
  memberSessionIds?: string[];
  engineId: string;
  title: string;
  statusDot: z.infer<typeof zSessionStatusDotSchema>;
  isActive: boolean;
  isPinned: boolean;
  /** Latest user message submission or turn completion represented by this tree. */
  activityAt?: string;
  lastCompletedTurnAt?: string;
  /** Workbench agent role (steward / worker / supervisor) from session metadata; absent for the user's own design sessions. */
  role?: string;
  /** Set when this session was spawned as a subagent of another session; such items are nested under it. */
  parentSessionId?: string;
  subagents: SessionBrowserItemRpc[];
};

type SessionBrowserItemRpcInput = Omit<SessionBrowserItemRpc, "subagents"> & {
  subagents?: SessionBrowserItemRpcInput[];
};

export type SessionBrowserPageRpc = {
  workspaceId: string;
  revision: string;
  items: SessionBrowserItemRpc[];
  nextCursor?: string;
  hasMore: boolean;
  totalCount: number;
};

const zSessionBrowserItemSchema: z.ZodType<
  SessionBrowserItemRpc,
  z.ZodTypeDef,
  SessionBrowserItemRpcInput
> = z.lazy(() =>
  z.object({
    sessionId: zSessionId,
    memberSessionIds: z.array(zSessionId).optional(),
    engineId: zEngineId,
    title: z.string().min(1),
    statusDot: zSessionStatusDotSchema,
    isActive: z.boolean(),
    isPinned: z.boolean(),
    activityAt: z.string().min(1).optional(),
    lastCompletedTurnAt: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    parentSessionId: zSessionId.optional(),
    subagents: z.array(zSessionBrowserItemSchema).default([])
  })
);

const zSessionBrowserPageSchema = z.object({
  workspaceId: z.string().min(1),
  revision: z.string().min(1),
  items: z.array(zSessionBrowserItemSchema),
  nextCursor: z.string().min(1).optional(),
  hasMore: z.boolean(),
  totalCount: z.number().int().nonnegative()
});

const zSessionActionKindSchema = z.enum([
  "archive",
  "copy_awb_session_id",
  "copy_session_id",
  "fork",
  "open_rollout",
  "pin",
  "refresh",
  "resume",
  "unpin"
]);

const zSessionActionDescriptorSchema = z.object({
  action: zSessionActionKindSchema,
  label: z.string().min(1),
  disabled: z.boolean().optional(),
  reason: z.string().min(1).optional()
});

const zForkSessionActionResultSchema = z.discriminatedUnion("status", [
  z.object({
    action: z.literal("fork"),
    status: z.literal("forked"),
    forkedSessionId: zSessionId,
    providerSessionId: z.string().min(1)
  }),
  z.object({
    action: z.literal("fork"),
    status: z.literal("unsupported"),
    message: z.string().min(1)
  })
]);

const zSessionActionResultSchema = z.union([
  z.object({
    action: z.literal("archive"),
    archived: z.literal(true)
  }),
  z.object({
    action: z.literal("copy_awb_session_id"),
    copiedText: z.string().min(1)
  }),
  z.object({
    action: z.literal("copy_session_id"),
    copiedText: z.string().min(1)
  }),
  zForkSessionActionResultSchema,
  z.object({
    action: z.literal("open_rollout"),
    rolloutPath: z.string().min(1),
    rolloutDisplayPath: z.string().min(1),
    rolloutFileUrl: z.string().url()
  }),
  z.object({
    action: z.literal("pin"),
    pinned: z.literal(true)
  }),
  z.object({
    action: z.literal("refresh"),
    refreshed: z.literal(true),
    details: z.string().optional()
  }),
  z.object({
    action: z.literal("resume"),
    resumed: z.literal(true)
  }),
  z.object({
    action: z.literal("unpin"),
    pinned: z.literal(false)
  })
]);

const zChatTreeNodeSchema = z.object({
  nodeId: z.string().min(1),
  sessionId: zSessionId.optional(),
  canArchive: z.boolean().optional(),
  parentNodeId: z.string().min(1).optional(),
  label: z.string().min(1),
  turnId: zTurnId.optional(),
  order: z.number().int(),
  isCurrent: z.boolean(),
  unread: z.boolean().optional(),
  status: z.enum(["pending", "completed", "interrupted", "replaced", "reviewEnded"]).optional()
});

const zConversationGraphNodeSchema = zChatTreeNodeSchema.extend({
  providerNodeId: z.string().min(1).optional(),
  summary: z.string().min(1).optional()
});

const zConversationGraphSnapshotSchema = z.object({
  sessionId: zSessionId,
  engineId: zEngineId,
  supportsJump: z.boolean(),
  version: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
  currentNodeId: z.string().min(1).optional(),
  visibleNodeIds: z.array(z.string().min(1)).optional(),
  visibleTurnIds: z.array(zTurnId).optional(),
  nodes: z.array(zConversationGraphNodeSchema).default([]),
  fetchedAt: z.string().min(1)
});

const zChatTreeSnapshotSchema = z.object({
  sessionId: zSessionId,
  treeId: zSessionId.optional(),
  currentSessionId: zSessionId.optional(),
  memberSessionIds: z.array(zSessionId).optional(),
  windows: z.array(z.lazy(() => zSessionWindowSchema)).optional(),
  engineId: zEngineId,
  supportsJump: z.boolean(),
  version: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
  currentNodeId: z.string().min(1).optional(),
  visibleNodeIds: z.array(z.string().min(1)).optional(),
  visibleTurnIds: z.array(zTurnId).optional(),
  nodes: z.array(zChatTreeNodeSchema).default([]),
  fetchedAt: z.string().min(1)
});

const zDelegationNodeSchema = z.object({
  nodeId: z.string().min(1),
  providerNodeId: z.string().min(1).optional(),
  label: z.string().min(1),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  role: z.enum(["root", "delegate"]),
  parentNodeId: z.string().min(1).optional(),
  linkedSessionId: zSessionId.optional(),
  summary: z.string().min(1).optional(),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional()
});

const zDelegationEdgeSchema = z.object({
  edgeId: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relation: z.enum(["spawn", "handoff", "wait", "resume"])
});

const zDelegationSnapshotSchema = z.object({
  sessionId: zSessionId,
  engineId: zEngineId,
  supported: z.boolean(),
  supportsControl: z.boolean(),
  currentActiveNodeId: z.string().min(1).optional(),
  nodes: z.array(zDelegationNodeSchema).default([]),
  edges: z.array(zDelegationEdgeSchema).default([]),
  fetchedAt: z.string().min(1)
});

const zWorktreeSnapshotSchema = z.object({
  sessionId: zSessionId,
  engineId: zEngineId,
  supported: z.boolean(),
  workspaceRoot: z.string().min(1).optional(),
  rolloutPath: z.string().min(1).optional(),
  gitBranch: z.string().min(1).optional(),
  gitSha: z.string().min(1).optional(),
  gitOriginUrl: z.string().min(1).optional(),
  diffToRemoteSha: z.string().min(1).optional(),
  diffToRemote: z.string().optional(),
  fetchedAt: z.string().min(1)
});

const zCheckpointEntrySchema = z.object({
  checkpointId: z.string().min(1),
  providerCheckpointId: z.string().min(1).optional(),
  label: z.string().min(1),
  summary: z.string().min(1).optional(),
  turnId: zTurnId.optional(),
  order: z.number().int(),
  isCurrent: z.boolean()
});

const zCheckpointSnapshotSchema = z.object({
  sessionId: zSessionId,
  engineId: zEngineId,
  supported: z.boolean(),
  supportsRestore: z.boolean(),
  currentCheckpointId: z.string().min(1).optional(),
  checkpoints: z.array(zCheckpointEntrySchema).default([]),
  fetchedAt: z.string().min(1)
});

const zDiagnosticsSnapshotSchema = z.object({
  sessionId: zSessionId,
  engineId: zEngineId,
  supported: z.boolean(),
  authenticated: z.boolean(),
  authMethod: z.string().min(1).nullable().optional(),
  requiresOpenaiAuth: z.boolean().nullable().optional(),
  gitBranch: z.string().min(1).optional(),
  gitSha: z.string().min(1).optional(),
  diffToRemoteSha: z.string().min(1).optional(),
  diffToRemote: z.string().optional(),
  summaryText: z.string().min(1).optional(),
  fetchedAt: z.string().min(1)
});

const zBackgroundRunSnapshotSchema = z.object({
  sessionId: zSessionId,
  engineId: zEngineId,
  supported: z.boolean(),
  status: z.enum(["unsupported", "attached", "detached"]),
  resumeToken: z.string().min(1).optional(),
  fetchedAt: z.string().min(1)
});

const zSessionWindowSchema = z.object({
  sessionId: zSessionId,
  snapshot: zDomainSnapshotSchema,
  replaceSessionHistory: z.boolean().optional(),
  cursor: zCursor.optional(),
  revision: z.string().min(1).optional(),
  windowStartTurnId: zTurnId.optional(),
  windowEndTurnId: zTurnId.optional(),
  olderCursor: z.string().min(1).optional(),
  newerCursor: z.string().min(1).optional(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean()
});

const zFileReferenceSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
  fileUrl: z.string().min(1),
  label: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string().min(1).optional(),
  isImage: z.boolean(),
  source: z.literal("inline_path")
});

const zFileActionKindSchema = z.enum(["open", "reveal"]);

const zFileActionResultSchema = z.object({
  action: zFileActionKindSchema,
  ok: z.boolean(),
  displayPath: z.string().min(1),
  fileUrl: z.string().min(1),
  errorMessage: z.string().min(1).optional()
});

const zCodexTurnChangeKindSchema = z.enum(["add", "delete", "update"]);

const zCodexChangedFileSchema = zFileReferenceSchema.extend({
  changeKind: zCodexTurnChangeKindSchema,
  diff: z.string().min(1).optional()
});

const zCodexHookOutputEntryKindSchema = z.enum([
  "warning",
  "stop",
  "feedback",
  "context",
  "error"
]);

const zCodexHookRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "blocked",
  "stopped"
]);

const zCodexHookRunSchema = z.object({
  id: z.string().min(1),
  eventName: z.string().min(1),
  handlerType: z.string().min(1),
  executionMode: z.string().min(1),
  scope: z.string().min(1),
  sourcePath: z.string().min(1),
  source: z.string().min(1),
  displayOrder: z.number().int(),
  status: zCodexHookRunStatusSchema,
  statusMessage: z.string().min(1).nullable().optional(),
  startedAt: z.number().int(),
  completedAt: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  entries: z.array(
    z.object({
      kind: zCodexHookOutputEntryKindSchema,
      text: z.string()
    })
  ).default([])
});

const zEngineListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.list"),
  params: z.object({})
});

const zEngineGetSurfaceRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.getSurface"),
  params: z.object({
    engineId: z.string().min(1)
  })
});

const zEngineListModelsRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.listModels"),
  params: z.object({
    engineId: z.string().min(1)
  })
});

const zEngineSelectRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.select"),
  params: z.object({
    engineId: z.string().min(1),
    config: zJsonRecord.optional()
  })
});

const zDomainSnapshotRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("domain.snapshot"),
  params: z.object({})
});

const zSettingsGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.get"),
  params: z.object({})
});

const zSettingsUpdateRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.update"),
  params: z.object({
    defaultNewSessionEngineId: z.string().min(1).optional(),
    titleGenerationModelId: z.string().min(1).nullable().optional(),
    engineProgramPathsByEngineId: z
      .record(z.string(), z.string().min(1))
      .optional(),
    allowedModelIdsByEngineId: z
      .record(z.string(), z.array(z.string().min(1)))
      .optional(),
    customModelReasoningOptionIdsByEngineId: z
      .record(z.string(), z.record(z.string(), z.array(z.string().min(1))))
      .optional(),
    executionPreferencesByEngineId:
      zExecutionPreferencesByEngineIdSchema.optional()
  })
});

const zRuntimeCommandRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("runtime.command"),
  params: z.object({
    envelope: zCommandEnvelopeSchema
  })
});

const zSessionListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("session.list"),
  params: z.object({
    conversationId: zConversationId.optional(),
    includeArchived: z.boolean().default(false)
  })
});

const zWorkspaceListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.list"),
  params: z.object({})
});

const zWorkspacePickDirectoryRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.pickDirectory"),
  params: z.object({})
});

const zWorkspaceAddRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.add"),
  params: z.object({
    rootPath: z.string().min(1),
    label: z.string().min(1).optional()
  })
});

const zWorkspaceRemoveRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.remove"),
  params: z.object({
    workspaceId: z.string().min(1)
  })
});

const zWorkspaceSelectRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.select"),
  params: z.object({
    workspaceId: z.string().min(1)
  })
});

const zSessionBrowserListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.list"),
  params: z.object({
    workspaceId: z.string().min(1),
    cursor: z.string().min(1).optional(),
    expectedRevision: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).default(20),
    /** "user" = sessions the user opened themselves (no agent role); "agent" = steward/worker/supervisor sessions. */
    kind: z.enum(["user", "agent"]).optional()
  })
});

const zSessionBrowserCreateRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.create"),
  params: z.object({
    workspaceId: z.string().min(1),
    engineId: z.string().min(1),
    conversationId: zConversationId.optional(),
    sessionProfile: zSessionExecutionProfileInputSchema.optional(),
    metadata: zJsonRecord.optional()
  })
});

const zSessionBrowserRepairRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.repair"),
  params: z.object({
    workspaceIds: z.array(z.string().min(1)).min(1)
  })
});

const zSessionBrowserOpenRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.open"),
  params: z.object({
    sessionId: zSessionId,
    forceProviderHydration: z.boolean().optional()
  })
});

const zSessionBrowserActivateRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.activate"),
  params: z.object({
    sessionId: zSessionId,
    focusTree: z.boolean().optional()
  })
});

const zSessionBrowserLoadOlderRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.loadOlder"),
  params: z.object({
    sessionId: zSessionId,
    beforeTurnId: zTurnId.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().positive().max(50).optional()
  })
});

const zSessionBrowserGetActionsRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.getActions"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zSessionBrowserRunActionRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.runAction"),
  params: z.object({
    sessionId: zSessionId,
    action: zSessionActionKindSchema
  })
});

const zSessionBrowserRenameRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.rename"),
  params: z.object({
    sessionId: zSessionId,
    title: z.string()
  })
});

const zChatGetCapabilitiesRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chat.getCapabilities"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zSkillsListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("skills.list"),
  params: z.object({
    cwds: z.array(z.string().min(1)).optional(),
    forceReload: z.boolean().optional()
  })
});

const zChatTreeGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zChatTreeJumpRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.jump"),
  params: z.object({
    sessionId: zSessionId,
    nodeId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().optional()
  })
});

const zChatTreeMarkReadRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.markRead"),
  params: z.object({ sessionId: zSessionId, nodeId: z.string().min(1) })
});

const zChatTreePrepareSendRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.prepareSend"),
  params: z.object({ sessionId: zSessionId, nodeId: zTurnId.optional() })
});

const zChatTreeSubmitRequestSchema = z.object({ id: zRequestId, method: z.literal("chatTree.submit"), params: zChatTreeSendInputSchema });
const zChatTreeRetryRequestSchema = z.object({ id: zRequestId, method: z.literal("chatTree.retry"), params: z.object({ operationId: z.string().min(1) }) });
const zChatTreeCancelRequestSchema = z.object({ id: zRequestId, method: z.literal("chatTree.cancel"), params: z.object({ operationId: z.string().min(1) }) });
const zChatTreeRemoveRequestSchema = z.object({ id: zRequestId, method: z.literal("chatTree.remove"), params: z.object({ operationId: z.string().min(1) }) });
const zChatTreeOperationsRequestSchema = z.object({ id: zRequestId, method: z.literal("chatTree.operations"), params: z.object({ sessionId: zSessionId }) });

const zChatTreeNodeActionRequestSchema = z.object({
  id: zRequestId, method: z.literal("chatTree.nodeAction"),
  params: z.object({ sessionId: zSessionId, nodeId: zTurnId,
    action: z.enum(["copy_session_id", "copy_awb_session_id", "open_rollout", "archive"]) })
});

const zDelegationGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("delegation.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zWorktreeGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("worktree.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zCheckpointGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("checkpoint.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zDiagnosticsGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("diagnostics.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zDiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
const zDiagnosticLogKindSchema = z.enum([
  "renderer-heartbeat",
  "renderer-stall",
  "renderer-long-task",
  "renderer-memory",
  "ipc-request",
  "event-push-batch",
  "ui-input-delay",
  "diagnostic-buffer",
  "runtime-pipeline",
  "manual"
]);

const zDiagnosticsWriteRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("diagnostics.write"),
  params: z.object({
    kind: zDiagnosticLogKindSchema,
    severity: zDiagnosticSeveritySchema.default("info"),
    source: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    occurredAt: zIsoDateTime.optional(),
    diagnosticId: z.string().min(1).optional(),
    sessionId: zSessionId.optional(),
    workspaceId: z.string().min(1).optional(),
    cursor: zCursor.optional(),
    requestId: zRequestId.optional(),
    metrics: zJsonRecord.optional(),
    context: zJsonRecord.optional()
  })
});

const zBackgroundRunGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("backgroundRun.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zErrorLogSeveritySchema = z.enum(["info", "warning", "error"]);

const zErrorLogWriteRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("errorLog.write"),
  params: z.object({
    message: z.string().min(1),
    severity: zErrorLogSeveritySchema.default("error"),
    source: z.string().min(1).optional(),
    stack: z.string().min(1).optional(),
    occurredAt: zIsoDateTime.optional(),
    context: zJsonRecord.optional()
  })
});

const zFileRunActionRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("file.runAction"),
  params: z.object({
    path: z.string().min(1),
    action: zFileActionKindSchema
  })
});

const zCodexTurnChangesGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.get"),
  params: z.object({
    sessionId: zSessionId,
    turnId: zTurnId
  })
});

const zCodexHookActivityGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.hookActivity.get"),
  params: z.object({
    sessionId: zSessionId,
    turnId: zTurnId
  })
});

const zCodexTurnChangesUndoRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.undo"),
  params: z.object({
    sessionId: zSessionId,
    turnId: zTurnId
  })
});

export const zWorkbenchEventSubscriptionFilterSchema = z.object({
  sessionId: zSessionId.optional(),
  conversationId: zConversationId.optional(),
  eventTypes: z.array(zSessionEventType).optional()
});

const zEventsSubscribeRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("events.subscribe"),
  params: z.object({
    subscriptionId: z.string().min(1).optional(),
    fromCursor: zCursor.optional(),
    filter: zWorkbenchEventSubscriptionFilterSchema.optional()
  })
});

const zEventsUnsubscribeRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("events.unsubscribe"),
  params: z.object({
    subscriptionId: z.string().min(1)
  })
});

const zEventsReplayRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("events.replay"),
  params: z.object({
    fromCursor: zCursor,
    toCursor: zCursor.optional(),
    filter: zWorkbenchEventSubscriptionFilterSchema.optional()
  })
});

export const zSessionRpcRequestSchema = z.discriminatedUnion("method", [
  zEngineListRequestSchema,
  zEngineGetSurfaceRequestSchema,
  zEngineListModelsRequestSchema,
  zEngineSelectRequestSchema,
  zSettingsGetRequestSchema,
  zSettingsUpdateRequestSchema,
  zDomainSnapshotRequestSchema,
  zSessionListRequestSchema,
  zWorkspaceListRequestSchema,
  zWorkspacePickDirectoryRequestSchema,
  zWorkspaceAddRequestSchema,
  zWorkspaceRemoveRequestSchema,
  zWorkspaceSelectRequestSchema,
  zSessionBrowserListRequestSchema,
  zSessionBrowserRepairRequestSchema,
  zSessionBrowserCreateRequestSchema,
  zSessionBrowserOpenRequestSchema,
  zSessionBrowserActivateRequestSchema,
  zSessionBrowserLoadOlderRequestSchema,
  zSessionBrowserGetActionsRequestSchema,
  zSessionBrowserRunActionRequestSchema,
  zSessionBrowserRenameRequestSchema,
  zChatGetCapabilitiesRequestSchema,
  zSkillsListRequestSchema,
  zChatTreeGetRequestSchema,
  zChatTreeNodeActionRequestSchema,
  zChatTreeJumpRequestSchema,
  zChatTreeMarkReadRequestSchema,
  zChatTreePrepareSendRequestSchema,
  zChatTreeSubmitRequestSchema,
  zChatTreeRetryRequestSchema,
  zChatTreeCancelRequestSchema,
  zChatTreeRemoveRequestSchema,
  zChatTreeOperationsRequestSchema,
  zDelegationGetRequestSchema,
  zWorktreeGetRequestSchema,
  zCheckpointGetRequestSchema,
  zDiagnosticsGetRequestSchema,
  zDiagnosticsWriteRequestSchema,
  zBackgroundRunGetRequestSchema,
  zErrorLogWriteRequestSchema,
  zFileRunActionRequestSchema,
  zCodexHookActivityGetRequestSchema,
  zCodexTurnChangesGetRequestSchema,
  zCodexTurnChangesUndoRequestSchema,
  zRuntimeCommandRequestSchema,
  zEventsSubscribeRequestSchema,
  zEventsUnsubscribeRequestSchema,
  zEventsReplayRequestSchema
]);

const zEngineListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.list"),
  ok: z.literal(true),
  result: z.object({
    engines: z.array(zEngineDefinitionRpcSchema)
  })
});

const zEngineGetSurfaceResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.getSurface"),
  ok: z.literal(true),
  result: z.object({
    surface: zEngineSurfaceRpcSchema
  })
});

const zEngineListModelsResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.listModels"),
  ok: z.literal(true),
  result: z.object({
    catalog: zEngineModelCatalogRpcSchema
  })
});

const zEngineSelectResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.select"),
  ok: z.literal(true),
  result: z.object({
    selectedEngineId: z.string().min(1)
  })
});

const zDomainSnapshotResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("domain.snapshot"),
  ok: z.literal(true),
  result: z.object({
    snapshot: zDomainSnapshotSchema,
    cursor: zCursor.optional()
  })
});

const zSettingsGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.get"),
  ok: z.literal(true),
  result: zSessionSettingsSchema
});

const zSettingsUpdateResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.update"),
  ok: z.literal(true),
  result: zSessionSettingsSchema
});

const zSessionListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("session.list"),
  ok: z.literal(true),
  result: z.object({
    sessions: z.array(zChatSessionSchema)
  })
});

const zWorkspaceListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.list"),
  ok: z.literal(true),
  result: z.object({
    workspaces: z.array(zWorkspaceRecordSchema),
    lastActiveWorkspaceId: z.string().min(1).optional(),
    lastActiveSessionId: z.string().min(1).optional()
  })
});

const zWorkspacePickDirectoryResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.pickDirectory"),
  ok: z.literal(true),
  result: z.object({
    canceled: z.boolean(),
    rootPath: z.string().min(1).optional()
  })
});

const zWorkspaceAddResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.add"),
  ok: z.literal(true),
  result: z.object({
    workspace: zWorkspaceRecordSchema
  })
});

const zWorkspaceRemoveResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.remove"),
  ok: z.literal(true),
  result: z.object({
    workspaceId: z.string().min(1),
    removed: z.boolean()
  })
});

const zWorkspaceSelectResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.select"),
  ok: z.literal(true),
  result: z.object({
    workspaceId: z.string().min(1),
    activeSessionId: zSessionId.optional()
  })
});

const zSessionBrowserListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.list"),
  ok: z.literal(true),
  result: zSessionBrowserPageSchema
});

const zSessionBrowserCreateResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.create"),
  ok: z.literal(true),
  result: z.object({
    sessionId: zSessionId,
    conversationId: zConversationId
  })
});

const zSessionBrowserRepairResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.repair"),
  ok: z.literal(true),
  result: z.object({
    workspaces: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative()
  })
});

const zSessionBrowserOpenResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.open"),
  ok: z.literal(true),
  result: z.object({
    page: zSessionWindowSchema
  })
});

const zSessionBrowserActivateResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.activate"),
  ok: z.literal(true),
  result: z.object({
    sessionId: zSessionId
  })
});

const zSessionBrowserLoadOlderResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.loadOlder"),
  ok: z.literal(true),
  result: z.object({
    page: zSessionWindowSchema
  })
});

const zSessionBrowserGetActionsResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.getActions"),
  ok: z.literal(true),
  result: z.object({
    actions: z.array(zSessionActionDescriptorSchema)
  })
});

const zSessionBrowserRunActionResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.runAction"),
  ok: z.literal(true),
  result: zSessionActionResultSchema
});

const zSessionBrowserRenameResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.rename"),
  ok: z.literal(true),
  result: z.object({
    sessionId: zSessionId,
    title: z.string().min(1)
  })
});

const zChatGetCapabilitiesResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chat.getCapabilities"),
  ok: z.literal(true),
  result: z.object({
    capabilities: zChatInteractionCapabilitiesRpcSchema
  })
});

const zSkillsListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("skills.list"),
  ok: z.literal(true),
  result: z.object({
    skills: z.array(zSkillDescriptorRpcSchema)
  })
});

const zChatTreeGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.get"),
  ok: z.literal(true),
  result: z.object({
    chatTree: zChatTreeSnapshotSchema
  })
});

const zChatTreeJumpResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.jump"),
  ok: z.literal(true),
  result: z.object({
    jumped: z.boolean()
  })
});

const zChatTreeMarkReadResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.markRead"),
  ok: z.literal(true),
  result: z.object({ readNodeIds: z.array(z.string().min(1)) })
});

const zChatTreePrepareSendResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.prepareSend"),
  ok: z.literal(true),
  result: z.object({ sessionId: zSessionId })
});

const zChatTreeSubmitResponseSchema = z.object({ id: zRequestId, method: z.literal("chatTree.submit"), ok: z.literal(true), result: zChatTreeSendOperationSchema });
const zChatTreeRetryResponseSchema = z.object({ id: zRequestId, method: z.literal("chatTree.retry"), ok: z.literal(true), result: zChatTreeSendOperationSchema });
const zChatTreeCancelResponseSchema = z.object({ id: zRequestId, method: z.literal("chatTree.cancel"), ok: z.literal(true), result: zChatTreeSendOperationSchema });
const zChatTreeRemoveResponseSchema = z.object({ id: zRequestId, method: z.literal("chatTree.remove"), ok: z.literal(true), result: zChatTreeSendOperationSchema });
const zChatTreeOperationsResponseSchema = z.object({ id: zRequestId, method: z.literal("chatTree.operations"), ok: z.literal(true), result: z.object({ operations: z.array(zChatTreeSendOperationSchema) }) });

const zChatTreeNodeActionResponseSchema = z.object({
  id: zRequestId, method: z.literal("chatTree.nodeAction"), ok: z.literal(true), result: zSessionActionResultSchema
});

const zDelegationGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("delegation.get"),
  ok: z.literal(true),
  result: z.object({
    delegation: zDelegationSnapshotSchema
  })
});

const zWorktreeGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("worktree.get"),
  ok: z.literal(true),
  result: z.object({
    worktree: zWorktreeSnapshotSchema
  })
});

const zCheckpointGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("checkpoint.get"),
  ok: z.literal(true),
  result: z.object({
    checkpoint: zCheckpointSnapshotSchema
  })
});

const zDiagnosticsGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("diagnostics.get"),
  ok: z.literal(true),
  result: z.object({
    diagnostics: zDiagnosticsSnapshotSchema
  })
});

const zBackgroundRunGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("backgroundRun.get"),
  ok: z.literal(true),
  result: z.object({
    backgroundRun: zBackgroundRunSnapshotSchema
  })
});

const zDiagnosticsWriteResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("diagnostics.write"),
  ok: z.literal(true),
  result: z.object({
    logged: z.literal(true),
    entryId: z.string().min(1),
    logPath: z.string().min(1)
  })
});

const zErrorLogWriteResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("errorLog.write"),
  ok: z.literal(true),
  result: z.object({
    logged: z.literal(true),
    entryId: z.string().min(1),
    logPath: z.string().min(1)
  })
});

const zFileRunActionResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("file.runAction"),
  ok: z.literal(true),
  result: z.object({
    result: zFileActionResultSchema
  })
});

const zCodexTurnChangesGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.get"),
  ok: z.literal(true),
  result: z.object({
    engineId: z.literal("codex"),
    sessionId: zSessionId,
    turnId: zTurnId,
    changedFiles: z.array(zCodexChangedFileSchema).default([]),
    canUndo: z.boolean()
  })
});

const zCodexHookActivityGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.hookActivity.get"),
  ok: z.literal(true),
  result: z.object({
    engineId: z.literal("codex"),
    sessionId: zSessionId,
    turnId: zTurnId,
    runs: z.array(zCodexHookRunSchema).default([])
  })
});

const zCodexTurnChangesUndoResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.undo"),
  ok: z.literal(true),
  result: z.object({
    engineId: z.literal("codex"),
    sessionId: zSessionId,
    turnId: zTurnId,
    undone: z.boolean(),
    displayPath: z.string().min(1),
    errorMessage: z.string().min(1).optional()
  })
});

const zRuntimeCommandResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("runtime.command"),
  ok: z.literal(true),
  result: z.object({
    commandId: zRequestId,
    commandType: zSessionCommandType,
    accepted: z.boolean().default(true),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional()
    }).optional(),
    sessionId: zSessionId.optional(),
    turnId: zTurnId.optional(),
    delivery: z.enum(["steered", "start_or_steer"]).optional(),
    providerSessionId: z.string().min(1).optional()
  })
});

const zEventsSubscribeResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("events.subscribe"),
  ok: z.literal(true),
  result: z.object({
    subscriptionId: z.string().min(1),
    fromCursor: zCursor.optional()
  })
});

const zEventsUnsubscribeResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("events.unsubscribe"),
  ok: z.literal(true),
  result: z.object({
    unsubscribed: z.boolean().default(true)
  })
});

const zEventsReplayResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("events.replay"),
  ok: z.literal(true),
  result: z.object({
    status: z.enum(["ok", "gap"]).default("ok"),
    reason: z.enum(["cursor_not_found"]).optional(),
    replayed: z.number().int().nonnegative(),
    fromCursor: zCursor,
    toCursor: zCursor.optional(),
    envelopes: z.array(zEventEnvelopeSchema).default([])
  })
});

const zWorkbenchRpcErrorResponseSchema = z.object({
  id: zRequestId,
  method: z.enum(sessionRpcMethods),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: zJsonRecord.optional()
  })
});

export const zSessionRpcResponseSchema = z.union([
  zEngineListResponseSchema,
  zEngineGetSurfaceResponseSchema,
  zEngineListModelsResponseSchema,
  zEngineSelectResponseSchema,
  zSettingsGetResponseSchema,
  zSettingsUpdateResponseSchema,
  zDomainSnapshotResponseSchema,
  zSessionListResponseSchema,
  zWorkspaceListResponseSchema,
  zWorkspacePickDirectoryResponseSchema,
  zWorkspaceAddResponseSchema,
  zWorkspaceRemoveResponseSchema,
  zWorkspaceSelectResponseSchema,
  zSessionBrowserListResponseSchema,
  zSessionBrowserRepairResponseSchema,
  zSessionBrowserCreateResponseSchema,
  zSessionBrowserOpenResponseSchema,
  zSessionBrowserActivateResponseSchema,
  zSessionBrowserLoadOlderResponseSchema,
  zSessionBrowserGetActionsResponseSchema,
  zSessionBrowserRunActionResponseSchema,
  zSessionBrowserRenameResponseSchema,
  zChatGetCapabilitiesResponseSchema,
  zSkillsListResponseSchema,
  zChatTreeGetResponseSchema,
  zChatTreeNodeActionResponseSchema,
  zChatTreeJumpResponseSchema,
  zChatTreeMarkReadResponseSchema,
  zChatTreePrepareSendResponseSchema,
  zChatTreeSubmitResponseSchema,
  zChatTreeRetryResponseSchema,
  zChatTreeCancelResponseSchema,
  zChatTreeRemoveResponseSchema,
  zChatTreeOperationsResponseSchema,
  zDelegationGetResponseSchema,
  zWorktreeGetResponseSchema,
  zCheckpointGetResponseSchema,
  zDiagnosticsGetResponseSchema,
  zDiagnosticsWriteResponseSchema,
  zBackgroundRunGetResponseSchema,
  zErrorLogWriteResponseSchema,
  zFileRunActionResponseSchema,
  zCodexHookActivityGetResponseSchema,
  zCodexTurnChangesGetResponseSchema,
  zCodexTurnChangesUndoResponseSchema,
  zRuntimeCommandResponseSchema,
  zEventsSubscribeResponseSchema,
  zEventsUnsubscribeResponseSchema,
  zEventsReplayResponseSchema,
  zWorkbenchRpcErrorResponseSchema
]);

export const zSessionEventPushSchema = z.object({
  channel: z.literal("session.events"),
  subscriptionId: z.string().min(1),
  envelope: zEventEnvelopeSchema
});

export const zSessionEventPushBatchSchema = z.object({
  channel: z.literal("session.events.batch"),
  pushes: z.array(zSessionEventPushSchema).min(1)
});

export type SessionSettingsRpc = z.infer<typeof zSessionSettingsSchema>;
/** 设置更新入参：`titleGenerationModelId` 传 null 表示清除自定义，回落到内置默认模型。 */
export type SessionSettingsUpdateRpc = Omit<
  Partial<SessionSettingsRpc>,
  "titleGenerationModelId"
> & {
  titleGenerationModelId?: string | null;
};
export type EngineProgramResolutionRpc =
  SessionSettingsRpc["engineProgramResolutionsByEngineId"][string];
export type SessionEventSubscriptionFilter = z.infer<
  typeof zWorkbenchEventSubscriptionFilterSchema
>;
export type SessionRpcRequest = z.infer<typeof zSessionRpcRequestSchema>;
export type SessionRpcResponse = z.infer<typeof zSessionRpcResponseSchema>;
export type RuntimeCommandReceiptRpc = z.infer<
  typeof zRuntimeCommandResponseSchema
>["result"];
export type SessionEventPush = z.infer<typeof zSessionEventPushSchema>;
export type SessionEventPushBatch = z.infer<typeof zSessionEventPushBatchSchema>;
export type WorkspaceRecordRpc = z.infer<typeof zWorkspaceRecordSchema>;
export type SessionActionKindRpc = z.infer<typeof zSessionActionKindSchema>;
export type SessionActionDescriptorRpc = z.infer<typeof zSessionActionDescriptorSchema>;
export type SessionActionResultRpc = z.infer<typeof zSessionActionResultSchema>;
export type ChatInteractionCapabilitiesRpc = z.infer<
  typeof zChatInteractionCapabilitiesRpcSchema
>;
export type ComposerSlashSuggestionRpc = z.infer<
  typeof zComposerSlashSuggestionRpcSchema
>;
export type SkillDescriptorRpc = z.infer<typeof zSkillDescriptorRpcSchema>;
export type ConversationGraphSnapshotRpc = z.infer<
  typeof zConversationGraphSnapshotSchema
>;
export type ChatTreeSnapshotRpc = z.infer<typeof zChatTreeSnapshotSchema>;
export type ChatTreeNodeActionInput = z.infer<typeof zChatTreeNodeActionRequestSchema>["params"];
export type DelegationSnapshotRpc = z.infer<typeof zDelegationSnapshotSchema>;
export type WorktreeSnapshotRpc = z.infer<typeof zWorktreeSnapshotSchema>;
export type CheckpointSnapshotRpc = z.infer<typeof zCheckpointSnapshotSchema>;
export type DiagnosticsSnapshotRpc = z.infer<typeof zDiagnosticsSnapshotSchema>;
export type DiagnosticLogKindRpc = z.infer<typeof zDiagnosticLogKindSchema>;
export type DiagnosticsWriteInputRpc = z.infer<
  typeof zDiagnosticsWriteRequestSchema
>["params"];
export type DiagnosticsWriteResultRpc = z.infer<
  typeof zDiagnosticsWriteResponseSchema
>["result"];
export type BackgroundRunSnapshotRpc = z.infer<typeof zBackgroundRunSnapshotSchema>;
export type ErrorLogWriteInputRpc = z.infer<
  typeof zErrorLogWriteRequestSchema
>["params"];
export type ErrorLogWriteResultRpc = z.infer<
  typeof zErrorLogWriteResponseSchema
>["result"];
export type SessionWindowRpc = z.infer<typeof zSessionWindowSchema>;
export type FileReferenceRpc = z.infer<typeof zFileReferenceSchema>;
export type FileActionKindRpc = z.infer<typeof zFileActionKindSchema>;
export type FileActionResultRpc = z.infer<typeof zFileActionResultSchema>;
export type CodexTurnChangeKindRpc = z.infer<typeof zCodexTurnChangeKindSchema>;
export type CodexChangedFileRpc = z.infer<typeof zCodexChangedFileSchema>;
export type CodexHookOutputEntryKindRpc = z.infer<
  typeof zCodexHookOutputEntryKindSchema
>;
export type CodexHookRunStatusRpc = z.infer<typeof zCodexHookRunStatusSchema>;
export type CodexHookRunRpc = z.infer<typeof zCodexHookRunSchema>;
export type CodexHookActivityResultRpc = z.infer<
  typeof zCodexHookActivityGetResponseSchema
>["result"];
export type CodexTurnChangesResultRpc = z.infer<
  typeof zCodexTurnChangesGetResponseSchema
>["result"];
export type CodexTurnChangesUndoResultRpc = z.infer<
  typeof zCodexTurnChangesUndoResponseSchema
>["result"];

export type SessionEventHandler = (event: SessionEventPush) => void;

export type SessionClientApi = {
  request: (request: SessionRpcRequest) => Promise<SessionRpcResponse>;
  subscribe: (
    params: Extract<SessionRpcRequest, { method: "events.subscribe" }>["params"],
    handler: SessionEventHandler
  ) => Promise<{ subscriptionId: string; unsubscribe: () => Promise<void> }>;
};

export const parseSessionRpcRequest = (value: unknown): SessionRpcRequest =>
  zSessionRpcRequestSchema.parse(value);

export const parseSessionRpcResponse = (value: unknown): SessionRpcResponse =>
  zSessionRpcResponseSchema.parse(value);

export const parseSessionEventPush = (value: unknown): SessionEventPush =>
  zSessionEventPushSchema.parse(value);

export const safeParseSessionRpcRequest = (value: unknown) =>
  zSessionRpcRequestSchema.safeParse(value);

export const safeParseSessionRpcResponse = (value: unknown) =>
  zSessionRpcResponseSchema.safeParse(value);

export const safeParseSessionEventPush = (value: unknown) =>
  zSessionEventPushSchema.safeParse(value);

export const safeParseSessionEventPushBatch = (value: unknown) =>
  zSessionEventPushBatchSchema.safeParse(value);
