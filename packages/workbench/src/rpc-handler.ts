import { workbenchRpc, type WorkbenchRpcMethod, type WorkbenchRpcParams, type WorkbenchRpcRequest, type WorkbenchRpcResponse, type WorkbenchRpcResult } from "./rpc.js";
import type { WorkbenchService } from "./workbench-service.js";
import { parseRoleDocument, serializeRoleDocument } from "./role-document.js";

type Handlers = { [M in WorkbenchRpcMethod]: (params: WorkbenchRpcParams<M>) => Promise<WorkbenchRpcResult<M>> };

export const createWorkbenchRpcHandler = (service: WorkbenchService) => {
  const handlers: Handlers = {
    "workspace.list": () => service.listWorkspaces(),
    "workspace.add": (p) => service.addWorkspace(p),
    "workspace.remove": async (p) => { await service.removeWorkspace(p.workspaceId); return {}; },

    "docs.list": (p) => service.listDocs(p.workspaceId),
    "docs.read": async (p) => ({ content: await service.readDoc(p.workspaceId, p.path, p.commit) }),
    "docs.write": async (p) => { await service.writeDoc(p.workspaceId, p.path, p.content); return {}; },
    "docs.pending": (p) => service.pendingDocChanges(p.workspaceId),
    "docs.diff": async (p) => ({ diff: await service.docDiff(p.workspaceId, p.path) }),
    "docs.commit": (p) => service.commitDocs(p.workspaceId, p),

    "role.list": (p) => service.listRoles(p.workspaceId),
    "role.read": (p) => service.readRole(p.workspaceId, p.roleId),
    "role.editor.read": async (p) => {
      const { content, source } = await service.readRole(p.workspaceId, p.roleId);
      return { document: parseRoleDocument(content), source };
    },
    "role.editor.write": async (p) => {
      await service.writeRoleOverride(p.workspaceId, p.roleId, serializeRoleDocument(p.document));
      return {};
    },
    "role.resolve": (p) => service.resolveRole(p.workspaceId, p.roleId),
    "role.write": async (p) => { await service.writeRoleOverride(p.workspaceId, p.roleId, p.content); return {}; },
    "role.reset": async (p) => { await service.resetRoleOverride(p.workspaceId, p.roleId); return {}; },

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
    "inbox.acknowledge": (p) => service.acknowledgeWorkItem(p.workspaceId, p.workItemId),
    "workItem.rollback": (p) => service.rollbackWorkItem(p.workspaceId, p.workItemId, p.reason),
    "workItem.cancel": (p) => service.cancelWorkItem(p.workspaceId, p.workItemId),
    "workItem.defer": (p) => service.deferWorkItem(p.workspaceId, p.workItemId, p.dependsOn, p.note),
    "workItem.escalate": (p) => service.escalateWorkItem(p.workspaceId, p.workItemId, p.message),
    "workItem.update": ({ workspaceId, workItemId, ...changes }) => service.updateWorkItem(workspaceId, workItemId, changes),

    "scheduler.get": (p) => service.getScheduler(p.workspaceId),
    "scheduler.set": (p) => service.setScheduler(p.workspaceId, p.value),
    "run.list": (p) => service.listRuns(p.workspaceId),

    "decision.list": (p) => service.listDecisions(p.workspaceId),
    "decision.create": (p) => service.createDecision(p.workspaceId, p),
    "decision.answer": (p) => service.answerDecision(p.workspaceId, p.decisionId, { key: p.key, note: p.note }),

    "inbox.list": () => service.listInbox(),

    "app.start": (p) => service.startApp(p),
    "app.stop": async (p) => { await service.stopApp(p.pid); return {}; },

    "session.ask": async (p) => ({ answer: await service.askMissionAuthor(p.workspaceId, p.missionId, p.question) })
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
