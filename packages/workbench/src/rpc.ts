import { z } from "zod";
import {
  zAcceptanceItem,
  zAgentRun,
  zScheduler,
  zDecisionCard,
  zDecisionOption,
  zDocChange,
  zDocFile,
  zDocRef,
  zEvidence,
  zInboxItem,
  zMission,
  zMissionStatus,
  zReviewDisposition,
  zRisk,
  zRoleFile,
  zRun,
  zScope,
  zVerifyResult,
  zWorkItem,
  zWorkbenchEvent,
  zWorkspace,
  type WorkbenchEvent
} from "./contracts.js";

const zWs = z.object({ workspaceId: z.string().min(1) });
const zWi = zWs.extend({ workItemId: z.string().min(1) });
const zEmpty = z.object({});

/** Single method registry: name -> params/result schemas. Handler and client are both derived from it. */
export const workbenchRpc = {
  "workspace.list": { params: zEmpty, result: z.array(zWorkspace) },
  "workspace.add": { params: z.object({ rootPath: z.string().min(1), label: z.string().optional() }), result: zWorkspace },
  "workspace.remove": { params: zWs, result: zEmpty },

  "docs.list": { params: zWs, result: z.array(zDocFile) },
  "docs.read": { params: zWs.extend({ path: z.string().min(1) }), result: z.object({ content: z.string() }) },
  "docs.write": { params: zWs.extend({ path: z.string().min(1), content: z.string() }), result: zEmpty },
  "docs.pending": { params: zWs, result: z.array(zDocChange) },
  "docs.diff": { params: zWs.extend({ path: z.string().min(1) }), result: z.object({ diff: z.string() }) },

  "role.list": { params: zWs, result: z.array(zRoleFile) },
  "role.read": { params: zWs.extend({ roleId: z.string().min(1) }), result: z.object({ content: z.string(), source: zRoleFile.shape.source }) },
  "role.write": { params: zWs.extend({ roleId: z.string().min(1), content: z.string() }), result: zEmpty },
  "role.reset": { params: zWs.extend({ roleId: z.string().min(1) }), result: zEmpty },

  "mission.list": { params: zWs, result: z.array(zMission) },
  "mission.create": {
    params: zWs.extend({ title: z.string().min(1), summary: z.string(), sessionId: z.string().optional(), paths: z.array(z.string()).optional() }),
    result: zMission
  },
  "mission.addRevision": {
    params: zWs.extend({ missionId: z.string().min(1), message: z.string(), sessionId: z.string().optional(), paths: z.array(z.string()).optional() }),
    result: zMission
  },
  "mission.setStatus": { params: zWs.extend({ missionId: z.string().min(1), status: zMissionStatus }), result: zMission },

  "workItem.list": { params: zWs.extend({ missionId: z.string().optional() }), result: z.array(zWorkItem) },
  "workItem.get": { params: zWi, result: zWorkItem },
  "workItem.create": {
    params: zWs.extend({
      missionId: z.string().min(1).optional(),
      title: z.string().min(1),
      objective: z.string(),
      risk: zRisk,
      refs: z.array(zDocRef).optional(),
      scope: zScope,
      acceptance: z.array(zAcceptanceItem),
      needs: z.array(z.string()).optional(),
      autoClose: z.boolean().optional()
    }),
    result: zWorkItem
  },
  "workItem.start": { params: zWi.extend({ run: zRun }), result: zWorkItem },
  "workItem.heartbeat": { params: zWi.extend({ lastTurnId: z.string().optional() }), result: zWorkItem },
  "workItem.submit": {
    params: zWi.extend({ evidence: zEvidence.omit({ submittedAt: true }), review: z.array(zReviewDisposition), verify: zVerifyResult.omit({ verifiedAt: true }) }),
    result: zWorkItem
  },
  "workItem.approve": { params: zWi, result: zWorkItem },
  "workItem.reject": { params: zWi.extend({ reason: z.string().min(1) }), result: zWorkItem },
  "workItem.cancel": { params: zWi, result: zWorkItem },
  "workItem.update": {
    params: zWi.extend({
      note: z.string().min(1),
      title: z.string().min(1).optional(),
      objective: z.string().optional(),
      risk: zRisk.optional(),
      refs: z.array(zDocRef).optional(),
      scope: zScope.optional(),
      acceptance: z.array(zAcceptanceItem).optional()
    }),
    result: zWorkItem
  },

  "scheduler.get": { params: zWs, result: zScheduler },
  "scheduler.set": { params: zWs.extend({ value: zScheduler }), result: zScheduler },
  "run.list": { params: zWs, result: z.array(zAgentRun) },

  "decision.list": { params: zWs, result: z.array(zDecisionCard) },
  "decision.create": {
    params: zWs.extend({
      question: z.string().min(1),
      context: z.string(),
      options: z.array(zDecisionOption).min(1),
      recommended: z.string().optional(),
      workItemId: z.string().optional(),
      missionId: z.string().optional(),
      sessionId: z.string().optional()
    }),
    result: zDecisionCard
  },
  "decision.answer": { params: zWs.extend({ decisionId: z.string().min(1), key: z.string().min(1), note: z.string().optional() }), result: zDecisionCard },

  "inbox.list": { params: zEmpty, result: z.array(zInboxItem) }
} as const;

export type WorkbenchRpcMethod = keyof typeof workbenchRpc;
export type WorkbenchRpcParams<M extends WorkbenchRpcMethod> = z.infer<(typeof workbenchRpc)[M]["params"]>;
export type WorkbenchRpcResult<M extends WorkbenchRpcMethod> = z.infer<(typeof workbenchRpc)[M]["result"]>;

export type WorkbenchRpcRequest = { method: string; params: unknown };
export type WorkbenchRpcResponse = { ok: true; result: unknown } | { ok: false; error: string };

export type WorkbenchClient = {
  request: <M extends WorkbenchRpcMethod>(method: M, params: WorkbenchRpcParams<M>) => Promise<WorkbenchRpcResult<M>>;
  subscribe: (listener: (event: WorkbenchEvent) => void) => () => void;
};

export const parseWorkbenchEvent = (value: unknown): WorkbenchEvent | undefined => {
  const parsed = zWorkbenchEvent.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const createWorkbenchClient = (transport: {
  request: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>;
  onEvent: (listener: (raw: unknown) => void) => () => void;
}): WorkbenchClient => ({
  request: async (method, params) => {
    const response = await transport.request({ method, params });
    if (!response.ok) throw new Error("[" + method + "] " + response.error);
    return workbenchRpc[method].result.parse(response.result) as never;
  },
  subscribe: (listener) =>
    transport.onEvent((raw) => {
      const event = parseWorkbenchEvent(raw);
      if (event) listener(event);
    })
});
