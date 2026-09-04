import { z } from "zod";
import {
  zDecisionCard,
  zDocChange,
  zDocFile,
  zInboxItem,
  zMission,
  zMissionStatus,
  zWorkItem,
  zWorkItemStatus,
  zWorkspace
} from "./contracts.js";

const zWs = z.object({ workspaceId: z.string().min(1) });

export const workbenchRpc = {
  "workspace.list": { params: z.object({}), result: z.array(zWorkspace) },
  "workspace.add": { params: z.object({ rootPath: z.string().min(1), label: z.string().optional() }), result: zWorkspace },
  "workspace.remove": { params: zWs, result: z.object({}) },
  "docs.list": { params: zWs, result: z.array(zDocFile) },
  "docs.read": { params: zWs.extend({ path: z.string().min(1) }), result: z.object({ content: z.string() }) },
  "docs.write": { params: zWs.extend({ path: z.string().min(1), content: z.string() }), result: z.object({}) },
  "docs.pending": { params: zWs, result: z.array(zDocChange) },
  "docs.commit": { params: zWs.extend({ message: z.string().min(1) }), result: z.object({ commit: z.string() }) },
  "mission.list": { params: zWs, result: z.array(zMission) },
  "mission.create": {
    params: zWs.extend({ title: z.string().min(1), summary: z.string(), sessionId: z.string().optional(), commitMessage: z.string().optional() }),
    result: zMission
  },
  "mission.setStatus": { params: zWs.extend({ missionId: z.string().min(1), status: zMissionStatus }), result: zMission },
  "workItem.list": { params: zWs.extend({ missionId: z.string().optional() }), result: z.array(zWorkItem) },
  "workItem.update": {
    params: zWs.extend({ workItemId: z.string().min(1), status: zWorkItemStatus.optional(), sessionId: z.string().optional() }),
    result: zWorkItem
  },
  "decision.answer": { params: zWs.extend({ decisionId: z.string().min(1), key: z.string().min(1), note: z.string().optional() }), result: zDecisionCard },
  "inbox.list": { params: z.object({}), result: z.array(zInboxItem) }
} as const;

export type WorkbenchRpcMethod = keyof typeof workbenchRpc;
export type WorkbenchRpcParams<M extends WorkbenchRpcMethod> = z.infer<(typeof workbenchRpc)[M]["params"]>;
export type WorkbenchRpcResult<M extends WorkbenchRpcMethod> = z.infer<(typeof workbenchRpc)[M]["result"]>;

export type WorkbenchRpcRequest = { method: string; params: unknown };
export type WorkbenchRpcResponse = { ok: true; result: unknown } | { ok: false; error: string };

export type WorkbenchClient = {
  request: <M extends WorkbenchRpcMethod>(method: M, params: WorkbenchRpcParams<M>) => Promise<WorkbenchRpcResult<M>>;
};

export const createWorkbenchClient = (
  send: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>
): WorkbenchClient => ({
  request: async (method, params) => {
    const response = await send({ method, params });
    if (!response.ok) throw new Error("[" + method + "] " + response.error);
    return workbenchRpc[method].result.parse(response.result) as never;
  }
});
