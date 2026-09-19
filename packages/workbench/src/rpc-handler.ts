import { workbenchRpc, type WorkbenchRpcMethod, type WorkbenchRpcParams, type WorkbenchRpcRequest, type WorkbenchRpcResponse, type WorkbenchRpcResult } from "./rpc.js";
import type { WorkbenchService } from "./workbench-service.js";
import { parseRoleDocument, serializeRoleDocument } from "./role-document.js";

type Handlers = { [M in WorkbenchRpcMethod]: (params: WorkbenchRpcParams<M>) => Promise<WorkbenchRpcResult<M>> };

export const createWorkbenchRpcHandler = (service: WorkbenchService) => {
  const handlers: Handlers = {
    "sessionNavigation.create": (p) => service.createSessionNavigation(p),
    "sessionNavigation.list": (p) => service.listSessionNavigations(p),
    "asksource": (p) => service.askSource(p.workspaceId, p.workItemId, p.sessionId, p.question),
    "steer": (p) => service.steerSession(p.sessionId, p.content),
    "workspace.list": () => service.listWorkspaces(),
    "workspace.add": (p) => service.addWorkspace(p),
    "workspace.remove": async (p) => { await service.removeWorkspace(p.workspaceId); return {}; },
    "workspace.directories": (p) => service.listWorkspaceDirectories(p.workspaceId),

    "docs.list": (p) => service.listDocs(p.workspaceId, p.sessionId),
    "docs.read": async (p) => ({ content: await service.readDoc(p.workspaceId, p.path, p.commit, p.sessionId) }),
    "docs.write": async (p) => { await service.writeDoc(p.workspaceId, p.path, p.content, p.sessionId); return {}; },
    "docs.pending": (p) => service.pendingDocChanges(p.workspaceId, p.sessionId),
    "docs.discardPreview": (p) => service.previewDocDiscard(p.workspaceId, p.paths, p.sessionId),
    "docs.discard": (p) => service.discardDocs(p.workspaceId, p.paths, p.sessionId),
    "docs.diff": async (p) => ({ diff: await service.docDiff(p.workspaceId, p.path, p.sessionId) }),
    "docs.rebase": (p) => service.rebaseDocDraft(p.workspaceId, p.sessionId),
    "docs.commit": (p) => service.commitDocs(p.workspaceId, p),
    "search.query": (p) => service.search(p),
    "search.start": async (p) => service.startSearch(p),
    "search.cancel": async (p) => service.cancelSearch(p.queryId),

    "role.list": (p) => service.listRoles(p.workspaceId),
    "role.read": (p) => service.readRole(p.workspaceId, p.roleId),
    "role.editor.read": async (p) => {
      const { content, source, globalContent } = await service.readRoleEditor(p.workspaceId, p.roleId);
      const document = parseRoleDocument(content);
      const globalDocument = globalContent === undefined ? undefined : { ...parseRoleDocument(globalContent), mode: "global" as const };
      return {
        document: { ...document, mode: source === "global" ? "global" as const : document.mode },
        source,
        ...(globalDocument ? { globalDocument } : {})
      };
    },
    "role.editor.write": async (p) => {
      if (p.document.mode === "global") await service.resetRoleOverride(p.workspaceId, p.roleId);
      else await service.writeRoleOverride(p.workspaceId, p.roleId, serializeRoleDocument(p.document));
      return {};
    },
    "role.resolve": (p) => service.resolveRole(p.workspaceId, p.roleId),
    "role.write": async (p) => { await service.writeRoleOverride(p.workspaceId, p.roleId, p.content); return {}; },
    "role.reset": async (p) => { await service.resetRoleOverride(p.workspaceId, p.roleId); return {}; },

    "issue.list": (p) => service.listIssues(p.workspaceId, { domainId: p.domainId, status: p.status }),
    "issue.get": (p) => service.getIssue(p.workspaceId, p.issueId),
    "issue.create": ({ workspaceId, ...p }) => service.createIssue(workspaceId, p),
    "issue.update": ({ workspaceId, issueId, ...p }) => service.updateIssue(workspaceId, issueId, p),
    "issue.read": (p) => service.readIssue(p.workspaceId, p.issueId),
    "issue.discuss": (p) => service.discussIssue(p.workspaceId, p.issueId),

    "domain.list": (p) => service.listDomains(p.workspaceId),
    "domain.config.get": (p) => service.getDomainConfig(p.workspaceId, p.domainId),
    "domain.config.set": (p) => service.setDomainConfig(p.workspaceId, p.domainId, p.value),
    "domain.instruction.read": async (p) => ({ content: await service.readMaintainerInstruction(p.workspaceId, p.domainId) }),
    "domain.instruction.write": async (p) => { await service.writeMaintainerInstruction(p.workspaceId, p.domainId, p.content); return {}; },
    "domain.remove": async (p) => { await service.removeDomain(p.workspaceId, p.domainId); return {}; },
    "domain.patrol.list": async (p) => (await service.listPatrolRuns(p.workspaceId)).filter((run) => !p.domainId || run.domainId === p.domainId),
    "domain.patrol.get": (p) => service.getPatrolRun(p.workspaceId, p.patrolRunId),
    "domain.patrol.run": (p) => service.queuePatrol(p.workspaceId, p.domainId),
    "domain.patrol.scan": (p) => service.scanPatrols(p.workspaceId),
    "domain.patrol.complete": (p) => service.completePatrolRun(p.workspaceId, p.patrolRunId, p.sessionId, p.issueIds, p.summary),
    "domain.issue.workItem.create": ({ workspaceId, ...p }) => service.createAuthorizedIssueWorkItem(workspaceId, p),


    "work.start": (p) => service.startWork(p.workspaceId, p),
    "work.list": (p) => service.listWorkRequests(p.workspaceId),
    "work.retry": (p) => service.retryWork(p.workspaceId, p.requestId),
    "work.cancel": (p) => service.cancelWorkRequest(p.workspaceId, p),
    "workItem.list": (p) => service.listWorkItems(p.workspaceId),
    "workItem.get": (p) => service.getWorkItem(p.workspaceId, p.workItemId),
    "workItem.diagnose": (p) => service.diagnoseWorkItem(p.workspaceId, p.workItemId),
    "runtime.info": () => service.getRuntimeInfo(),
    "workItem.create": (p) => service.createWorkItem(p.workspaceId, p),
    "workItem.start": (p) => service.startWorkItem(p.workspaceId, p.workItemId, p.run),
    "workItem.heartbeat": (p) => service.heartbeatWorkItem(p.workspaceId, p.workItemId, p.lastTurnId),
    "workItem.submit": (p) => service.submitWorkItem(p.workspaceId, p.workItemId, p),
    "inbox.acknowledge": (p) => service.acknowledgeWorkItem(p.workspaceId, p.workItemId),
    "worktree.list": (p) => service.listWorktreeCleanup(p.workspaceId),
    "worktree.cleanup": (p) => service.cleanupWorktrees(p.workspaceId),
    "workItem.rollback": (p) => service.rollbackWorkItem(p.workspaceId, p.workItemId, p.reason),
    "workItem.cancel": (p) => service.cancelWorkItem(p.workspaceId, p.workItemId),
    "workItem.pause": (p) => service.pauseWorkItem(p.workspaceId, p.sessionId),
    "workItem.resume": (p) => service.resumeWorkItem(p.workspaceId, p.workItemId),
    "workItem.integration.retry": (p) => service.retryIntegration(p.workspaceId, p.workItemId),
    "workItem.integration.takeover": (p) => service.takeoverIntegration(p.workspaceId, p.workItemId, p.note),
    "workItem.integration.complete": (p) => service.completeIntegration(p.workspaceId, p.workItemId, p.actionId, p.sessionId),
    "action.list": (p) => service.listActions(p.workspaceId),
    "workItem.update": ({ workspaceId, workItemId, ...changes }) => service.updateWorkItem(workspaceId, workItemId, changes),

    "scheduler.get": (p) => service.getScheduler(p.workspaceId),
    "scheduler.set": (p) => service.setScheduler(p.workspaceId, p.value),
    "run.list": (p) => service.listRuns(p.workspaceId),

    "decision.list": (p) => service.listDecisions(p.workspaceId),
    "decision.create": (p) => service.createDecision(p.workspaceId, p),
    "decision.answer": (p) => service.answerDecision(p.workspaceId, p.decisionId, { key: p.key, note: p.note }),
    "inbox.list": (p) => service.listInbox(p.includeProcessed),

    "app.start": (p) => service.startApp(p),
    "app.stop": async (p) => { await service.stopApp(p.pid); return {}; },
    "app.window": (p) => service.controlAppWindow(p),

  };

  return async (raw: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> => {
    const spec = workbenchRpc[raw.method as WorkbenchRpcMethod];
    if (!spec) return { ok: false, error: "Unknown workbench method: " + raw.method };
    try {
      const params = spec.params.parse(raw.params);
      const handler = handlers[raw.method as WorkbenchRpcMethod] as (p: unknown) => Promise<unknown>;
      return { ok: true, result: spec.result.parse(await handler(params)) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const params = raw.params as Record<string, unknown> | undefined;
      const next = params?.workItemId ? "先调用 workItem.diagnose 查询等待原因与可用动作。" : params?.actionId ? "先调用 action.list 核对处理者、会话与当前动作。" : params?.decisionId ? "先调用 decision.list 核对是否已答复或撤回以及发起会话。" : "核对参数和对象的当前状态。";
      return { ok: false, error: `${reason}\n下一步：${next} 参数与适用状态：vermillion ${raw.method} --help` };
    }
  };
};
