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
import type { WorkbenchService } from "./workbench-service.js";

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

export const createWorkbenchRpcHandler = (service: WorkbenchService) => {
  const handlers: { [M in WorkbenchRpcMethod]: (params: WorkbenchRpcParams<M>) => Promise<WorkbenchRpcResult<M>> } = {
    "workspace.list": () => service.listWorkspaces(),
    "workspace.add": (p) => service.addWorkspace(p),
    "workspace.remove": async (p) => { await service.removeWorkspace(p.workspaceId); return {}; },
    "docs.list": (p) => service.listDocs(p.workspaceId),
    "docs.read": async (p) => ({ content: await service.readDoc(p.workspaceId, p.path) }),
    "docs.write": async (p) => { await service.writeDoc(p.workspaceId, p.path, p.content); return {}; },
    "docs.pending": (p) => service.pendingDocChanges(p.workspaceId),
    "docs.commit": async (p) => ({ commit: await service.commitDocs(p.workspaceId, p.message) }),
    "mission.list": (p) => service.listMissions(p.workspaceId),
    "mission.create": (p) => service.createMission(p.workspaceId, p),
    "mission.setStatus": (p) => service.updateMissionStatus(p.workspaceId, p.missionId, p.status),
    "workItem.list": (p) => service.listWorkItems(p.workspaceId, p.missionId),
    "workItem.update": (p) => service.updateWorkItem(p.workspaceId, p.workItemId, { status: p.status, sessionId: p.sessionId }),
    "decision.answer": (p) => service.answerDecision(p.workspaceId, p.decisionId, { key: p.key, note: p.note }),
    "inbox.list": () => service.listInbox()
  };

  return async (raw: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> => {
    const spec = workbenchRpc[raw.method as WorkbenchRpcMethod];
    if (!spec) return { ok: false, error: "Unknown workbench method: " + raw.method };
    try {
      const params = spec.params.parse(raw.params);
      const handler = handlers[raw.method as WorkbenchRpcMethod] as (p: unknown) => Promise<unknown>;
      const result = spec.result.parse(await handler(params));
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
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
