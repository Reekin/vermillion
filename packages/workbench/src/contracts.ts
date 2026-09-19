import { z } from "zod";
import { zSearchHit, zSearchStats } from "./search-contract.js";

export const zWorkspace = z.object({
  workspaceId: z.string().min(1),
  rootPath: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string(),
  lastActiveAt: z.string()
});
export type Workspace = z.infer<typeof zWorkspace>;

/** queued -> running -> closed; decision parks a work item until the user answers. */
export const workItemStatuses = ["preparing", "queued", "running", "merging", "decision", "closed", "cancelled"] as const;
export const zWorkItemStatus = z.enum(workItemStatuses);
export type WorkItemStatus = z.infer<typeof zWorkItemStatus>;

export const zRisk = z.enum(["R0", "R1", "R2"]);
export type Risk = z.infer<typeof zRisk>;

export const issueStatuses = ["open", "investigating", "decision", "started", "closed", "duplicate"] as const;
export const zIssueStatus = z.enum(issueStatuses);
export const zIssueType = z.enum(["problem", "suggestion"]);
export const zIssueSource = z.enum(["user", "maintainer", "liaison"]);
export const zIssueEvidenceKind = z.enum(["static", "reproduced", "unverified", "user"]);

export const zIssueRequirement = z.object({
  text: z.string().min(1), path: z.string().min(1).optional(), section: z.string().optional(), commit: z.string().min(1).optional()
});
export const zIssueEvidence = z.object({ kind: zIssueEvidenceKind, text: z.string().min(1), path: z.string().min(1).optional() });
export const zIssueActivity = z.object({
  at: z.string(), kind: z.enum(["created", "updated", "evidence", "discussion", "workItem", "resolved"]),
  message: z.string().min(1), sessionId: z.string().min(1).optional(), workItemId: z.string().min(1).optional(), issueId: z.string().min(1).optional()
});
export const zIssue = z.object({
  issueId: z.string().min(1), title: z.string().min(1), summary: z.string(), domainId: z.string().min(1),
  source: zIssueSource, type: zIssueType, status: zIssueStatus,
  requirement: zIssueRequirement.optional(), evidence: z.array(zIssueEvidence), suggestion: z.string().optional(),
  decisionQuestion: z.string().min(1).optional(), resolutionReason: z.string().min(1).optional(), duplicateOf: z.string().min(1).optional(),
  sourceSessionId: z.string().min(1).optional(), sourceTurnId: z.string().min(1).optional(),
  discussionSessionId: z.string().min(1).optional(), discussionTurnId: z.string().min(1).optional(),
  workItemIds: z.array(z.string().min(1)), activities: z.array(zIssueActivity), unread: z.boolean(),
  createdAt: z.string(), updatedAt: z.string()
});
export type Issue = z.infer<typeof zIssue>;

export const zDomainConfig = z.object({
  domainId: z.string().min(1),
  enabled: z.boolean(),
  changeTrigger: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
  triggerPaths: z.array(z.string().min(1)),
  autoWorkEnabled: z.boolean(),
  authorizationScope: z.array(z.string().min(1)),
  lastCommit: z.string().min(1).optional(),
  retryAt: z.string().datetime().optional(),
  nextRunAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type DomainConfig = z.infer<typeof zDomainConfig>;

export const zDomainDefinition = z.object({
  domainId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  path: z.string().min(1),
  standards: z.array(z.string().min(1)),
  config: zDomainConfig
});
export type DomainDefinition = z.infer<typeof zDomainDefinition>;

export const zPatrolRun = z.object({
  patrolRunId: z.string().min(1),
  domainId: z.string().min(1),
  trigger: z.enum(["manual", "change", "scheduled"]),
  status: z.enum(["queued", "running", "completed", "skipped", "failed"]),
  changedPaths: z.array(z.string()),
  requirementRefs: z.array(z.object({ path: z.string().min(1), section: z.string().optional(), commit: z.string().min(1) })),
  targetCommit: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  issueIds: z.array(z.string().min(1)),
  workItemIds: z.array(z.string().min(1)),
  summary: z.string().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional()
});
export type PatrolRun = z.infer<typeof zPatrolRun>;

export const zDocRef = z.object({
  path: z.string().min(1),
  section: z.string().optional(),
  /** Human-readable context; never participates in heading lookup or change detection. */
  description: z.string().trim().min(1).optional(),
  commit: z.string().min(1)
});

/** One observable condition that must hold when the work is done. Says what to see, not how to look. */
export const zAcceptanceItem = z.object({
  text: z.string().min(1),
  /** Sentence or heading in a ref doc this condition comes from, so it can be traced back. */
  source: z.string().optional()
});

export const zScope = z.object({
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  allowedPaths: z.array(z.string())
});

export const zEvidence = z.object({
  summary: z.string(),
  commit: z.string().optional(),
  commands: z.array(z.object({ command: z.string(), output: z.string() })),
  assumptions: z.array(z.string()),
  untested: z.array(z.string()),
  outOfScopeFindings: z.array(z.string()),
  attachments: z.array(z.string()),
  submittedAt: z.string()
});

export const zReviewDisposition = z.object({
  comment: z.string(),
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string()
});

export const verificationStatuses = ["pass", "defect", "blocked", "incomplete"] as const;
export const zVerificationStatus = z.enum(verificationStatuses);
export type VerificationStatus = z.infer<typeof zVerificationStatus>;

const zStoredVerifyItem = z.object({
  index: z.number().int().nonnegative(),
  status: zVerificationStatus,
  evidence: z.string()
});
export const zVerifyResult = z.object({
  items: z.array(zStoredVerifyItem),
  verdict: z.enum(["pass", "rework"]),
  verifiedAt: z.string()
});

export const zVerifySubmission = z.object({
  items: z.array(z.object({ index: z.number().int().nonnegative(), status: zVerificationStatus, evidence: z.string() })),
  verdict: z.enum(["pass", "rework"])
});
export type VerifySubmission = z.infer<typeof zVerifySubmission>;

export const zRejection = z.object({ reason: z.string().min(1), at: z.string() });

/** Read-only API projection of Execution; never stored on the work-item contract. */
export const zRun = z.object({
  forkSessionId: z.string().optional(),
  forkTurnId: z.string().optional(),
  baseCommit: z.string().optional(),
  sessionId: z.string().optional(),
  lastTurnId: z.string().optional(),
  heartbeatAt: z.string().optional(),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  /** Pending execution delivery; cleared only after delivery succeeds. */
  resumeMessage: z.string().optional(),
  /** Set by the scheduler when the worker session ended without submit/decision; the item goes back to queued with this note. */
  lastFailure: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
  /** Earliest automatic retry time from the persisted execution. */
  retryAt: z.string().datetime().optional(),
  /** Set when the user stopped a Worker turn; only an explicit work-item resume clears it. */
  pauseReason: z.literal("user").optional(),
  /** Automatic or user-owned execution. */
  control: z.enum(["auto", "manual", "paused"]).optional(),
  attemptId: z.string().optional(),
  activeTurnId: z.string().optional(),
  waitReason: z.string().optional(),
  pendingMessageId: z.string().optional(),
  migratedFromSessionId: z.string().optional(),
});

export const zWorkItem = z.object({
  workItemId: z.string().min(1),
  issueId: z.string().min(1).optional(),
  owner: z.object({
    domainId: z.string().min(1), patrolRunId: z.string().min(1),
    authorizationScope: z.array(z.string().min(1)), authorizationReason: z.string().min(1),
    expectedBehavior: z.string().min(1), requirement: zIssueRequirement,
    evidence: z.array(zIssueEvidence).min(1)
  }).optional(),
  /** Origin of the execution branch; absent for manually created work. */
  sourceSessionId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  treeId: z.string().optional(),
  requestId: z.string().optional(),
  /** Increments whenever the work item contract changes; submissions identify the revision they used. */
  contractRevision: z.number().int().nonnegative(),
  title: z.string().min(1),
  objective: z.string(),
  status: zWorkItemStatus,
  risk: zRisk,
  /** Concrete shared resource instances occupied during execution. */
  needs: z.array(z.string()),
  /** Work items that must be closed before this one is scheduled. */
  dependsOn: z.array(z.string()),
  refs: z.array(zDocRef),
  scope: zScope,
  acceptance: z.array(zAcceptanceItem),
  evidence: zEvidence.optional(),
  review: z.array(zReviewDisposition),
  verify: zVerifyResult.optional(),
  merge: z.object({
    commit: z.string().optional(),
    commits: z.array(z.string()).optional(),
    diffStat: z.string(),
    mergedAt: z.string(),
    acknowledgedAt: z.string().optional(),
    rollbackCommit: z.string().optional()
  }).optional(),
  rejections: z.array(zRejection),
  decisions: z.array(z.string()),
  /** Derived execution view for callers; runtime mutations use Execution directly. */
  run: zRun,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type WorkItem = z.infer<typeof zWorkItem>;

/** Root code writers share the concrete workspace directory; isolated and read-only work does not. */
export const effectiveNeeds = (item: WorkItem): string[] => [...new Set([
  ...item.needs, ...(!item.run.worktreePath && item.scope.allowedPaths.length ? ["workspace:root"] : [])
])];

export const zWorkMessage = z.object({
  content: z.string(),
  attachments: z.array(z.object({
    attachmentId: z.string().min(1), mimeType: z.string().min(1), uri: z.string().min(1),
    displayUri: z.string().min(1).optional(), name: z.string().min(1).optional()
  })).optional(),
  execution: z.object({
    modelId: z.string().min(1).optional(), reasoningOptionId: z.string().min(1).optional(),
    serviceTierId: z.string().min(1).nullable().optional()
  }).optional()
});
export type WorkMessage = z.infer<typeof zWorkMessage>;

export const zWorkRequest = z.object({
  requestId: z.string(), sourceSessionId: z.string(), sourceTurnId: z.string().optional(),
  message: zWorkMessage.optional(),
  scope: z.string().optional(), treeId: z.string().optional(), workerSessionId: z.string().optional(),
  status: z.enum(["pending", "preparing", "ready", "failed", "cancelled"]),
  attempts: z.number().int().nonnegative().optional(), retryAt: z.string().optional(),
  failure: z.string().optional(),
  /** Automatic dispatch, explicit user continuation, or durable pause. */
  control: z.enum(["auto", "manual", "paused"]).optional(),
  /** Stable identity for the preparation execution currently being reconciled. */
  attemptId: z.string().optional(),
  activeTurnId: z.string().optional(),
  waitReason: z.string().optional(),
  handoff: z.object({
    sessionId: z.string(), workItemIds: z.array(z.string()), refs: z.array(zDocRef), at: z.string()
  }).optional(),
  pendingMessageId: z.string().optional(),
  workItemIds: z.array(z.string()).optional(),
  migratedToSessionId: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string()
});
export type WorkRequest = z.infer<typeof zWorkRequest>;

export const zDecisionOption = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** What happens if this option is chosen; shown next to the label, never hidden in a tooltip. */
  detail: z.string().optional()
});

export const zDecisionCard = z.object({
  decisionId: z.string().min(1),
  requestId: z.string().optional(),
  workItemId: z.string().optional(),
  sessionId: z.string().optional(),
  actionId: z.string().optional(),
  withdrawn: z.object({ reason: z.string().min(1), at: z.string(), sessionId: z.string() }).optional(),
  deliveryPending: z.boolean().optional(),
  /** Who raised it: a worker (default) or the workbench after repeated failures. */
  kind: z.enum(["worker", "attempts"]).optional(),
  /** One plain sentence: what is blocked. */
  question: z.string().min(1),
  /** Two or three sentences: what happened and why the user has to decide. */
  context: z.string(),
  /** Source locations, logs, evidence paths. Collapsed by default. */
  details: z.string().optional(),
  options: z.array(zDecisionOption),
  recommended: z.string().optional(),
  /** Why the recommended option. */
  recommendation: z.string().optional(),
  /** Contract changes (workItem.update notes) that landed while the card was unanswered; shown after the context and delivered with the answer. */
  adjustments: z.array(z.object({ note: z.string(), at: z.string() })).optional(),
  /** key is absent for a free answer: the user wrote a note without picking an option. */
  answer: z.object({ key: z.string().optional(), note: z.string().optional(), at: z.string() }).optional(),
  createdAt: z.string()
});
export type DecisionCard = z.infer<typeof zDecisionCard>;

export const zDocFile = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  /** Always provided by docs.list; absent on older callers' document metadata. */
  isText: z.boolean().optional()
});
export type DocFile = z.infer<typeof zDocFile>;

export const zRoleFile = z.object({
  roleId: z.string().min(1),
  title: z.string(),
  /** Which layer the effective prompt comes from. */
  source: z.enum(["global", "workspace"])
});
export type RoleFile = z.infer<typeof zRoleFile>;

/** Explicit role model fields; omitted fields inherit the composer's selection. */
export const zRoleExecutionOverrides = z.object({
  modelId: z.string().min(1).optional(),
  reasoningOptionId: z.string().min(1).nullable().optional(),
  serviceTierId: z.string().min(1).nullable().optional()
});
export type RoleExecutionOverrides = z.infer<typeof zRoleExecutionOverrides>;

export const zResolvedRole = z.object({
  content: z.string(),
  modelConfig: zRoleExecutionOverrides.optional()
});
export type ResolvedRole = z.infer<typeof zResolvedRole>;

export const zDocChange = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"])
});
export type DocChange = z.infer<typeof zDocChange>;

export const zDocCommit = z.object({
  commit: z.string().min(1),
  message: z.string().min(1)
});
export type DocCommit = z.infer<typeof zDocCommit>;

/** Per-workspace execution scheduler settings. */
export const zScheduler = z.object({
  enabled: z.boolean(),
  maxWorkers: z.number().int().min(1).max(8)
});
export type Scheduler = z.infer<typeof zScheduler>;

export const zWorkDiagnosis = z.object({
  request: zWorkRequest,
  workItems: z.array(zWorkItem),
  scheduler: zScheduler,
  waiting: z.array(z.string()),
  availableActions: z.array(z.object({ method: z.string(), condition: z.string() }))
});
export type WorkDiagnosis = z.infer<typeof zWorkDiagnosis>;

export const agentRoles = ["worker"] as const;
export const zAgentRole = z.enum(agentRoles);
export type AgentRole = z.infer<typeof zAgentRole>;

/** One background agent session started by the orchestrator; stored at .vermillion/runs/<runId>.json. */
export const zAgentRun = z.object({
  runId: z.string().min(1),
  role: zAgentRole,
  sessionId: z.string().min(1),
  workItemId: z.string().optional(),
  actionId: z.string().optional(),
  status: z.enum(["running", "done", "failed"]),
  turns: z.number().int().nonnegative(),
  note: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional()
});
export type AgentRun = z.infer<typeof zAgentRun>;

/** Durable process metadata shared by execution and integration checkpoints. */
const zProcess = z.object({
  actionId: z.string(),
  workItemId: z.string(),
  status: z.enum(["pending", "running", "retry", "decision", "done", "cancelled"]),
  attempts: z.number().int().nonnegative(),
  retryAt: z.string().optional(),
  failure: z.string().optional(),
  history: z.array(z.object({ at: z.string(), event: z.string(), message: z.string(), decisionId: z.string().optional() })),
  createdAt: z.string(),
  updatedAt: z.string()
});

/** One pending delivery to a worker. Writers only append; the scheduler renders and consumes the list. */
export const executionNoticeKinds = ["contract", "docs", "rejected", "resumed", "nag"] as const;
export const zExecutionNotice = z.object({
  at: z.string(),
  kind: z.enum(executionNoticeKinds),
  text: z.string().min(1)
});
export type ExecutionNotice = z.infer<typeof zExecutionNotice>;

const executionNoticeLabels: Record<ExecutionNotice["kind"], string> = {
  contract: "合同调整", docs: "文档合入", rejected: "提交退回", resumed: "恢复执行", nag: "催办"
};

/** Every pending notice as the one message a worker receives, each labeled by why it arrived. */
export const renderExecutionNotices = (notices: ExecutionNotice[]): string =>
  notices.map((notice) => "【" + executionNoticeLabels[notice.kind] + "】" + notice.text).join("\n");

/** The sole owner of a worker's runtime state and pending delivery. */
export const zExecution = zProcess.extend({
  ...zRun.omit({ resumeMessage: true, lastFailure: true, attempts: true, retryAt: true }).shape,
  kind: z.literal("execute"),
  stage: z.enum(["open", "deliver", "execute"]),
  /** Git checkpoint being handled by this Worker execution. */
  integrationActionId: z.string().optional(),
  runId: z.string().optional(),
  deliveredAt: z.string().optional(),
  /** Most recent turn started by scheduler delivery, used to recover its origin. */
  scheduledTurnId: z.string().optional(),
  /** Notices waiting for the next delivery; emptied by the scheduler once they are delivered. */
  notices: z.array(zExecutionNotice),
  idleTurns: z.number().int().nonnegative(),
  control: z.enum(["auto", "manual", "paused"]).optional(),
  attemptId: z.string().optional(),
  activeTurnId: z.string().optional(),
  waitReason: z.string().optional(),
  pendingMessageId: z.string().optional(),
  migratedFromSessionId: z.string().optional()
});
export type Execution = z.infer<typeof zExecution>;

/** One item's serialized Git operation. */
export const zIntegration = zProcess.extend({
  kind: z.literal("integration"),
  stage: z.enum(["merge", "rollback"]),
  message: z.string(),
  /** Present while the original Worker owns a failed or explicitly delegated merge. */
  agent: z.object({
    sessionId: z.string().min(1),
    note: z.string().optional(),
    requestedAt: z.string()
  }).strict().optional(),
  integration: z.object({
    operation: z.enum(["merge", "rollback"]),
    contractRevision: z.number().int().nonnegative(),
    before: z.string().optional(),
    target: z.string().optional(),
    targets: z.array(z.string()).optional(),
    commit: z.string().optional(),
    commits: z.array(z.string()).optional(),
    diffStat: z.string(),
    reason: z.string().optional()
  })
});
export type Integration = z.infer<typeof zIntegration>;
export const zWorkflowAction = z.discriminatedUnion("kind", [zExecution, zIntegration]);
export type WorkflowAction = z.infer<typeof zWorkflowAction>;
export const actionIsOpen = (action: WorkflowAction): boolean => action.status !== "done" && action.status !== "cancelled";
export const isUserPaused = (action: WorkflowAction): boolean => action.kind === "execute" && action.pauseReason === "user";
/** The pending state of whichever process this action runs. */
export const actionNote = (action: WorkflowAction): string =>
  action.kind === "integration" ? action.message : renderExecutionNotices(action.notices);

export const zInboxItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), workspaceId: z.string(), card: zDecisionCard }),
  z.object({ kind: z.literal("integration"), workspaceId: z.string(), workItem: zWorkItem, action: zIntegration }),
  z.object({ kind: z.literal("merged"), workspaceId: z.string(), workItem: zWorkItem })
]);
export type InboxItem = z.infer<typeof zInboxItem>;

export const zWorktreeCleanup = z.object({
  sessionId: z.string().optional(),
  worktreePath: z.string(),
  branch: z.string(),
  discard: z.boolean(),
  detachedAt: z.string().optional()
});
export type WorktreeCleanup = z.infer<typeof zWorktreeCleanup>;

/** Contract and business state stay distinct from the process, but commit atomically. */
export const zWorkItemRecord = z.object({
  workItemId: z.string(),
  item: zWorkItem.omit({ run: true }),
  execution: zExecution,
  integrations: z.array(zIntegration),
  cleanup: z.array(zWorktreeCleanup).default([])
});
export type WorkItemRecord = z.infer<typeof zWorkItemRecord>;

export const projectWorkItem = ({ item, execution }: WorkItemRecord): WorkItem => ({
  ...item,
  run: zRun.parse({ ...execution, lastFailure: execution.failure, resumeMessage: renderExecutionNotices(execution.notices) || undefined })
});

export const zSessionNavigation = z.object({
  navigationId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  targetSessionId: z.string().min(1),
  targetWorkspaceId: z.string().min(1),
  title: z.string(),
  role: z.string().min(1),
  reason: z.string().optional()
});
export type SessionNavigation = z.infer<typeof zSessionNavigation>;

/** Change notifications emitted by the workbench service after every write, and by the docs watcher. */
export const zWorkbenchEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspaces.changed") }),
  z.object({ type: z.literal("sessionNavigation.changed"), sessionId: z.string(), workspaceId: z.string() }),
  z.object({ type: z.literal("docs.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("workRequests.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("workItems.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("decisions.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("issues.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("domains.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("roles.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("scheduler.changed"), workspaceId: z.string() }),
  /** A running work item gained pending notices; the orchestrator hands them to its worker right away. */
  z.object({ type: z.literal("workItem.updated"), workspaceId: z.string(), workItemId: z.string(), sessionId: z.string() }),
  /** A work item was cancelled. sessionId when a worker held it (interrupted); dependants are queued items that listed it in dependsOn. */
  z.object({ type: z.literal("workItem.cancelled"), workspaceId: z.string(), workItemId: z.string(), sessionId: z.string().optional(), dependants: z.array(z.string()) }),
  /** A preparation request was cancelled; sessionId identifies its preparation branch when one exists. */
  z.object({ type: z.literal("workRequest.cancelled"), workspaceId: z.string(), requestId: z.string(), sessionId: z.string().optional() }),
  z.object({ type: z.literal("runs.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("actions.changed"), workspaceId: z.string() }),
  /** Streaming search results for the query started by `search.start`. */
  z.object({ type: z.literal("search.hits"), queryId: z.string(), hits: z.array(zSearchHit) }),
  /** The scan for `queryId` finished; a cancelled or superseded query never reports completion. */
  z.object({ type: z.literal("search.completed"), queryId: z.string(), stats: zSearchStats, error: z.string().optional() })
]);
export type WorkbenchEvent = z.infer<typeof zWorkbenchEvent>;
