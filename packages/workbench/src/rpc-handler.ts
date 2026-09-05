import { workbenchRpc, type WorkbenchRpcMethod, type WorkbenchRpcParams, type WorkbenchRpcRequest, type WorkbenchRpcResponse, type WorkbenchRpcResult } from "./rpc.js";
import type { WorkbenchService } from "./workbench-service.js";

type Handlers = { [M in WorkbenchRpcMethod]: (params: WorkbenchRpcParams<M>) => Promise<WorkbenchRpcResult<M>> };

export const createWorkbenchRpcHandler = (service: WorkbenchService) => {
  const handlers: Handlers = {
    "workspace.list": () => service.listWorkspaces(),
    "workspace.add": (p) => service.addWorkspace(p),
    "workspace.remove": async (p) => { await service.removeWorkspace(p.workspaceId); return {}; },

    "docs.list": (p) => service.listDocs(p.workspaceId),
    "docs.read": async (p) => ({ content: await service.readDoc(p.workspaceId, p.path) }),
    "docs.write": async (p) => { await service.writeDoc(p.workspaceId, p.path, p.content); return {}; },
    "docs.pending": (p) => service.pendingDocChanges(p.workspaceId),
    "docs.diff": async (p) => ({ diff: await service.docDiff(p.workspaceId, p.path) }),

    "mission.list": (p) => service.listMissions(p.workspaceId),
    "mission.create": (p) => service.createMission(p.workspaceId, p),
    "mission.addRevision": (p) => service.addMissionRevision(p.workspaceId, p),
    "mission.setStatus": (p) => service.setMissionStatus(p.workspaceId, p.missionId, p.status),

    "workItem.list": (p) => service.listWorkItems(p.workspaceId, p.missionId),
    "workItem.get": (p) => service.getWorkItem(p.workspaceId, p.workItemId),
    "workItem.create": (p) => service.createWorkItem(p.workspaceId, p),
    "workItem.start": (p) => service.startWorkItem(p.workspaceId, p.workItemId, p.run),
    "workItem.heartbeat": (p) => service.heartbeatWorkItem(p.workspaceId, p.workItemId, p.lastTurnId),
    "workItem.submit": (p) => service.submitWorkItem(p.workspaceId, p.workItemId, p),
    "workItem.approve": (p) => service.approveWorkItem(p.workspaceId, p.workItemId),
    "workItem.reject": (p) => service.rejectWorkItem(p.workspaceId, p.workItemId, p.reason),
    "workItem.cancel": (p) => service.cancelWorkItem(p.workspaceId, p.workItemId),

    "decision.list": (p) => service.listDecisions(p.workspaceId),
    "decision.create": (p) => service.createDecision(p.workspaceId, p),
    "decision.answer": (p) => service.answerDecision(p.workspaceId, p.decisionId, { key: p.key, note: p.note }),

    "inbox.list": () => service.listInbox()
  };

  return async (raw: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> => {
    const spec = workbenchRpc[raw.method as WorkbenchRpcMethod];
    if (!spec) return { ok: false, error: "Unknown workbench method: " + raw.method };
    try {
      const params = spec.params.parse(raw.params);
      const handler = handlers[raw.method as WorkbenchRpcMethod] as (p: unknown) => Promise<unknown>;
      return { ok: true, result: spec.result.parse(await handler(params)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
};
