import { z } from "zod";

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

export const zDocRef = z.object({
  path: z.string().min(1),
  section: z.string().optional(),
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

export const zVerifyResult = z.object({
  items: z.array(z.object({ index: z.number().int().nonnegative(), pass: z.boolean(), evidence: z.string() })),
  verdict: z.enum(["pass", "rework"]),
  verifiedAt: z.string()
});

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
  /** Set when a contract change was steered into a turn already in progress; a submit from that same turn is void. Cleared when the turn ends. */
  staleTurnId: z.string().optional()
});

export const zWorkItem = z.object({
  workItemId: z.string().min(1),
  /** Origin of the execution branch; absent for manually created work. */
  sourceSessionId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  treeId: z.string().optional(),
  requestId: z.string().optional(),
  verificationFailures: z.number().int().nonnegative().optional(),
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
  status: z.enum(["pending", "preparing", "ready", "failed"]),
  attempts: z.number().int().nonnegative().optional(), retryAt: z.string().optional(),
  failure: z.string().optional(), createdAt: z.string(), updatedAt: z.string()
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

export const zInboxItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), workspaceId: z.string(), card: zDecisionCard }),
  z.object({ kind: z.literal("merged"), workspaceId: z.string(), workItem: zWorkItem })
]);
export type InboxItem = z.infer<typeof zInboxItem>;

/** Per-workspace execution scheduler settings. */
export const zScheduler = z.object({
  enabled: z.boolean(),
  maxWorkers: z.number().int().min(1).max(8)
});
export type Scheduler = z.infer<typeof zScheduler>;

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
  message: z.string(),
  attempts: z.number().int().nonnegative(),
  retryAt: z.string().optional(),
  failure: z.string().optional(),
  history: z.array(z.object({ at: z.string(), event: z.string(), message: z.string(), decisionId: z.string().optional() })),
  createdAt: z.string(),
  updatedAt: z.string()
});

/** The sole owner of a worker's runtime state and pending delivery. */
export const zExecution = zProcess.extend({
  ...zRun.omit({ resumeMessage: true, lastFailure: true, attempts: true, retryAt: true }).shape,
  kind: z.literal("execute"),
  stage: z.enum(["open", "deliver", "execute"]),
  runId: z.string().optional(),
  deliveredAt: z.string().optional(),
  idleTurns: z.number().int().nonnegative()
});
export type Execution = z.infer<typeof zExecution>;

/** One item's serialized Git operation. */
export const zIntegration = zProcess.extend({
  kind: z.literal("integration"),
  stage: z.enum(["merge", "rollback"]),
  integration: z.object({
    operation: z.enum(["merge", "rollback"]),
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
  run: zRun.parse({ ...execution, lastFailure: execution.failure, resumeMessage: execution.message || undefined })
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
  z.object({ type: z.literal("roles.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("scheduler.changed"), workspaceId: z.string() }),
  /** A running work item's contract changed; the orchestrator steers its worker right away. */
  z.object({ type: z.literal("workItem.updated"), workspaceId: z.string(), workItemId: z.string(), sessionId: z.string(), note: z.string() }),
  /** A work item was cancelled. sessionId when a worker held it (interrupted); dependants are queued items that listed it in dependsOn. */
  z.object({ type: z.literal("workItem.cancelled"), workspaceId: z.string(), workItemId: z.string(), sessionId: z.string().optional(), dependants: z.array(z.string()) }),
  z.object({ type: z.literal("runs.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("actions.changed"), workspaceId: z.string() })
]);
export type WorkbenchEvent = z.infer<typeof zWorkbenchEvent>;
