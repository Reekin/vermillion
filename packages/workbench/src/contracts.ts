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

export const zMission = z.object({
  missionId: z.string().min(1),
  title: z.string().min(1),
  status: zMissionStatus,
  summary: z.string(),
  docCommit: z.string(),
  sessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Mission = z.infer<typeof zMission>;

export const workItemStatuses = ["queued", "running", "review", "closed"] as const;
export const zWorkItemStatus = z.enum(workItemStatuses);
export type WorkItemStatus = z.infer<typeof zWorkItemStatus>;

export const zWorkItem = z.object({
  workItemId: z.string().min(1),
  missionId: z.string().min(1),
  title: z.string().min(1),
  status: zWorkItemStatus,
  risk: z.enum(["R0", "R1", "R2", "R3"]),
  autoClose: z.boolean(),
  sessionId: z.string().optional(),
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

export const issueStatuses = ["open", "adopted", "closed", "duplicate"] as const;
export const zIssue = z.object({
  issueId: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  status: z.enum(issueStatuses),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Issue = z.infer<typeof zIssue>;

export const zDocFile = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string()
});
export type DocFile = z.infer<typeof zDocFile>;

export const zDocChange = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"]),
  diff: z.string()
});
export type DocChange = z.infer<typeof zDocChange>;

export const zInboxItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), workspaceId: z.string(), card: zDecisionCard }),
  z.object({ kind: z.literal("review"), workspaceId: z.string(), workItem: zWorkItem, mission: zMission })
]);
export type InboxItem = z.infer<typeof zInboxItem>;
