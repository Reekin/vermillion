import { workbenchRpc, type WorkbenchRpcMethod, type WorkbenchRpcParams, type WorkbenchRpcRequest, type WorkbenchRpcResponse, type WorkbenchRpcResult } from "./rpc.js";
import type { WorkbenchService } from "./workbench-service.js";

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
