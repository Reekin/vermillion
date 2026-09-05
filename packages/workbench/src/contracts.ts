import { z } from "zod";

export const zWorkspace = z.object({
  workspaceId: z.string().min(1),
  rootPath: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string(),
  lastActiveAt: z.string()
});
export type Workspace = z.infer<typeof zWorkspace>;

export const missionStatuses = ["active", "done", "cancelled"] as const;
export const zMissionStatus = z.enum(missionStatuses);
export type MissionStatus = z.infer<typeof zMissionStatus>;

/** One doc commit attributed to a mission. A mission is the ordered sequence of these. */
export const zMissionRevision = z.object({
  commit: z.string().min(1),
  message: z.string(),
  paths: z.array(z.string()),
  sessionId: z.string().optional(),
  at: z.string()
});
export type MissionRevision = z.infer<typeof zMissionRevision>;

export const zMission = z.object({
  missionId: z.string().min(1),
  title: z.string().min(1),
  status: zMissionStatus,
  summary: z.string(),
  /** Session the mission was first created from. */
  sessionId: z.string().optional(),
  revisions: z.array(zMissionRevision).min(1),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Mission = z.infer<typeof zMission>;

export const latestRevision = (mission: Mission): MissionRevision => mission.revisions[mission.revisions.length - 1]!;

/** queued -> running -> review -> closed; decision parks a work item until the user answers. */
export const workItemStatuses = ["queued", "running", "review", "decision", "closed"] as const;
export const zWorkItemStatus = z.enum(workItemStatuses);
export type WorkItemStatus = z.infer<typeof zWorkItemStatus>;

export const zRisk = z.enum(["R0", "R1", "R2", "R3"]);
export type Risk = z.infer<typeof zRisk>;

export const zDocRef = z.object({
  path: z.string().min(1),
  section: z.string().optional(),
  commit: z.string().min(1)
});

export const zAcceptanceItem = z.object({
  given: z.string(),
  when: z.string(),
  then: z.string()
});

export const zScope = z.object({
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  allowedPaths: z.array(z.string())
});

export const zEvidence = z.object({
  summary: z.string(),
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

export const zRun = z.object({
  sessionId: z.string().optional(),
  lastTurnId: z.string().optional(),
  heartbeatAt: z.string().optional(),
  worktreePath: z.string().optional(),
  branch: z.string().optional()
});

export const zWorkItem = z.object({
  workItemId: z.string().min(1),
  missionId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string(),
  status: zWorkItemStatus,
  risk: zRisk,
  autoClose: z.boolean(),
  needs: z.array(z.string()),
  refs: z.array(zDocRef),
  scope: zScope,
  acceptance: z.array(zAcceptanceItem),
  evidence: zEvidence.optional(),
  review: z.array(zReviewDisposition),
  verify: zVerifyResult.optional(),
  rejections: z.array(zRejection),
  decisions: z.array(z.string()),
  run: zRun,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type WorkItem = z.infer<typeof zWorkItem>;

export const zDecisionOption = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional()
});

export const zDecisionCard = z.object({
  decisionId: z.string().min(1),
  workItemId: z.string().optional(),
  missionId: z.string().optional(),
  sessionId: z.string().optional(),
  question: z.string().min(1),
  context: z.string(),
  options: z.array(zDecisionOption),
  recommended: z.string().optional(),
  answer: z.object({ key: z.string(), note: z.string().optional(), at: z.string() }).optional(),
  createdAt: z.string()
});
export type DecisionCard = z.infer<typeof zDecisionCard>;

export const zDocFile = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string()
});
export type DocFile = z.infer<typeof zDocFile>;

export const zRoleFile = z.object({
  roleId: z.string().min(1),
  title: z.string(),
  /** Which layer the effective prompt comes from. */
  source: z.enum(["global", "workspace"])
});
export type RoleFile = z.infer<typeof zRoleFile>;

export const zDocChange = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"])
});
export type DocChange = z.infer<typeof zDocChange>;

export const zInboxItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), workspaceId: z.string(), card: zDecisionCard }),
  z.object({ kind: z.literal("review"), workspaceId: z.string(), workItem: zWorkItem, mission: zMission })
]);
export type InboxItem = z.infer<typeof zInboxItem>;

/** Change notifications emitted by the workbench service after every write, and by the docs watcher. */
export const zWorkbenchEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspaces.changed") }),
  z.object({ type: z.literal("docs.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("missions.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("workItems.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("decisions.changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("roles.changed"), workspaceId: z.string() })
]);
export type WorkbenchEvent = z.infer<typeof zWorkbenchEvent>;
