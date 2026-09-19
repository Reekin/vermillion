import { z } from "zod";
import { zDiagnosis } from "./diagnosis.js";
import { zRoleDocument } from "./role-document.js";
import {
  zAcceptanceItem,
  zAgentRun,
  zWorkflowAction,
  zScheduler,
  zDecisionCard,
  zDecisionOption,
  zDocChange,
  zDocCommit,
  zDocFile,
  zDocRef,
  zDomainConfig,
  zDomainDefinition,
  zEvidence,
  zInboxItem,
  zIssue,
  zIssueEvidence,
  zIssueSource,
  zIssueStatus,
  zIssueType,
  zPatrolRun,
  zWorkRequest,
  zWorkDiagnosis,
  zWorkMessage,
  zReviewDisposition,
  zRisk,
  zRoleFile,
  zResolvedRole,
  zScope,
  zVerifySubmission,
  zWorkItem,
  zWorktreeCleanup,
  zWorkbenchEvent,
  zWorkspace,
  zSessionNavigation,
  type WorkbenchEvent
} from "./contracts.js";
import { zSearchCancel, zSearchCancelResult, zSearchQuery, zSearchResult, zSearchStartResult } from "./search-contract.js";
export type { SearchHit, SearchQuery, SearchResult } from "./search-contract.js";

const zWs = z.object({ workspaceId: z.string().min(1) });
const zWi = zWs.extend({ workItemId: z.string().min(1) });
const zEmpty = z.object({});

/** A document call inside a session edits that conversation tree's draft; without a session it edits the main branch. */
const zDocsScope = zWs.extend({ sessionId: z.string().min(1).optional() });

/** Single method registry: name -> params/result schemas. Handler and client are both derived from it. */
export const workbenchRpc = {
  "worktree.list": { params: zWs, result: z.array(zWorktreeCleanup.extend({ workItemId: z.string() })) },
  "worktree.cleanup": { params: zWs, result: z.object({ removed: z.array(z.string()), retained: z.array(z.object({ workItemId: z.string().optional(), worktreePath: z.string(), reason: z.string() })) }) },
  "sessionNavigation.create": {
    params: z.object({ sessionId: z.string().min(1), targetSessionId: z.string().min(1), reason: z.string().trim().optional() }),
    result: zSessionNavigation
  },
  "sessionNavigation.list": {
    params: z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) }),
    result: z.array(zSessionNavigation)
  },
  "asksource": {
    params: z.object({
      workspaceId: z.string().min(1),
      workItemId: z.string().min(1),
      sessionId: z.string().min(1),
      question: z.string().trim().min(1)
    }),
    result: z.object({
      answer: z.string(),
      askSessionId: z.string().min(1),
      askTurnId: z.string().min(1),
      archived: z.boolean(),
      archiveError: z.string().optional()
    })
  },
  "steer": {
    params: z.object({ sessionId: z.string().min(1), content: z.string().trim().min(1) }),
    result: z.object({
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      delivery: z.enum(["steered", "started"])
    })
  },
  "workspace.list": { params: zEmpty, result: z.array(zWorkspace) },
  "workspace.add": { params: z.object({ rootPath: z.string().min(1), label: z.string().optional() }), result: zWorkspace },
  "workspace.remove": { params: zWs, result: zEmpty },
  "workspace.directories": { params: zWs, result: z.array(z.string().min(1)) },

  "docs.list": { params: zDocsScope, result: z.array(zDocFile) },
  "docs.read": { params: zDocsScope.extend({ path: z.string().min(1), commit: z.string().min(1).optional() }), result: z.object({ content: z.string() }) },
  "docs.write": { params: zDocsScope.extend({ path: z.string().min(1), content: z.string() }), result: zEmpty },
  "docs.pending": { params: zDocsScope, result: z.array(zDocChange) },
  "docs.discardPreview": { params: zDocsScope.extend({ paths: z.array(z.string().min(1)).min(1) }), result: z.array(zDocChange) },
  "docs.discard": { params: zDocsScope.extend({ paths: z.array(z.string().min(1)).min(1) }), result: z.array(zDocChange) },
  "docs.diff": { params: zDocsScope.extend({ path: z.string().min(1) }), result: z.object({ diff: z.string() }) },
  "docs.rebase": { params: zWs.extend({ sessionId: z.string().min(1) }), result: z.object({ files: z.array(z.string()) }) },
  "docs.commit": {
    params: zWs.extend({ message: z.string().trim().min(1), paths: z.array(z.string()).min(1).optional(), sessionId: z.string().min(1).optional() }),
    result: zDocCommit
  },
  "search.query": { params: zSearchQuery, result: zSearchResult },
  "search.start": { params: zSearchQuery, result: zSearchStartResult },
  "search.cancel": { params: zSearchCancel, result: zSearchCancelResult },

  "role.list": { params: zWs, result: z.array(zRoleFile) },
  "role.read": { params: zWs.extend({ roleId: z.string().min(1) }), result: z.object({ content: z.string(), source: zRoleFile.shape.source }) },
  "role.editor.read": { params: zWs.extend({ roleId: z.string().min(1) }), result: z.object({ document: zRoleDocument, source: zRoleFile.shape.source, globalDocument: zRoleDocument.optional() }) },
  "role.editor.write": { params: zWs.extend({ roleId: z.string().min(1), document: zRoleDocument }), result: zEmpty },
  "role.resolve": { params: zWs.extend({ roleId: z.string().min(1) }), result: zResolvedRole },
  "role.write": { params: zWs.extend({ roleId: z.string().min(1), content: z.string() }), result: zEmpty },
  "role.reset": { params: zWs.extend({ roleId: z.string().min(1) }), result: zEmpty },

  "issue.list": { params: zWs.extend({ domainId: z.string().min(1).optional(), status: zIssueStatus.optional() }), result: z.array(zIssue) },
  "issue.get": { params: zWs.extend({ issueId: z.string().min(1) }), result: zIssue },
  "issue.create": {
    params: zWs.extend({
      title: z.string().trim().min(1), summary: z.string(), domainId: z.string().trim().min(1),
      source: zIssueSource.optional(), type: zIssueType.optional(), status: zIssueStatus.optional(),
      requirement: zIssue.shape.requirement, evidence: z.array(zIssueEvidence).optional(), suggestion: z.string().optional(),
      decisionQuestion: z.string().trim().min(1).optional(), patrolRunId: z.string().min(1).optional()
    }),
    result: zIssue
  },
  "issue.update": {
    params: zWs.extend({
      issueId: z.string().min(1), title: z.string().trim().min(1).optional(), summary: z.string().optional(), domainId: z.string().trim().min(1).optional(),
      type: zIssueType.optional(), status: zIssueStatus.optional(), requirement: zIssue.shape.requirement,
      suggestion: z.string().optional(), decisionQuestion: z.string().trim().min(1).optional(),
      resolutionReason: z.string().trim().min(1).optional(), duplicateOf: z.string().min(1).optional(),
      appendEvidence: z.array(zIssueEvidence).optional(), unread: z.boolean().optional(), patrolRunId: z.string().min(1).optional()
    }), result: zIssue
  },
  "issue.read": { params: zWs.extend({ issueId: z.string().min(1) }), result: zIssue },
  "issue.discuss": { params: zWs.extend({ issueId: z.string().min(1) }), result: zIssue },

  "domain.list": { params: zWs, result: z.array(zDomainDefinition) },
  "domain.config.get": { params: zWs.extend({ domainId: z.string().min(1) }), result: zDomainConfig },
  "domain.config.set": { params: zWs.extend({ domainId: z.string().min(1), value: zDomainConfig.pick({
    enabled: true, changeTrigger: true, intervalHours: true, triggerPaths: true, autoWorkEnabled: true, authorizationScope: true
  }) }), result: zDomainConfig },
  "domain.instruction.read": { params: zWs.extend({ domainId: z.string().min(1) }), result: z.object({ content: z.string() }) },
  "domain.instruction.write": { params: zWs.extend({ domainId: z.string().min(1), content: z.string() }), result: zEmpty },
  "domain.remove": { params: zWs.extend({ domainId: z.string().min(1) }), result: zEmpty },
  "domain.patrol.list": { params: zWs.extend({ domainId: z.string().min(1).optional() }), result: z.array(zPatrolRun) },
  "domain.patrol.get": { params: zWs.extend({ patrolRunId: z.string().min(1) }), result: zPatrolRun },
  "domain.patrol.run": { params: zWs.extend({ domainId: z.string().min(1) }), result: zPatrolRun },
  "domain.patrol.scan": { params: zWs, result: z.array(zPatrolRun) },
  "domain.patrol.complete": { params: zWs.extend({ patrolRunId: z.string().min(1), sessionId: z.string().min(1), issueIds: z.array(z.string().min(1)), summary: z.string().trim().min(1) }), result: zPatrolRun },
  "domain.issue.workItem.create": {
    params: zWs.extend({
      patrolRunId: z.string().min(1), sessionId: z.string().min(1), issueId: z.string().min(1),
      authorizationReason: z.string().trim().min(1), expectedBehavior: z.string().trim().min(1),
      title: z.string().trim().min(1), objective: z.string(), risk: zRisk,
      refs: z.array(zDocRef).min(1), scope: zScope, acceptance: z.array(zAcceptanceItem).min(1),
      needs: z.array(z.string()).optional(), dependsOn: z.array(z.string()).optional()
    }), result: zWorkItem
  },

  "work.start": { params: zWs.extend({ sessionId: z.string().min(1), turnId: z.string().min(1).optional(), scope: z.string().optional(), message: zWorkMessage.optional() }), result: zWorkRequest },
  "work.list": { params: zWs, result: z.array(zWorkRequest) },
  "work.diagnose": { params: zWs.extend({ requestId: z.string().min(1) }), result: zWorkDiagnosis },
  "work.retry": { params: zWs.extend({ requestId: z.string().min(1) }), result: zWorkRequest },
  "work.prepare.complete": { params: zWs.extend({ requestId: z.string().min(1), sessionId: z.string().min(1), workItemIds: z.array(z.string()), refs: z.array(zDocRef).optional() }), result: zWorkRequest },
  "work.confirm": { params: zWs.extend({ requestId: z.string().min(1) }), result: zWorkRequest },
  "work.pause": { params: zWs.extend({ requestId: z.string().min(1) }), result: zWorkRequest },
  "work.resume": { params: zWs.extend({ requestId: z.string().min(1) }), result: zWorkRequest },
  "work.cancel": { params: z.union([
    zWs.extend({ requestId: z.string().min(1) }),
    zWs.extend({ sessionId: z.string().min(1) })
  ]), result: z.object({ cancelled: z.boolean(), request: zWorkRequest.optional() }) },
  "workItem.list": { params: zWs, result: z.array(zWorkItem) },
  "workItem.get": { params: zWi, result: zWorkItem },
  "workItem.create": {
    params: zWs.extend({
      sessionId: z.string().optional(), sourceSessionId: z.string().optional(), sourceTurnId: z.string().optional(), treeId: z.string().optional(), requestId: z.string().optional(), issueId: z.string().optional(), worktreePath: z.string().optional(), branch: z.string().optional(),
      title: z.string().min(1),
      objective: z.string(),
      risk: zRisk,
      refs: z.array(zDocRef).optional(),
      scope: zScope,
      acceptance: z.array(zAcceptanceItem),
      needs: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional()
    }),
    result: zWorkItem
  },
  "workItem.start": { params: zWi.extend({ run: z.object({ sessionId: z.string().optional(), heartbeatAt: z.string().optional() }).strict() }), result: zWorkItem },
  "workItem.heartbeat": { params: zWi.extend({ lastTurnId: z.string().optional() }), result: zWorkItem },
  "workItem.submit": {
    params: zWi.extend({ sessionId: z.string().min(1).optional(), contractRevision: z.number().int().nonnegative(), evidence: zEvidence.omit({ submittedAt: true }), review: z.array(zReviewDisposition), verify: zVerifySubmission }),
    result: zWorkItem
  },
  "workItem.rollback": { params: zWi.extend({ reason: z.string().trim().min(1) }), result: zWorkItem },
  "inbox.acknowledge": { params: zWi, result: zWorkItem },
  "workItem.cancel": { params: zWi, result: zWorkItem },
  "workItem.pause": { params: zWs.extend({ sessionId: z.string().min(1).optional(), workItemId: z.string().min(1).optional() }), result: z.object({ paused: z.boolean(), workItem: zWorkItem.optional() }) },
  "workItem.resume": { params: zWi, result: zWorkItem },
  "workItem.retry": { params: zWi, result: zWorkItem },
  "workItem.continueFrom": { params: zWi.extend({ sessionId: z.string().min(1), turnId: z.string().min(1) }), result: zWorkItem },
  "workItem.confirm": { params: zWi, result: zWorkItem },
  "workItem.integration.retry": { params: zWi, result: zWorkItem },
  "workItem.integration.takeover": { params: zWi.extend({ note: z.string().trim().optional() }), result: zWorkItem },
  "workItem.integration.complete": { params: zWi.extend({ actionId: z.string().min(1), sessionId: z.string().min(1) }), result: zWorkItem },
  "workItem.diagnose": { params: zWi, result: zDiagnosis },
  "runtime.info": { params: zEmpty, result: z.object({ buildId: z.string(), pid: z.number(), startedAt: z.string(), schedulerOnline: z.boolean() }) },
  "action.list": { params: zWs, result: z.array(zWorkflowAction) },
  "workItem.update": {
    params: zWi.extend({
      note: z.string().min(1),
      /** The session raising the change; a worker editing its own item passes its own session and is not notified. */
      sessionId: z.string().min(1).optional(),
      worktreePath: z.string().optional(), branch: z.string().optional(),
      title: z.string().min(1).optional(),
      objective: z.string().optional(),
      risk: zRisk.optional(),
      refs: z.array(zDocRef).optional(),
      scope: zScope.optional(),
      acceptance: z.array(zAcceptanceItem).optional(),
      needs: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional()
    }),
    result: zWorkItem
  },

  "scheduler.get": { params: zWs, result: zScheduler },
  "scheduler.set": { params: zWs.extend({ value: zScheduler }), result: zScheduler },
  "run.list": { params: zWs, result: z.array(zAgentRun) },

  "decision.list": { params: zWs, result: z.array(zDecisionCard) },
  "decision.create": {
    params: zWs.extend({
      requestId: z.string().optional(),
      kind: z.enum(["worker", "attempts"]).optional(),
      actionId: z.string().optional(),
      question: z.string().min(1),
      context: z.string(),
      details: z.string().optional(),
      options: z.array(zDecisionOption).min(1),
      recommended: z.string().optional(),
      recommendation: z.string().optional(),
      workItemId: z.string().optional(),
      sessionId: z.string().optional()
    }),
    result: zDecisionCard
  },
  /** Pick an option (key), write a free answer (note only), or both. */
  "decision.answer": { params: zWs.extend({ decisionId: z.string().min(1), key: z.string().min(1).optional(), note: z.string().optional() }), result: zDecisionCard },

  "inbox.list": { params: z.object({ includeProcessed: z.boolean().optional() }), result: z.array(zInboxItem) },

  "app.start": {
    params: z.object({ dataDir: z.string().min(1), userDataDir: z.string().min(1).optional(), port: z.number().int().min(1024).max(65535), fixture: z.enum(["session-tree", "real-session"]).optional(), codexConfigSource: z.string().min(1).optional(), env: z.record(z.string()).optional() }),
    result: z.object({ pid: z.number().int(), cdpUrl: z.string(), desktop: z.string(), dataDir: z.string().optional(), projectPath: z.string().optional(), workspaceId: z.string().optional(), codexHome: z.string().optional(), piAgentDir: z.string().optional() })
  },
  "app.stop": { params: z.object({ pid: z.number().int().positive() }), result: zEmpty },
  "app.window": {
    params: z.object({ dataDir: z.string().min(1), pid: z.number().int().positive(), action: z.enum(["status", "minimize", "restore"]) }),
    result: z.object({ dataDir: z.string(), pid: z.number().int().positive(), action: z.enum(["status", "minimize", "restore"]), visible: z.boolean(), minimized: z.boolean() })
  },

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
