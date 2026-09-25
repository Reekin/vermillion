import type { AgentRun, Execution, Integration, WorkItem } from "@vermillion/workbench/client";

const at = "2026-01-01T00:00:00.000Z";

export const workItem = (overrides: Partial<WorkItem> & Pick<WorkItem, "workItemId">): WorkItem => ({
  contractRevision: 0,
  title: overrides.workItemId,
  objective: "",
  status: "queued",
  risk: "R0",
  needs: [],
  dependsOn: [],
  refs: [],
  scope: { inScope: [], outOfScope: [], allowedPaths: [] },
  acceptance: [],
  review: [],
  rejections: [],
  decisions: [],
  run: {},
  createdAt: at,
  updatedAt: at,
  ...overrides
});

export const execution = (overrides: Partial<Execution> & Pick<Execution, "actionId" | "workItemId">): Execution => ({
  kind: "execute",
  status: "pending",
  stage: "open",
  history: [],
  notices: [],
  createdAt: at,
  updatedAt: at,
  ...overrides
});

export const integration = (overrides: Partial<Integration> & Pick<Integration, "actionId" | "workItemId">): Integration => ({
  kind: "integration",
  status: "pending",
  stage: "merge",
  message: "",
  history: [],
  integration: { operation: "merge", contractRevision: 0, diffStat: "" },
  createdAt: at,
  updatedAt: at,
  ...overrides
});

export const agentRun = (overrides: Partial<AgentRun> & Pick<AgentRun, "runId" | "sessionId">): AgentRun => ({
  role: "worker",
  status: "running",
  turns: 1,
  startedAt: at,
  ...overrides
});
