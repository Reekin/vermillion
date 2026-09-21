import type { FSWatcher } from "node:fs";
import { workerOpeningMessage } from "./execution-message.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { beginExecution, confirmExecution, acceptExecutionMessage, transitionControl, retryMinutes, type TurnInspector, type SessionDispatchGrant, type SessionDispatchMessage, type SessionDispatchReceipt, type MessageDeliveryPort } from "./execution-control.js";
import { basename, resolve } from "node:path";
import type {
  AgentRun,
  Scheduler,
  DecisionCard,
  DocChange,
  DocCommit,
  DocFile,
  DomainConfig,
  DomainDefinition,
  InboxItem,
  Issue,
  PatrolRun,
  RoleExecutionOverrides,
  WorkRequest,
  SessionDelivery,
  WorkDiagnosis,
  RoleFile,
  WorkItem,
  WorkbenchEvent,
  Workspace
} from "./contracts.js";
import { effectiveNeeds, actionIsOpen, projectWorkItem, zSessionDelivery, type ExecutionNotice, type WorkflowAction, type Execution, type Integration, type VerifySubmission, type WorkItemRecord } from "./contracts.js";
import type { SessionNavigationPort } from "./session-navigation.js";
import { DocDraftConflict, DocsService, WorktreeMergeConflict, WorktreeNotReady, draftKey, listTrackedDirectories, type DocDraft } from "./docs.js";
import { RoleService } from "./roles.js";
import type { AppLauncher, AppStartInput, AppStartResult, AppStopInput, AppStopResult, AppWindowInput, AppWindowResult } from "./app-launcher.js";
import { WorkspaceStore } from "./workspace-store.js";
import { diagnose } from "./diagnosis.js";
import { runtimeInfo } from "./runtime-info.js";
import { searchWorkbench, type SearchQuery, type SearchResult, type SessionSearchSource } from "./search.js";
import { DOMAINS_DIR, defaultDomainConfig, domainIdFromPath, nextRunAt, parseDomainDefinition, pathMatches } from "./domains.js";

const RETRY_MINUTES = retryMinutes;

const createId = (prefix: string): string =>
  prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

const pendingNotice = (kind: ExecutionNotice["kind"], text: string, at: string): ExecutionNotice => ({ at, kind, text });

/** A notice that moved the contract basis carries the instruction to re-read it before continuing. */
const rereadContract = "立即重新执行 vermillion workItem.get 读取最新合同，按新合同继续；已完成但不再需要的部分回退。";
/** 子代理参数按会话引擎生成：Codex 用 spawn_agent，pi 用 subagent 工具。 */
const subagentArguments = (
  config: RoleExecutionOverrides | undefined,
  engineId: string
): Record<string, string | boolean> =>
  engineId === "codex"
    ? {
        fork_context: false,
        ...(config?.modelId ? { model: config.modelId } : {}),
        ...(config?.reasoningOptionId ? { reasoning_effort: config.reasoningOptionId } : {})
      }
    : {
        agent: "delegate",
        context: "fresh",
        ...(config?.modelId
          ? {
              model: config.reasoningOptionId
                ? `${config.modelId}:${config.reasoningOptionId}`
                : config.modelId
            }
          : {})
      };

const subagentToolLabel = (engineId: string): string =>
  engineId === "codex"
    ? "spawn_agent top-level parameters（JSON；复制到工具参数，不放入 message）"
    : "subagent tool parameters（JSON；作为 subagent 工具参数传入）";
const issueStatusText: Record<Issue["status"], string> = {
  open: "待处理", investigating: "调查中", decision: "待决策", started: "已开工", closed: "关闭", duplicate: "重复"
};

/** Source of truth for workspace identity; the session engine's registry in production. */
export type WorkspaceSource = {
  list: () => Promise<Array<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>>;
  register: (input: { rootPath: string; label?: string }) => Promise<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>;
  remove: (workspaceId: string) => Promise<void>;
};

export type SessionSteerResult = {
  sessionId: string;
  turnId?: string;
  delivery?: "steered" | "started" | "queued";
  accepted?: boolean;
  error?: SessionDispatchReceipt["error"];
  queued?: SessionDispatchReceipt["queued"];
};

export type SessionSteerer = (input: {
  sessionId: string;
  content: string;
  messageId?: string;
}) => Promise<SessionSteerResult>;

export type ExecutionTransferPort = {
  interrupt: (sessionId: string, turnId?: string) => Promise<void>;
  fork: (input: { workspaceId: string; sourceSessionId: string; sourceTurnId: string; title: string; metadata: Record<string, unknown> }) => Promise<{ sessionId: string; treeId?: string }>;
};

export type DeliveryConfirmer = (sessionId: string, messageId: string) => Promise<{ accepted: boolean; turnId?: string; active?: boolean }>;

export type SourceAskResult = {
  answer: string;
  askSessionId: string;
  askTurnId: string;
  archived: boolean;
  archiveError?: string;
};

export type SourceAsker = (input: {
  workspaceId: string;
  workItemId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  question: string;
}) => Promise<SourceAskResult>;

export type IssueDiscussionStarter = (input: {
  workspaceId: string;
  issueId: string;
  title: string;
  content: string;
}) => Promise<{ sessionId: string; turnId?: string }>;

type IssueUpdateInput = Partial<Pick<Issue, "title" | "summary" | "domainId" | "type" | "status" | "requirement" | "suggestion" | "decisionQuestion" | "resolutionReason" | "duplicateOf">> & {
  appendEvidence?: Issue["evidence"];
  unread?: boolean;
  patrolRunId?: string;
};

type IssueCreateInput = Pick<Issue, "title" | "summary" | "domainId"> & Partial<Pick<Issue, "source" | "type" | "status" | "requirement" | "evidence" | "suggestion" | "decisionQuestion">> & {
  patrolRunId?: string;
};

type DomainConfigInput = Pick<DomainConfig, "enabled" | "changeTrigger" | "intervalHours" | "triggerPaths" | "autoWorkEnabled" | "authorizationScope">;
type WorkItemCreateInput = Pick<WorkItem, "title" | "objective" | "risk" | "scope" | "acceptance"> & {
  sessionId?: string; sourceSessionId?: string; sourceTurnId?: string; treeId?: string; requestId?: string; issueId?: string;
  worktreePath?: string; branch?: string; refs?: WorkItem["refs"]; needs?: string[]; dependsOn?: string[]; owner?: WorkItem["owner"];
};

export type WorkbenchServiceOptions = {
  workspaces: WorkspaceSource;
  roles: RoleService;
  sourceAsker?: SourceAsker;
  sessionSteerer?: SessionSteerer;
  executionTransfer?: ExecutionTransferPort;
  deliveryConfirmer?: DeliveryConfirmer;
  issueDiscussionStarter?: IssueDiscussionStarter;
  sessionNavigation?: SessionNavigationPort;
  /** Starts isolated app instances for acceptance; absent when running without a desktop build around. */
  launcher?: AppLauncher;
  /** Controls the current Electron window when the RPC is handled inside that app process. */
  appWindowController?: (input: AppWindowInput) => Promise<AppWindowResult>;
  sessionSearch?: SessionSearchSource;
  rolloutsDir?: string;
  now?: () => string;
};

type WorkspaceContext = { rootPath: string; store: WorkspaceStore; docs: DocsService; watcher?: Pick<FSWatcher, "close"> };

export class WorkbenchService {
  private readonly workspaces: WorkspaceSource;
  private readonly roles: RoleService;
  private readonly sourceAsker?: SourceAsker;
  private readonly sessionSteerer?: SessionSteerer;
  private readonly executionTransfer?: ExecutionTransferPort;
  private readonly deliveryConfirmer?: DeliveryConfirmer;
  private readonly issueDiscussionStarter?: IssueDiscussionStarter;
  private readonly sessionNavigation?: SessionNavigationPort;
  private readonly launcher?: AppLauncher;
  private readonly appWindowController?: (input: AppWindowInput) => Promise<AppWindowResult>;
  private readonly sessionSearch?: SessionSearchSource;
  private readonly rolloutsDir?: string;
  private readonly now: () => string;
  private readonly releasedWorkers = new Set<string>();
  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly contextLoads = new Map<string, Promise<WorkspaceContext>>();
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();
  private readonly integrations = new Map<string, Promise<unknown>>();
  private messageDeliveryPort?: MessageDeliveryPort;
  private executionPreparer?: (sessionId: string, target: { workspaceId: string; workItemId?: string; requestId?: string }) => Promise<void>;
  private readonly deliveryContext = new AsyncLocalStorage<SessionDispatchGrant & { valid: boolean }>();
  private readonly inFlightMessages = new Set<string>();
  private readonly patrolScans = new Map<string, Promise<unknown>>();
  private readonly decisionDeliveries = new Map<string, Promise<void>>();
  private schedulerOwner?: object;
  private activeSearch?: { queryId: string; controller: AbortController };
  private sourceTurnResolver?: (sessionId: string) => Promise<string | undefined>;
  private sessionTreeResolver?: (sessionId: string) => Promise<string | undefined>;
  private workerActive?: (sessionId: string) => boolean;
  private workerSettling?: (sessionId: string) => boolean;
  private turnInspector?: TurnInspector;
  private turnInterrupter?: (sessionId: string, turnId: string) => Promise<void>;
  private readonly turnInspections = new Map<string, { turnId: string; status: "active" | "completed" | "unknown" }>();
  private releaseWorkerEnvironment?: (sessionId: string) => Promise<void>;

  setWorkerEnvironmentReleaser(release: (sessionId: string) => Promise<void>): () => void {
    this.releaseWorkerEnvironment = release;
    return () => { if (this.releaseWorkerEnvironment === release) this.releaseWorkerEnvironment = undefined; };
  }

  setWorkerActiveChecker(checker: (sessionId: string) => boolean): () => void {
    this.workerActive = checker;
    return () => { if (this.workerActive === checker) this.workerActive = undefined; };
  }

  setWorkerSettlingChecker(checker: (sessionId: string) => boolean): () => void {
    this.workerSettling = checker;
    return () => { if (this.workerSettling === checker) this.workerSettling = undefined; };
  }

  setTurnInspector(inspector: TurnInspector): () => void {
    this.turnInspector = inspector;
    return () => { if (this.turnInspector === inspector) this.turnInspector = undefined; };
  }

  setTurnInterrupter(interrupt: (sessionId: string, turnId: string) => Promise<void>): () => void {
    this.turnInterrupter = interrupt;
    return () => { if (this.turnInterrupter === interrupt) this.turnInterrupter = undefined; };
  }

  private async stopCancelledDelivery(workspaceId: string, message: SessionDelivery, turnId?: string): Promise<void> {
    let cancelled = false;
    if (message.workItemId) {
      if ((await this.getWorkItem(workspaceId, message.workItemId)).status !== "cancelled") return;
      await this.transactRecord(workspaceId, message.workItemId, (record) => {
        if (!record) throw new Error("Unknown work item: " + message.workItemId);
        if (record.item.status !== "cancelled" || record.execution.sessionId !== message.sessionId) return { record, result: undefined };
        if (record.execution.pendingMessageId !== message.messageId && (!turnId || record.execution.activeTurnId !== turnId)) return { record, result: undefined };
        cancelled = true;
        return { record: { ...record, execution: { ...record.execution,
          pendingMessageId: record.execution.pendingMessageId === message.messageId ? undefined : record.execution.pendingMessageId,
          ...(turnId ? { activeTurnId: turnId } : {}), deliveryUncertain: undefined, updatedAt: this.now() } }, result: undefined };
      });
    } else if (message.requestId) await this.updateWorkRequest(workspaceId, message.requestId, (request) => {
      if (request.status !== "cancelled" || request.workerSessionId !== message.sessionId) return request;
      if (request.pendingMessageId !== message.messageId && (!turnId || request.activeTurnId !== turnId)) return request;
      cancelled = true;
      return { ...request, pendingMessageId: request.pendingMessageId === message.messageId ? undefined : request.pendingMessageId,
        ...(turnId ? { activeTurnId: turnId } : {}), deliveryUncertain: undefined };
    });
    if (cancelled && turnId) await (this.turnInterrupter ?? this.executionTransfer?.interrupt)?.(message.sessionId, turnId);
  }

  async reconcileExecutionTurns(workspaceId: string): Promise<void> {
    const inspect = this.turnInspector;
    if (!inspect) return;
    const targets = [
      ...(await this.listWorkRequests(workspaceId)).filter((entry) => entry.status !== "ready")
        .map((entry) => ({ sessionId: entry.workerSessionId, turnId: entry.activeTurnId, cancelled: entry.status === "cancelled" })),
      ...(await this.listWorkItems(workspaceId)).map((entry) => ({ sessionId: entry.run.sessionId, turnId: entry.run.activeTurnId, cancelled: entry.status === "cancelled" }))
    ];
    for (const target of targets) {
      if (!target.sessionId || !target.turnId || this.workerSettling?.(target.sessionId)) continue;
      const result = await inspect(target.sessionId, target.turnId);
      if (target.cancelled && result.status === "active") await (this.turnInterrupter ?? this.executionTransfer?.interrupt)?.(target.sessionId, target.turnId);
      const previous = this.turnInspections.get(target.sessionId);
      this.turnInspections.set(target.sessionId, { turnId: target.turnId, status: result.status });
      if (previous?.turnId !== target.turnId || previous.status !== result.status) {
        this.emit({ type: "workItems.changed", workspaceId });
        this.emit({ type: "workRequests.changed", workspaceId });
      }
      if (result.status === "completed" && result.finishReason) await this.settleExecutionTurn(workspaceId, target.sessionId, target.turnId, result.finishReason, result.failure);
    }
  }

  async settleExecutionTurn(workspaceId: string, sessionId: string, turnId: string, finishReason: string, failure?: string, completion?: string) {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.workerSessionId === sessionId && entry.activeTurnId === turnId && ["preparing", "cancelled"].includes(entry.status));
    if (request) return this.integrate(workspaceId, async () => {
      const current = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === request.requestId)!;
      if (current.workerSessionId !== sessionId || current.activeTurnId !== turnId) return undefined;
      if (current.status !== "cancelled" && finishReason === "completed" && current.handoff) await this.finishPreparationRecord(workspaceId, sessionId, turnId);
      else if (current.status !== "cancelled" && current.control !== "paused") {
        if (finishReason === "completed") await this.preparationWithoutHandoff(workspaceId, current.requestId);
        else await this.failWorkRequest(workspaceId, current.requestId, failure ?? "准备轮" + finishReason);
      }
      await this.updateWorkRequest(workspaceId, current.requestId, (latest) => transitionControl(latest, { type: "settled", turnId }));
      return { status: finishReason === "failed" ? "failed" as const : "done" as const, note: "准备轮已结算" };
    });
    const item = (await this.listWorkItems(workspaceId)).find((entry) => entry.run.sessionId === sessionId && entry.run.activeTurnId === turnId);
    if (!item) return undefined;
    const execution = (await this.listActions(workspaceId)).find((action): action is Execution => action.kind === "execute" && action.workItemId === item.workItemId)!;
    const result = await this.settleWorkerTurn(workspaceId, item.workItemId, { ownsExecution: () => true, turnId, finishReason, failure,
      scheduled: item.run.control === "auto", completion: completion ?? (execution.integrationActionId ? "通过 workItem.integration.complete 登记合入结果" : "通过 workItem.submit 或 decision.create 登记交接结果"), requireCurrentTurn: true });
    if (result && execution.runId) {
      const run = (await this.listRuns(workspaceId)).find((entry) => entry.runId === execution.runId);
      if (run) await this.putRun(workspaceId, { ...run, turns: run.turns + 1, status: result.status, note: result.note, endedAt: this.now() });
    }
    return result;
  }

  setMessageDeliveryPort(port: MessageDeliveryPort): () => void {
    this.messageDeliveryPort = port;
    return () => { if (this.messageDeliveryPort === port) this.messageDeliveryPort = undefined; };
  }

  setExecutionPreparer(prepare: (sessionId: string, target: { workspaceId: string; workItemId?: string; requestId?: string }) => Promise<void>): () => void {
    this.executionPreparer = prepare;
    return () => { if (this.executionPreparer === prepare) this.executionPreparer = undefined; };
  }

  /** Message payloads live with their execution owner; they do not determine control or capacity. */
  private async sessionDeliveries(workspaceId: string) {
    const { store } = await this.context(workspaceId);
    const list = async () => [
      ...(await store.listRecords()).flatMap((record) => record.execution.deliveries ?? []),
      ...(await store.workRequests.list()).flatMap((request) => request.deliveries ?? [])
    ];
    return {
      list,
      get: async (messageId: string) => (await list()).find((message) => message.messageId === messageId),
      put: async (message: SessionDelivery) => {
        if (message.state === "accepted" || message.state === "cancelled") message = { ...message, content: "", attachments: undefined, execution: undefined };
        message = zSessionDelivery.parse(message);
        const previous = (await list()).find((entry) => entry.messageId === message.messageId);
        if (JSON.stringify(previous) === JSON.stringify(message)) return message;
        const update = (entries: SessionDelivery[] = []) => [...entries.filter((entry) => entry.messageId !== message.messageId), message];
        if (message.workItemId) await this.mutateRecord(workspaceId, message.workItemId, (record) => ({ ...record,
          execution: { ...record.execution, deliveries: update(record.execution.deliveries) } }));
        else if (message.requestId) {
          await store.transactWorkRequest(message.requestId, (request) => {
            if (!request) throw new Error("Unknown preparation: " + message.requestId);
            return { record: { ...request, deliveries: update(request.deliveries) }, result: undefined };
          });
          this.emit({ type: "workRequests.changed", workspaceId });
        }
        this.emit({ type: "session.messages.changed", workspaceId, sessionId: message.sessionId });
        if (message.state === "accepted" && message.decisionId) {
          const card = await store.decisions.get(message.decisionId);
          if (card?.answer && card.deliveryPending) {
            await store.decisions.put({ ...card, deliveryPending: false });
            this.emit({ type: "decisions.changed", workspaceId });
          }
        }
        return message;
      }
    };
  }

  private async executionBinding(sessionId: string) {
    for (const { workspaceId } of await this.listWorkspaces()) {
      const items = await this.listWorkItems(workspaceId);
      const requests = await this.listWorkRequests(workspaceId);
      // A preparation may also have registered its first Worker; preparation owns the branch until handoff.
      const request = requests.find((entry) => entry.workerSessionId === sessionId && !["ready", "cancelled"].includes(entry.status));
      const item = items.find((entry) => entry.run.sessionId === sessionId && !["closed", "cancelled"].includes(entry.status));
      if (request || item) return { workspaceId, items, requests, request, item: request ? undefined : item };
    }
    return undefined;
  }

  async listOccupiedWorkItems(workspaceId: string): Promise<WorkItem[]> {
    const actions = await this.listActions(workspaceId);
    return (await this.listWorkItems(workspaceId)).filter((item) => {
      if (["closed", "cancelled"].includes(item.status)) return !!item.run.pendingMessageId || !!item.run.activeTurnId;
      if (item.run.sessionId && this.workerActive?.(item.run.sessionId)) return true;
      const execution = actions.find((action): action is Execution => action.kind === "execute" && action.workItemId === item.workItemId)!;
      return !!execution.activeTurnId || !!execution.pendingMessageId || execution.status === "running" && execution.control !== "paused";
    });
  }

  async getExecutionOccupancy(workspaceId: string) {
    const workItems = await this.listOccupiedWorkItems(workspaceId);
    const requests = await this.listWorkRequests(workspaceId);
    const sessionIds = [...new Set([
      ...workItems.map((item) => item.run.sessionId),
      ...requests.filter((request) => !["ready", "cancelled"].includes(request.status) &&
        (!!request.activeTurnId || !!request.pendingMessageId || !!request.workerSessionId && this.workerActive?.(request.workerSessionId))).map((request) => request.workerSessionId)
    ].filter((sessionId): sessionId is string => !!sessionId))];
    return { workItems, sessionIds };
  }

  private inspectedTurnStatus(sessionId?: string, turnId?: string): "active" | "unknown" | undefined {
    const result = sessionId ? this.turnInspections.get(sessionId) : undefined;
    return result && result.turnId === turnId && result.status !== "completed" ? result.status : undefined;
  }

  private projectExecutionItem(record: WorkItemRecord): WorkItem {
    const item = projectWorkItem(record);
    return { ...item, run: { ...item.run, turnStatus: this.inspectedTurnStatus(item.run.sessionId, item.run.activeTurnId) } };
  }

  async dispatchSessionMessage(input: SessionDispatchMessage, deliver = this.messageDeliveryPort): Promise<SessionDispatchReceipt> {
    const grant = this.deliveryContext.getStore();
    if (grant?.valid && grant.messageId === input.messageId) {
      if (!deliver) throw new Error("Session delivery requires a running desktop instance.");
      return deliver({ ...input, allowStart: grant.allowStart });
    }
    const ownsFlight = !this.inFlightMessages.has(input.messageId);
    if (ownsFlight) this.inFlightMessages.add(input.messageId);
    try { return await this.dispatchSessionMessageRecord(input, deliver); }
    finally { if (ownsFlight) this.inFlightMessages.delete(input.messageId); }
  }

  private async dispatchSessionMessageRecord(input: SessionDispatchMessage, deliver = this.messageDeliveryPort): Promise<SessionDispatchReceipt> {
    if (!deliver) throw new Error("Session delivery requires a running desktop instance.");
    const binding = await this.executionBinding(input.sessionId);
    if (!binding) {
      for (const { workspaceId } of await this.listWorkspaces()) {
        if ((await this.listWorkItems(workspaceId)).some((item) => item.run.migratedFromSessionId === input.sessionId) ||
            (await this.listWorkRequests(workspaceId)).some((request) => request.migratedFromSessionId === input.sessionId))
          return { accepted: false, error: { code: "execution_moved", message: "执行已迁移，请进入当前执行分支" } };
      }
      return deliver({ ...input, allowStart: true });
    }
    const { workspaceId } = binding;
    // Serialize admission and persist reservation before calling the engine. Do not hold the lock across engine callbacks.
    const admission = await this.integrate(workspaceId, async () => {
      const current = await this.executionBinding(input.sessionId);
      const deliveriesStore = await this.sessionDeliveries(workspaceId);
      const existing = await deliveriesStore.get(input.messageId);
      if (existing?.state === "accepted") return { receipt: { accepted: true, turnId: existing.turnId } as SessionDispatchReceipt };
      if (existing?.state === "sending" || existing?.state === "unknown") return { receipt: { accepted: false, queued: { messageId: input.messageId, reason: "消息受理状态等待确认", workItemId: existing.workItemId } } as SessionDispatchReceipt };
      if (existing?.state === "cancelled") return { receipt: { accepted: false } as SessionDispatchReceipt };
      if (existing?.state === "rejected") return { receipt: { accepted: false, error: { code: "delivery_rejected", message: existing.reason ?? "发送被拒绝，请修正后重试" } } as SessionDispatchReceipt };
      if (!current) {
        if (existing) await deliveriesStore.put({ ...existing, state: "cancelled" });
        return { receipt: { accepted: false } as SessionDispatchReceipt };
      }
      const { request, item, items, requests } = current;
      const control = request ?? item!.run;
      const origin = existing?.origin ?? input.origin ?? "user";
      const active = Boolean(this.workerActive?.(input.sessionId));
      const scheduler = await this.getScheduler(workspaceId);
      const occupancy = await this.getExecutionOccupancy(workspaceId);
      const occupiedItems = occupancy.workItems;
      let reason: string | undefined;
      const blockerWorkItemIds: string[] = [];
      if (control.control === "paused") reason = "当前工作已暂停";
      else if (this.workerSettling?.(input.sessionId)) reason = "等待上一轮结算完成";
      else if (control.pendingMessageId && control.pendingMessageId !== input.messageId) reason = "等待前一条消息受理确认";
      else if (!active && control.activeTurnId) reason = "等待上一轮结算完成";
      else if (origin === "scheduler" && (!scheduler.enabled || control.control === "manual" && !input.decisionId)) reason = "自动推进未启用";
      else if (!input.decisionId && origin === "scheduler" && control.retryAt && control.retryAt > this.now()) reason = "等待重试时间";
      else if (!active) {
        if (item) {
          if (!await this.preparationReady(workspaceId, item)) reason = "等待准备完成交接";
          const dependency = item.dependsOn.map((id) => items.find((entry) => entry.workItemId === id)).find((entry) => !entry || entry.status !== "closed");
          if (item.dependsOn.some((id) => !items.some((entry) => entry.workItemId === id && entry.status === "closed"))) reason = "等待前置工单 " + (dependency?.title ?? "完成");
          blockerWorkItemIds.push(...item.dependsOn.filter((id) => !items.some((entry) => entry.workItemId === id && entry.status === "closed")));
          const occupied = occupiedItems.filter((entry) => entry.workItemId !== item.workItemId);
          if (!reason && occupied.some((entry) => effectiveNeeds(entry).some((need) => effectiveNeeds(item).includes(need)))) reason = "等待共享资源释放";
          blockerWorkItemIds.push(...occupied.filter((entry) => effectiveNeeds(entry).some((need) => effectiveNeeds(item).includes(need))).map((entry) => entry.workItemId));
          if (!reason && item.status === "merging") reason = "正在合入，等待当前操作完成";
        }
        const occupiedSessions = new Set(occupancy.sessionIds.filter((session) => session !== input.sessionId));
        if (!reason && occupiedSessions.size >= scheduler.maxWorkers) reason = "等待执行并发名额";
      }
      const execution = item ? (await this.listActions(workspaceId)).find((entry): entry is Execution => entry.kind === "execute" && entry.workItemId === item.workItemId) : undefined;
      const opening = item && execution && !execution.deliveredAt && !execution.integrationActionId
        ? workerOpeningMessage(workspaceId, item, await this.workspaceRoot(workspaceId)) : undefined;
      const summary = [opening, request?.continuationSummary ?? execution?.continuationSummary].filter(Boolean).join("\n\n") || undefined;
      const message = { ...input, origin, mode: active ? "supplement" as const : "start" as const, state: reason ? "queued" as const : "sending" as const,
        targetTurnId: active ? control.activeTurnId : undefined,
        reason, blockerWorkItemIds, noticeCount: existing?.noticeCount ?? (origin === "scheduler" && !input.decisionId ? execution?.notices.length : undefined),
        workItemId: item?.workItemId, requestId: request?.requestId, createdAt: existing?.createdAt ?? this.now() };
      await deliveriesStore.put(message);
      if (reason) return { receipt: { accepted: false, queued: { messageId: input.messageId, reason, workItemId: item?.workItemId } } as SessionDispatchReceipt };
      if (request) {
        const latest = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === request.requestId)!;
        await this.updateWorkRequest(workspaceId, latest.requestId, (current) => ({ ...beginExecution(current, input.messageId, origin, active), status: "preparing" }));
      }
      if (item) {
        const decision = (await this.listDecisions(workspaceId)).some((card) => card.workItemId === item.workItemId && !card.answer && !card.withdrawn);
        await this.mutateRecord(workspaceId, item.workItemId, (record) => ({ ...record,
          item: { ...record.item, status: active || decision ? record.item.status : "running", updatedAt: this.now() },
          execution: { ...beginExecution(record.execution, input.messageId, input.decisionId ? "scheduler" : origin, active || decision),
            status: active || decision ? record.execution.status : "running", stage: active || decision ? record.execution.stage : "execute", updatedAt: this.now() }
        }));
      }
      const latest = await this.executionBinding(input.sessionId);
      return { message, active, summary: !active ? summary : undefined, attemptId: (latest?.request ?? latest?.item?.run)?.attemptId };
    });
    if (admission.receipt) return admission.receipt;
    const message = admission.message!;
    // Unknown delivery remains 'sending'; callers must reconcile rather than send another copy.
    let receipt: SessionDispatchReceipt;
    try {
      await this.executionPreparer?.(input.sessionId, { workspaceId, workItemId: message.workItemId, requestId: message.requestId });
    } catch (error) {
      receipt = { accepted: false, error: { code: "execution_preparation_failed", message: error instanceof Error ? error.message : String(error) } };
    }
    if (!receipt!) {
      const permitted = await this.integrate(workspaceId, async () => {
        const current = await this.executionBinding(input.sessionId);
        const control = current?.request ?? current?.item?.run;
        return !!control && control.control !== "paused" && control.attemptId === admission.attemptId;
      });
      if (!permitted) receipt = { accepted: false, queued: { messageId: input.messageId, reason: "执行控制已改变，等待当前控制允许发送", workItemId: message.workItemId } };
    }
    if (!receipt!) {
      try {
        const grant = { messageId: input.messageId, allowStart: !admission.active, valid: true };
        try {
          receipt = await this.deliveryContext.run(grant, () => deliver({ ...message, allowStart: grant.allowStart,
            content: admission.summary ? admission.summary + "\n\n" + message.content : message.content }));
        } finally { grant.valid = false; }
      } catch (error) {
        const known = await (await this.sessionDeliveries(workspaceId)).get(input.messageId);
        if (known?.state === "accepted") receipt = { accepted: true, turnId: known.turnId };
        else {
          await (await this.sessionDeliveries(workspaceId)).put({ ...message, state: "unknown", reason: "消息受理状态等待确认" });
          await this.integrate(workspaceId, async () => {
            const current = await this.executionBinding(input.sessionId);
            const reason = "消息受理状态不明，请核对引擎轮次后再继续";
            if (current?.request) await this.updateWorkRequest(workspaceId, current.request.requestId, (latest) => latest.pendingMessageId !== input.messageId ? latest :
              ({ ...latest, waitReason: reason, deliveryUncertain: true, failure: error instanceof Error ? error.message : String(error) }));
            if (current?.item) await this.mutateRecord(workspaceId, current.item.workItemId, (record) => record.execution.pendingMessageId !== input.messageId ? record : ({ ...record,
              execution: { ...record.execution, waitReason: reason, deliveryUncertain: true, failure: error instanceof Error ? error.message : String(error) } }));
          });
          throw error;
        }
      }
    }
    const deliveriesStore = await this.sessionDeliveries(workspaceId);
    if (!receipt.accepted) {
      if (receipt.error?.code === "execution_readmission_required") {
        receipt = { accepted: false, queued: { messageId: input.messageId, reason: "原轮已结束，等待重新检查执行条件", workItemId: message.workItemId } };
      }
      if (receipt.error) {
        await this.integrate(workspaceId, async () => {
          await deliveriesStore.put({ ...message, state: "rejected", reason: receipt.error!.message });
          const current = await this.executionBinding(input.sessionId);
          if (current?.request) await this.updateWorkRequest(workspaceId, current.request.requestId, (latest) => latest.pendingMessageId !== input.messageId ? latest :
            ({ ...(message.mode === "supplement" ? latest : transitionControl(latest, { type: "hold", reason: receipt.error!.message })), waitReason: receipt.error!.message, pendingMessageId: undefined }));
          if (current?.item) await this.mutateRecord(workspaceId, current.item.workItemId, (record) => record.execution.pendingMessageId !== input.messageId ? record : ({ ...record,
            item: { ...record.item, status: message.mode === "supplement" || record.execution.control === "paused" ? record.item.status : "decision" },
            execution: { ...(message.mode === "supplement" ? record.execution : transitionControl(record.execution, { type: "hold", reason: receipt.error!.message })), pendingMessageId: undefined,
              status: message.mode === "supplement" ? record.execution.status : "decision", waitReason: receipt.error!.message } }));
        });
        return receipt;
      }
      await this.integrate(workspaceId, async () => {
        const current = await this.executionBinding(input.sessionId);
        if (current?.request) await this.updateWorkRequest(workspaceId, current.request.requestId, (latest) => latest.pendingMessageId !== input.messageId ? latest : ({ ...latest, pendingMessageId: undefined }));
        if (current?.item) await this.mutateRecord(workspaceId, current.item.workItemId, (record) => record.execution.pendingMessageId !== input.messageId ? record : ({ ...record,
          item: { ...record.item, status: message.mode === "supplement" || record.execution.control === "paused" ? record.item.status : "queued" },
          execution: { ...record.execution, pendingMessageId: undefined,
            ...(message.mode === "supplement" ? {} : { status: record.execution.control === "paused" ? "decision" as const : "pending" as const, stage: "deliver" as const }) } }));
        await deliveriesStore.put({ ...message, state: "queued", reason: receipt.queued?.reason ?? "等待引擎受理" });
      });
      return { ...receipt, queued: receipt.queued ?? { messageId: input.messageId, reason: "等待引擎受理", workItemId: message.workItemId } };
    }
    await this.integrate(workspaceId, async () => {
      await deliveriesStore.put({ ...message, state: "accepted", reason: undefined, turnId: receipt.turnId });
      const current = await this.executionBinding(input.sessionId);
      if (current?.request) await this.updateWorkRequest(workspaceId, current.request.requestId, (latest) => ({ ...acceptExecutionMessage(latest, message, receipt.turnId, receipt.delivery === "started"),
        continuationSummary: latest.attemptId === input.messageId ? undefined : latest.continuationSummary }));
      if (current?.item) await this.mutateRecord(workspaceId, current.item.workItemId, (record) => record.execution.attemptId !== admission.attemptId ? record : ({ ...record,
        execution: { ...acceptExecutionMessage(record.execution, message, receipt.turnId, receipt.delivery === "started"),
          deliveredAt: this.now(),
          ...(message.origin === "scheduler" && !admission.active ? { scheduledTurnId: receipt.turnId } : {}),
          notices: message.origin === "scheduler" ? record.execution.notices.slice(message.noticeCount ?? 0) : record.execution.notices,
          continuationSummary: record.execution.attemptId === input.messageId ? undefined : record.execution.continuationSummary, updatedAt: this.now() } }));
    });
    await this.stopCancelledDelivery(workspaceId, message, receipt.turnId);
    return receipt;
  }

  async listPendingSessionMessages(sessionId: string) {
    const messages = [];
    for (const { workspaceId } of await this.listWorkspaces()) {
      const deliveriesStore = await this.sessionDeliveries(workspaceId);
      messages.push(...(await deliveriesStore.list()).filter((entry) => entry.sessionId === sessionId &&
        (entry.state === "queued" || entry.state === "rejected" || entry.state === "unknown" || entry.state === "sending" && !this.inFlightMessages.has(entry.messageId)))
        .map((entry) => ({ ...entry, state: entry.state === "queued" || entry.state === "rejected" ? "queued" as const : "unknown" as const,
          reason: entry.state === "queued" || entry.state === "rejected" ? entry.reason : "消息受理状态等待确认" })));
    }
    return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async cancelPendingSessionMessage(sessionId: string, messageId: string): Promise<{ cancelled: boolean }> {
    for (const { workspaceId } of await this.listWorkspaces()) {
      const result = await this.integrate(workspaceId, async () => {
        const deliveriesStore = await this.sessionDeliveries(workspaceId);
        const message = await deliveriesStore.get(messageId);
        if (message?.sessionId !== sessionId || !["queued", "rejected"].includes(message.state)) return false;
        await deliveriesStore.put({ ...message, state: "cancelled" });
        return true;
      });
      if (result) return { cancelled: true };
    }
    return { cancelled: false };
  }

  async flushSessionMessages(workspaceId: string, fallback?: MessageDeliveryPort): Promise<void> {
    const deliver = this.messageDeliveryPort ?? fallback;
    if (!deliver) return;
    const deliveriesStore = await this.sessionDeliveries(workspaceId);
    for (const message of (await deliveriesStore.list()).filter((entry) => entry.state === "queued")) {
      const binding = await this.executionBinding(message.sessionId);
      if (!binding || binding.item?.workItemId !== message.workItemId || binding.request?.requestId !== message.requestId) {
        await deliveriesStore.put({ ...message, state: "cancelled" });
        continue;
      }
      await this.dispatchSessionMessage(message, deliver);
    }
  }

  async observeSessionTurn(sessionId: string, turnId: string, messageId?: string): Promise<"scheduler" | "user"> {
    const binding = await this.executionBinding(sessionId);
    if (!binding) return "user";
    const deliveriesStore = await this.sessionDeliveries(binding.workspaceId);
    const pendingMessageId = (binding.request ?? binding.item?.run)?.pendingMessageId;
    const delivery = (await deliveriesStore.list()).find((entry) => entry.sessionId === sessionId &&
      (messageId ? entry.messageId === messageId : entry.turnId === turnId || entry.messageId === pendingMessageId) && ["sending", "unknown", "accepted"].includes(entry.state));
    if (!delivery) return "user";
    await deliveriesStore.put({ ...delivery, state: "accepted", turnId });
    if (binding.request) {
      const request = (await this.listWorkRequests(binding.workspaceId)).find((entry) => entry.requestId === binding.request!.requestId)!;
      await this.updateWorkRequest(binding.workspaceId, request.requestId, (current) => acceptExecutionMessage(current, delivery, turnId));
    }
    if (binding.item) await this.mutateRecord(binding.workspaceId, binding.item.workItemId, (record) => ({ ...record,
      execution: { ...acceptExecutionMessage(record.execution, delivery, turnId), deliveredAt: record.execution.deliveredAt ?? this.now(), updatedAt: this.now() } }));
    return delivery.origin;
  }

  setSourceTurnResolver(resolver: (sessionId: string) => Promise<string | undefined>): () => void {
    this.sourceTurnResolver = resolver;
    return () => { if (this.sourceTurnResolver === resolver) this.sourceTurnResolver = undefined; };
  }

  setSessionTreeResolver(resolver: (sessionId: string) => Promise<string | undefined>): () => void {
    this.sessionTreeResolver = resolver;
    return () => { if (this.sessionTreeResolver === resolver) this.sessionTreeResolver = undefined; };
  }

  constructor(options: WorkbenchServiceOptions) {
    this.workspaces = options.workspaces;
    this.roles = options.roles;
    this.sourceAsker = options.sourceAsker;
    this.sessionSteerer = options.sessionSteerer;
    this.executionTransfer = options.executionTransfer;
    this.deliveryConfirmer = options.deliveryConfirmer;
    this.issueDiscussionStarter = options.issueDiscussionStarter;
    this.sessionNavigation = options.sessionNavigation;
    this.launcher = options.launcher;
    this.appWindowController = options.appWindowController;
    this.sessionSearch = options.sessionSearch;
    this.rolloutsDir = options.rolloutsDir;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WorkbenchEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Workers share the workspace Git index; integrate their results one at a time. */
  private async integrate<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    return this.serializeWorkspace(this.integrations, workspaceId, action);
  }

  private async serializePatrol<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    return this.serializeWorkspace(this.patrolScans, workspaceId, action);
  }

  private async serializeWorkspace<T>(queue: Map<string, Promise<unknown>>, workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = queue.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    queue.set(workspaceId, next);
    try { return await next; }
    finally { if (queue.get(workspaceId) === next) queue.delete(workspaceId); }
  }

  async dispose(): Promise<void> {
    this.activeSearch?.controller.abort();
    this.activeSearch = undefined;
    await Promise.allSettled([...this.contextLoads.values()]);
    for (const context of this.contexts.values()) context.watcher?.close();
    await Promise.allSettled([...this.integrations.values(), ...this.patrolScans.values()]);
    this.contexts.clear();
  }

  // ---- workspaces ----

  async createSessionNavigation(input: { sessionId: string; targetSessionId: string; reason?: string }) {
    if (!this.sessionNavigation) throw new Error("sessionNavigation.create requires a running desktop instance");
    const { navigation, workspaceId } = await this.sessionNavigation.create(input);
    this.emit({ type: "sessionNavigation.changed", sessionId: input.sessionId, workspaceId });
    return navigation;
  }

  async listSessionNavigations(input: { sessionId: string; turnId: string }) {
    if (!this.sessionNavigation) throw new Error("sessionNavigation.list requires a running desktop instance");
    return this.sessionNavigation.list(input);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const list = await this.workspaces.list();
    return list
      .map((w) => ({ workspaceId: w.workspaceId, rootPath: w.rootPath, label: w.label, createdAt: w.createdAt, lastActiveAt: w.updatedAt }))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async addWorkspace(input: { rootPath: string; label?: string }): Promise<Workspace> {
    const rootPath = resolve(input.rootPath);
    if (!(await new WorkspaceStore(rootPath).exists())) {
      throw new Error("Workspace directory does not exist: " + rootPath);
    }
    await new DocsService(rootPath).ensureRepo();
    const record = await this.workspaces.register({ rootPath, label: input.label?.trim() || basename(rootPath) });
    this.emit({ type: "workspaces.changed" });
    return { workspaceId: record.workspaceId, rootPath: record.rootPath, label: record.label, createdAt: record.createdAt, lastActiveAt: record.updatedAt };
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.workspaces.remove(workspaceId);
    this.contexts.get(workspaceId)?.watcher?.close();
    this.contexts.delete(workspaceId);
    this.emit({ type: "workspaces.changed" });
  }

  async listWorkspaceDirectories(workspaceId: string): Promise<string[]> {
    return listTrackedDirectories((await this.context(workspaceId)).rootPath);
  }

  private async context(workspaceId: string): Promise<WorkspaceContext> {
    const existing = this.contexts.get(workspaceId);
    if (existing) return existing;
    const pending = this.contextLoads.get(workspaceId);
    if (pending) return pending;
    const load = this.loadContext(workspaceId);
    this.contextLoads.set(workspaceId, load);
    try { return await load; }
    finally { if (this.contextLoads.get(workspaceId) === load) this.contextLoads.delete(workspaceId); }
  }

  private async loadContext(workspaceId: string): Promise<WorkspaceContext> {
    const cached = this.contexts.get(workspaceId);
    if (cached) return cached;
    const workspace = (await this.listWorkspaces()).find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw new Error("Unknown workspace: " + workspaceId);
    const store = new WorkspaceStore(workspace.rootPath);
    await store.validateExecutionStorage();
    const docs = new DocsService(workspace.rootPath);
    await docs.ensureRepo();
    const context: WorkspaceContext = { rootPath: workspace.rootPath, store, docs };
    try {
      context.watcher = docs.watch((area) => {
        if (area === "git") {
          this.emit({ type: "docs.changed", workspaceId });
          void this.refreshDocRefs(workspaceId).catch((error) => console.error("[workbench] document revision", workspaceId, error));
          return;
        }
        const type = watchedAreas[area];
        if (type) this.emit({ type, workspaceId });
      });
    } catch {}
    this.contexts.set(workspaceId, context);
    return context;
  }

  // ---- docs ----

  /**
   * The documents a session reads and writes: its conversation tree's draft, or the main branch when
   * the session names none. A draft is created on the first write, never for a read.
   */
  private async docsScope(workspaceId: string, sessionId?: string, create = false):
    Promise<{ documents: DocsService; draft?: DocDraft }> {
    const { docs } = await this.context(workspaceId);
    if (!sessionId) return { documents: docs };
    const treeId = await this.sessionTreeResolver?.(sessionId);
    if (!treeId) throw new Error("无法确定会话所属的会话树：" + sessionId + "。桌面未连接时省略 sessionId，直接作用于主分支。");
    const draft = await docs.draft(treeId, create);
    if (!draft) return { documents: docs };
    await docs.syncDraft(draft);
    return { documents: new DocsService(draft.path, await docs.head()), draft };
  }

  async listDocs(workspaceId: string, sessionId?: string): Promise<DocFile[]> {
    return (await this.docsScope(workspaceId, sessionId)).documents.list();
  }

  async readDoc(workspaceId: string, path: string, commit?: string, sessionId?: string): Promise<string> {
    // A referenced revision lives in the shared object database, so the scope does not apply to it.
    if (commit !== undefined) return (await this.context(workspaceId)).docs.read(path, commit);
    return (await this.docsScope(workspaceId, sessionId)).documents.read(path);
  }

  async writeDoc(workspaceId: string, path: string, content: string, sessionId?: string): Promise<void> {
    // Serialized with draft cleanup so a write never lands in a worktree that is being recycled.
    await this.integrate(workspaceId, async () => {
      await (await this.docsScope(workspaceId, sessionId, true)).documents.write(path, content);
      this.emit({ type: "docs.changed", workspaceId });
    });
  }

  async pendingDocChanges(workspaceId: string, sessionId?: string): Promise<DocChange[]> {
    return (await this.docsScope(workspaceId, sessionId)).documents.pendingChanges();
  }

  async docDiff(workspaceId: string, path: string, sessionId?: string): Promise<string> {
    return (await this.docsScope(workspaceId, sessionId)).documents.diff(path);
  }

  async previewDocDiscard(workspaceId: string, paths: string[], sessionId?: string): Promise<DocChange[]> {
    return (await this.docsScope(workspaceId, sessionId)).documents.discardPreview(paths);
  }

  async discardDocs(workspaceId: string, paths: string[], sessionId?: string): Promise<DocChange[]> {
    return this.integrate(workspaceId, async () => {
      const changes = await (await this.docsScope(workspaceId, sessionId)).documents.discard(paths);
      if (changes.length) this.emit({ type: "docs.changed", workspaceId });
      return changes;
    });
  }

  async commitDocs(workspaceId: string, input: { message: string; paths?: string[]; sessionId?: string }): Promise<DocCommit> {
    return this.integrate(workspaceId, () => this.commitDocsRecord(workspaceId, input));
  }

  private async commitDocsRecord(workspaceId: string, input: Parameters<WorkbenchService["commitDocs"]>[1]): Promise<DocCommit> {
    const message = input.message.trim();
    if (!message) throw new Error("Commit message is required.");
    const { docs } = await this.context(workspaceId);
    if (!input.sessionId) {
      const { commit } = await this.commitDocChanges(docs, message, input.paths);
      await this.moveDocRefs(workspaceId, { commit });
      this.emit({ type: "docs.changed", workspaceId });
      return { commit, message };
    }
    const { documents, draft } = await this.docsScope(workspaceId, input.sessionId, true);
    if (!draft) throw new Error("无法确定会话所属的会话树：" + input.sessionId);
    if (input.paths?.length === 0) throw new Error("Select at least one doc path to commit.");
    const authored = await documents.editedChanges();
    const pending = await documents.pendingChanges();
    const chosen = (changes: DocChange[]) => input.paths ? changes.filter((change) => input.paths!.includes(change.path)) : changes;
    let paths: string[] | undefined;
    if (await documents.rebaseInProgress(draft.path)) {
      // A draft that carried its own commits across a conflict is finished by continuing that rebase.
      const files = await documents.continueDraftRebase(draft.path, message);
      if (files.length) throw new DocDraftConflict(files);
    } else if (chosen(authored).length) {
      paths = (await this.commitDocChanges(documents, message, chosen(authored).map((change) => change.path))).paths;
    } else if (input.paths && !chosen(pending).length) {
      // The selection names nothing this draft holds; publishing its other files would ignore the caller.
      throw new Error("No pending doc changes to commit.");
    } else if (!await docs.draftAhead(draft)) {
      throw new Error("No pending doc changes to commit.");
    }
    const { commit } = await docs.mergeDraft(draft, message);
    const head = commit ?? await docs.head();
    if (!head) throw new Error("文档提交未进入主分支：" + message);
    await this.moveDocRefs(workspaceId, { commit: head, paths, originatorSessionId: input.sessionId });
    this.emit({ type: "docs.changed", workspaceId });
    return { commit: head, message };
  }

  /** Rebase this session's draft onto the main branch; a conflict stays in the draft as markers. */
  async rebaseDocDraft(workspaceId: string, sessionId: string): Promise<{ files: string[] }> {
    const { docs } = await this.context(workspaceId);
    const { draft } = await this.docsScope(workspaceId, sessionId, true);
    if (!draft) throw new Error("无法确定会话所属的会话树：" + sessionId);
    return { files: await docs.rebaseDraft(draft) };
  }

  async refreshDocRefs(workspaceId: string): Promise<void> {
    return this.integrate(workspaceId, () => this.refreshDocRefsRecord(workspaceId));
  }

  private async refreshDocRefsRecord(workspaceId: string): Promise<void> {
    const { docs } = await this.context(workspaceId);
    const head = await docs.head();
    if (!head) return;
    await this.moveDocRefs(workspaceId, { commit: head });
  }

  /**
   * Follow the referenced documents to a new commit, but only where the referenced part moved.
   * The worker that committed the documents itself reads its own change, so it gets no notice.
   */
  private async moveDocRefs(workspaceId: string, input: { commit: string; paths?: string[]; originatorSessionId?: string }): Promise<void> {
    const { docs } = await this.context(workspaceId);
    for (const item of await this.listWorkItems(workspaceId)) {
      if (["closed", "cancelled"].includes(item.status)) continue;
      const moved: { index: number; path: string; section?: string; diff: string }[] = [];
      for (const [index, ref] of item.refs.entries()) {
        if (ref.commit === input.commit || (input.paths && !input.paths.includes(ref.path))) continue;
        const change = await docs.referenceChange(ref, input.commit);
        if (change.changed && change.diff) moved.push({ index, path: ref.path, section: ref.section, diff: change.diff });
      }
      if (!moved.length) continue;
      const movedIndexes = new Set(moved.map((entry) => entry.index));
      const sessionId = item.run.sessionId;
      const notify = !!sessionId && sessionId !== input.originatorSessionId;
      await this.mutateRecord(workspaceId, item.workItemId, (record) => {
        const now = this.now();
        return { ...record,
          item: { ...record.item,
            refs: record.item.refs.map((ref, index) => movedIndexes.has(index) ? { ...ref, commit: input.commit } : ref),
            contractRevision: record.item.contractRevision + 1, updatedAt: now },
          execution: { ...record.execution, updatedAt: now,
            notices: notify ? [...record.execution.notices, pendingNotice("docs",
              "引用文档已提交 " + input.commit + "\n" + moved.map((entry) => entry.diff).join("\n") + "\n" + rereadContract, now)] : record.execution.notices,
            history: [...record.execution.history, { at: now, event: "docs.updated", message: "引用文档已提交 " + input.commit + "：" + moved.map((entry) => entry.path + (entry.section ? "#" + entry.section : "")).join("、") }] }
        };
      });
      if (notify && sessionId) this.emit({ type: "workItem.updated", workspaceId, workItemId: item.workItemId, sessionId });
    }
  }

  private async validateWorkItemRefs(workspaceId: string, refs: WorkItem["refs"]): Promise<WorkItem["refs"]> {
    const { docs } = await this.context(workspaceId);
    return Promise.all(refs.map(async (ref) => {
      try { return await docs.validateReference(ref); }
      catch (error) {
        throw new Error(`引用 ${ref.path}${ref.section ? "#" + ref.section : ""} 无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  async invalidWorkItemRefs(workspaceId: string, workItemId: string): Promise<Array<{ path: string; section?: string; commit: string; reason: string }>> {
    const [item, context] = await Promise.all([this.getWorkItem(workspaceId, workItemId), this.context(workspaceId)]);
    const inspected = await Promise.all(item.refs.map(async (ref) => ({ ref, reason: await context.docs.referenceProblem(ref) })));
    return inspected.flatMap(({ ref, reason }) => reason ? [{ path: ref.path, section: ref.section, commit: ref.commit, reason }] : []);
  }

  // ---- sessions ----

  async startApp(input: AppStartInput): Promise<AppStartResult> {
    if (!this.launcher) throw new Error("app.start is only available while the desktop is running");
    return this.launcher.start(input);
  }

  async stopApp(input: AppStopInput): Promise<AppStopResult> {
    if (!this.launcher) throw new Error("app.stop is only available while the desktop is running");
    return this.launcher.stop(input);
  }

  async controlAppWindow(input: AppWindowInput): Promise<AppWindowResult> {
    if (this.appWindowController) return this.appWindowController(input);
    throw new Error("app.window is only available through a running desktop instance");
  }

  // ---- roles ----

  async listRoles(workspaceId: string): Promise<RoleFile[]> {
    return this.roles.list((await this.context(workspaceId)).rootPath);
  }

  async readRole(workspaceId: string, roleId: string): Promise<{ content: string; source: RoleFile["source"] }> {
    return this.roles.read((await this.context(workspaceId)).rootPath, roleId);
  }

  async readRoleEditor(workspaceId: string, roleId: string) {
    const rootPath = (await this.context(workspaceId)).rootPath;
    const role = await this.roles.read(rootPath, roleId);
    const globalContent = await this.roles.readGlobal(roleId);
    return { ...role, ...(globalContent === undefined ? {} : { globalContent }) };
  }

  async resolveRole(workspaceId: string, roleId: string) {
    return this.roles.resolve((await this.context(workspaceId)).rootPath, roleId);
  }

  async resolveWorkerRole(workspaceId: string, engineId = "codex") {
    const root = (await this.context(workspaceId)).rootPath;
    const [worker, reviewer, verifier] = await Promise.all(
      ["worker", "reviewer", "verifier"].map((role) => this.roles.resolve(root, role))
    );
    const roleBlock = (role: "reviewer" | "verifier", resolved: typeof reviewer): string => [
      `## ${role} subagent prompt（spawn 时原样传入，并附工单与 diff）`,
      resolved.content,
      `## ${role} subagent model configuration（JSON；仅用于核对）`,
      JSON.stringify(resolved.modelConfig ?? {}),
      `## ${role} ${subagentToolLabel(engineId)}`,
      JSON.stringify(subagentArguments(resolved.modelConfig, engineId))
    ].join("\n");
    return { ...worker, content: [worker.content, roleBlock("reviewer", reviewer), roleBlock("verifier", verifier)].join("\n\n") };
  }

  async resolveSessionInstructions(workspaceId: string, metadata: Record<string, unknown>): Promise<string> {
    const role = typeof metadata.role === "string" ? metadata.role : "design-partner";
    const engineId =
      typeof metadata.engineId === "string" && metadata.engineId
        ? metadata.engineId
        : "codex";
    if (role === "worker") return (await this.resolveWorkerRole(workspaceId, engineId)).content;
    if (role === "maintainer" && typeof metadata.domainId === "string") {
      return (await this.resolveMaintainer(workspaceId, metadata.domainId)).content;
    }
    const resolved = await this.resolveRole(workspaceId, "design-partner");
    return resolved.content + "\n\n当前 workspaceId: " + workspaceId
      + "\n工作台 CLI: vermillion <method> [json]（PATH 中可用）\n";
  }

  async writeRoleOverride(workspaceId: string, roleId: string, content: string): Promise<void> {
    await this.roles.writeOverride((await this.context(workspaceId)).rootPath, roleId, content);
    this.emit({ type: "roles.changed", workspaceId });
  }

  async resetRoleOverride(workspaceId: string, roleId: string): Promise<void> {
    await this.roles.removeOverride((await this.context(workspaceId)).rootPath, roleId);
    this.emit({ type: "roles.changed", workspaceId });
  }

  // ---- domains and owner patrols ----

  private async ensureDomainConfig(workspaceId: string, domainId: string): Promise<DomainConfig> {
    const { store, docs } = await this.context(workspaceId);
    const existing = await store.domainConfigs.get(domainId);
    if (existing) return existing;
    const config = defaultDomainConfig(domainId, this.now(), await docs.head());
    return store.transactDomainConfig(domainId, (current) => ({ record: current ?? config, result: current ?? config }));
  }

  async listDomains(workspaceId: string): Promise<DomainDefinition[]> {
    const { docs } = await this.context(workspaceId);
    const paths = await docs.listDirectMarkdown(DOMAINS_DIR.slice(0, -1));
    const domains = await Promise.all(paths.map(async (path) => {
      const domainId = domainIdFromPath(path)!;
      return parseDomainDefinition(path, await docs.read(path), await this.ensureDomainConfig(workspaceId, domainId));
    }));
    return domains.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getDomainConfig(workspaceId: string, domainId: string): Promise<DomainConfig> {
    if (!(await this.listDomains(workspaceId)).some((domain) => domain.domainId === domainId)) throw new Error("Unknown domain: " + domainId);
    return this.ensureDomainConfig(workspaceId, domainId);
  }

  async setDomainConfig(workspaceId: string, domainId: string, input: DomainConfigInput): Promise<DomainConfig> {
    const current = await this.getDomainConfig(workspaceId, domainId);
    const now = this.now();
    const saved = await (await this.context(workspaceId)).store.transactDomainConfig(domainId, (record) => {
      if (!record) throw new Error("Unknown domain config: " + domainId);
      const config: DomainConfig = { ...record, ...input,
        triggerPaths: [...new Set(input.triggerPaths.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean))],
        authorizationScope: [...new Set(input.authorizationScope.map((entry) => entry.trim()).filter(Boolean))],
        nextRunAt: input.intervalHours === current.intervalHours ? record.nextRunAt : nextRunAt(now, input.intervalHours),
        updatedAt: now };
      return { record: config, result: config };
    });
    this.emit({ type: "domains.changed", workspaceId });
    return saved;
  }

  async readMaintainerInstruction(workspaceId: string, domainId: string): Promise<string> {
    await this.getDomainConfig(workspaceId, domainId);
    return this.roles.readMaintainerInstruction((await this.context(workspaceId)).rootPath, domainId);
  }

  async writeMaintainerInstruction(workspaceId: string, domainId: string, content: string): Promise<void> {
    await this.getDomainConfig(workspaceId, domainId);
    await this.roles.writeMaintainerInstruction((await this.context(workspaceId)).rootPath, domainId, content);
    this.emit({ type: "domains.changed", workspaceId });
  }

  /** Drops the definition, the patrol instruction and the patrol configuration; history stays queryable. */
  async removeDomain(workspaceId: string, domainId: string): Promise<void> {
    const context = await this.context(workspaceId);
    const domain = (await this.listDomains(workspaceId)).find((entry) => entry.domainId === domainId);
    if (!domain) throw new Error("Unknown domain: " + domainId);
    await context.docs.remove(domain.path);
    await this.roles.removeMaintainerInstruction(context.rootPath, domainId);
    await context.store.domainConfigs.remove(domainId);
    this.emit({ type: "domains.changed", workspaceId });
  }

  async resolveMaintainer(workspaceId: string, domainId: string) {
    await this.getDomainConfig(workspaceId, domainId);
    return this.roles.resolveMaintainer((await this.context(workspaceId)).rootPath, domainId);
  }

  async listPatrolRuns(workspaceId: string): Promise<PatrolRun[]> {
    return (await this.context(workspaceId)).store.patrolRuns.list().then((runs) => runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }

  async getPatrolRun(workspaceId: string, patrolRunId: string): Promise<PatrolRun> {
    const run = await (await this.context(workspaceId)).store.patrolRuns.get(patrolRunId);
    if (!run) throw new Error("Unknown patrol run: " + patrolRunId);
    return run;
  }

  private async createPatrolRun(workspaceId: string, domain: DomainDefinition, trigger: PatrolRun["trigger"], changedPaths: string[], targetCommit: string, knownRuns?: PatrolRun[]): Promise<PatrolRun> {
    const { store, docs } = await this.context(workspaceId);
    const active = (knownRuns ?? await store.patrolRuns.list()).find((run) => run.domainId === domain.domainId && ["queued", "running"].includes(run.status));
    if (active) throw new Error(`领域 ${domain.title} 已有巡检等待或运行中：${active.patrolRunId}`);
    await Promise.all([domain.path, ...domain.standards].map((path) => docs.read(path, targetCommit)));
    const now = this.now();
    const run: PatrolRun = {
      patrolRunId: createId("patrol"), domainId: domain.domainId, trigger, status: "queued", changedPaths,
      requirementRefs: [domain.path, ...domain.standards].map((path) => ({ path, commit: targetCommit })),
      targetCommit, issueIds: [], workItemIds: [], startedAt: now, updatedAt: now
    };
    const saved = await store.transactPatrolRun(run.patrolRunId, (current) => {
      if (current) throw new Error("Patrol run already exists: " + run.patrolRunId);
      return { record: run, result: run };
    });
    this.emit({ type: "domains.changed", workspaceId });
    return saved;
  }

  async queuePatrol(workspaceId: string, domainId: string): Promise<PatrolRun> {
    return this.serializePatrol(workspaceId, () => this.queuePatrolRecord(workspaceId, domainId));
  }

  private async queuePatrolRecord(workspaceId: string, domainId: string): Promise<PatrolRun> {
    const domain = (await this.listDomains(workspaceId)).find((entry) => entry.domainId === domainId);
    if (!domain) throw new Error("Unknown domain: " + domainId);
    const { docs } = await this.context(workspaceId);
    const head = await docs.head();
    if (!head) throw new Error("领域巡检需要已提交的领域定义和检查依据。");
    const changed = await docs.changedPaths(domain.config.lastCommit, head);
    return this.createPatrolRun(workspaceId, domain, "manual", changed, head);
  }

  private async advanceDomainAfterPatrol(workspaceId: string, run: PatrolRun): Promise<void> {
    const now = this.now();
    await (await this.context(workspaceId)).store.transactDomainConfig(run.domainId, (current) => {
      if (!current) throw new Error("Unknown domain config: " + run.domainId);
      const config: DomainConfig = { ...current, ...(run.targetCommit ? { lastCommit: run.targetCommit } : {}),
        retryAt: undefined, nextRunAt: nextRunAt(now, current.intervalHours), updatedAt: now };
      return { record: config, result: undefined };
    });
  }

  async scanPatrols(workspaceId: string): Promise<PatrolRun[]> {
    return this.serializePatrol(workspaceId, () => this.scanPatrolRecords(workspaceId));
  }

  private async scanPatrolRecords(workspaceId: string): Promise<PatrolRun[]> {
    const domains = await this.listDomains(workspaceId);
    const { docs, store } = await this.context(workspaceId);
    const head = await docs.head();
    if (!head) return [];
    const [patrolRuns, issues] = await Promise.all([store.patrolRuns.list(), store.issues.list()]);
    const created: PatrolRun[] = [];
    for (const domain of domains) {
      const config = domain.config;
      if (!config.enabled || patrolRuns.some((run) => run.domainId === domain.domainId && ["queued", "running"].includes(run.status))) continue;
      if (config.retryAt && Date.parse(config.retryAt) > Date.parse(this.now())) continue;
      let changedPaths: string[] = [];
      try { changedPaths = await docs.changedPaths(config.lastCommit, head); }
      catch { changedPaths = []; }
      const relevant = changedPaths.filter((path) => pathMatches(path, config.triggerPaths));
      if (config.retryAt) {
        const failed = patrolRuns.filter((run) => run.domainId === domain.domainId && run.status === "failed")
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        const run = await this.createPatrolRun(workspaceId, { ...domain, config }, failed?.trigger ?? "scheduled", relevant.length ? relevant : failed?.changedPaths ?? [], head, patrolRuns);
        patrolRuns.push(run); created.push(run);
        continue;
      }
      if (config.changeTrigger && relevant.length) {
        const run = await this.createPatrolRun(workspaceId, { ...domain, config }, "change", relevant, head, patrolRuns);
        patrolRuns.push(run); created.push(run);
        continue;
      }
      if (Date.parse(config.nextRunAt) > Date.parse(this.now())) continue;
      const investigating = issues.some((issue) => issue.domainId === domain.domainId && issue.status === "investigating");
      if (relevant.length || investigating) {
        const run = await this.createPatrolRun(workspaceId, { ...domain, config }, "scheduled", relevant, head, patrolRuns);
        patrolRuns.push(run); created.push(run);
        continue;
      }
      const now = this.now();
      const skipped: PatrolRun = { patrolRunId: createId("patrol"), domainId: domain.domainId, trigger: "scheduled", status: "skipped",
        changedPaths: [], requirementRefs: [domain.path, ...domain.standards].map((path) => ({ path, commit: head ?? "HEAD" })), targetCommit: head,
        issueIds: [], workItemIds: [], summary: "无新变更或待复查问题，跳过。", startedAt: now, updatedAt: now, endedAt: now };
      await store.patrolRuns.put(skipped);
      await this.advanceDomainAfterPatrol(workspaceId, skipped);
      created.push(skipped);
      this.emit({ type: "domains.changed", workspaceId });
    }
    return created;
  }

  async startPatrolRun(workspaceId: string, patrolRunId: string, sessionId: string): Promise<PatrolRun> {
    const now = this.now();
    const saved = await (await this.context(workspaceId)).store.transactPatrolRun(patrolRunId, (current) => {
      if (!current || !["queued", "running"].includes(current.status)) throw new Error("Patrol run cannot start: " + patrolRunId);
      if (current.sessionId && current.sessionId !== sessionId) throw new Error("Patrol run belongs to another session: " + current.sessionId);
      const run: PatrolRun = { ...current, status: "running", sessionId, updatedAt: now };
      return { record: run, result: run };
    });
    this.emit({ type: "domains.changed", workspaceId });
    return saved;
  }

  async setPatrolTurn(workspaceId: string, patrolRunId: string, turnId: string | undefined): Promise<PatrolRun> {
    if (!turnId) return this.getPatrolRun(workspaceId, patrolRunId);
    return (await this.context(workspaceId)).store.transactPatrolRun(patrolRunId, (current) => {
      if (!current) throw new Error("Unknown patrol run: " + patrolRunId);
      const run = { ...current, turnId, updatedAt: this.now() };
      return { record: run, result: run };
    });
  }

  async completePatrolRun(workspaceId: string, patrolRunId: string, sessionId: string, issueIds: string[], summary: string): Promise<PatrolRun> {
    const current = await this.getPatrolRun(workspaceId, patrolRunId);
    if (current.status !== "running" || current.sessionId !== sessionId) throw new Error("只有当前巡检会话能完成该记录。");
    const issues = await Promise.all([...new Set(issueIds)].map((issueId) => this.getIssue(workspaceId, issueId)));
    if (issues.some((issue) => issue.domainId !== current.domainId)) throw new Error("巡检只能关联当前领域的 Issue。");
    const now = this.now();
    for (const issue of issues) await (await this.context(workspaceId)).store.transactIssue(issue.issueId, (record) => {
      if (!record) throw new Error("Unknown issue: " + issue.issueId);
      return { record: { ...record, activities: [...record.activities, { at: now, kind: "updated", message: "关联领域巡检", sessionId }], updatedAt: now }, result: undefined };
    });
    const saved = await (await this.context(workspaceId)).store.transactPatrolRun(patrolRunId, (record) => {
      if (!record) throw new Error("Unknown patrol run: " + patrolRunId);
      const run: PatrolRun = { ...record, status: "completed", issueIds: issues.map((issue) => issue.issueId), summary: summary.trim(), updatedAt: now, endedAt: now };
      return { record: run, result: run };
    });
    await this.advanceDomainAfterPatrol(workspaceId, saved);
    this.emit({ type: "issues.changed", workspaceId });
    this.emit({ type: "domains.changed", workspaceId });
    return saved;
  }

  async failPatrolRun(workspaceId: string, patrolRunId: string, reason: string): Promise<PatrolRun> {
    const now = this.now();
    const saved = await (await this.context(workspaceId)).store.transactPatrolRun(patrolRunId, (current) => {
      if (!current) throw new Error("Unknown patrol run: " + patrolRunId);
      if (!["queued", "running"].includes(current.status)) return { record: current, result: current };
      const run: PatrolRun = { ...current, status: "failed", summary: reason, updatedAt: now, endedAt: now };
      return { record: run, result: run };
    });
    await (await this.context(workspaceId)).store.transactDomainConfig(saved.domainId, (current) => {
      if (!current) throw new Error("Unknown domain config: " + saved.domainId);
      const config: DomainConfig = { ...current, retryAt: new Date(Date.parse(now) + 60_000).toISOString(), updatedAt: now };
      return { record: config, result: undefined };
    });
    this.emit({ type: "domains.changed", workspaceId });
    return saved;
  }

  async patrolMessage(workspaceId: string, patrolRunId: string): Promise<string> {
    const run = await this.getPatrolRun(workspaceId, patrolRunId);
    const domain = (await this.listDomains(workspaceId)).find((entry) => entry.domainId === run.domainId);
    if (!domain) throw new Error("Unknown domain: " + run.domainId);
    const issues = (await this.listIssues(workspaceId)).filter((issue) => issue.domainId === run.domainId);
    return [
      `执行 ${domain.title} 领域巡检。`,
      `workspaceId: ${workspaceId}\npatrolRunId: ${run.patrolRunId}\nsessionId: ${run.sessionId ?? "<由运行时填写>"}\n触发: ${run.trigger}`,
      `本轮变化:\n${run.changedPaths.length ? run.changedPaths.map((path) => "- " + path).join("\n") : "- 无新增路径，复查调查中的 Issue。"}`,
      `检查依据:\n${run.requirementRefs.map((ref) => `- ${ref.path} @ ${ref.commit}`).join("\n")}`,
      `当前自动开单: ${domain.config.autoWorkEnabled ? "启用" : "关闭"}\n授权范围:\n${domain.config.authorizationScope.length ? domain.config.authorizationScope.map((entry) => "- " + entry).join("\n") : "- 未授权"}`,
      `已有 Issue 摘要:\n${issues.length ? issues.map((issue) => `- ${issue.issueId} [${issue.status}] ${issue.title}`).join("\n") : "- 无"}`,
      `先通过 docs.read、issue.list / issue.get 核对材料。新问题用 issue.create，并传 source=maintainer、patrolRunId=${run.patrolRunId}；已有 Issue 用 issue.update 补充证据，同样传 patrolRunId=${run.patrolRunId}，让记录回链到本轮巡检会话。证据不足标为 investigating，需要取舍标为 decision 并提供 decisionQuestion，优化想法使用 suggestion 类型。`,
      "只有满足领域授权时才调用 domain.issue.workItem.create；该入口会再次核对巡检会话、授权、固定要求引用和证据。不要直接修改代码、文档或规范。",
      `完成后必须调用：vermillion domain.patrol.complete '${JSON.stringify({ workspaceId, patrolRunId: run.patrolRunId, sessionId: run.sessionId ?? "<sessionId>", issueIds: ["<issueId>"], summary: "<本轮结果>" })}'。没有 Issue 时传空数组。`
    ].join("\n\n");
  }

  // ---- issues ----

  async listIssues(workspaceId: string, filter: { domainId?: string; status?: Issue["status"] } = {}): Promise<Issue[]> {
    const issues = await (await this.context(workspaceId)).store.issues.list();
    return issues
      .filter((issue) => (!filter.domainId || issue.domainId === filter.domainId) && (!filter.status || issue.status === filter.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getIssue(workspaceId: string, issueId: string): Promise<Issue> {
    const issue = await (await this.context(workspaceId)).store.issues.get(issueId);
    if (!issue) throw new Error("Unknown issue: " + issueId);
    return issue;
  }

  async createIssue(workspaceId: string, input: IssueCreateInput): Promise<Issue> {
    const now = this.now();
    const source = input.source ?? "user";
    const patrol = input.patrolRunId ? await this.getPatrolRun(workspaceId, input.patrolRunId) : undefined;
    const issue: Issue = {
      issueId: createId("issue"), title: input.title.trim(), summary: input.summary, domainId: input.domainId.trim(),
      source, type: input.type ?? "problem", status: input.status ?? "open", requirement: input.requirement,
      evidence: input.evidence ?? [], suggestion: input.suggestion, decisionQuestion: input.decisionQuestion,
      sourceSessionId: patrol?.sessionId, sourceTurnId: patrol?.turnId, workItemIds: [], unread: source !== "user",
      activities: [{ at: now, kind: "created", message: source === "user" ? "用户创建 Issue" : source === "maintainer" ? "Maintainer 创建 Issue" : "Liaison 创建 Issue", sessionId: patrol?.sessionId }],
      createdAt: now, updatedAt: now
    };
    this.validateIssue(issue);
    const saved = await (await this.context(workspaceId)).store.transactIssue(issue.issueId, (current) => {
      if (current) throw new Error("Issue already exists: " + issue.issueId);
      return { record: issue, result: issue };
    });
    this.emit({ type: "issues.changed", workspaceId });
    return saved;
  }

  async updateIssue(workspaceId: string, issueId: string, changes: IssueUpdateInput): Promise<Issue> {
    if (changes.duplicateOf === issueId) throw new Error("Issue 不能标记为自身的重复项。");
    if (changes.duplicateOf) await this.getIssue(workspaceId, changes.duplicateOf);
    const now = this.now();
    const patrol = changes.patrolRunId ? await this.getPatrolRun(workspaceId, changes.patrolRunId) : undefined;
    const saved = await (await this.context(workspaceId)).store.transactIssue(issueId, (current) => {
      if (!current) throw new Error("Unknown issue: " + issueId);
      const { appendEvidence = [], patrolRunId: _patrolRunId, ...fields } = changes;
      const status = fields.status ?? current.status;
      const message = appendEvidence.length ? `补充 ${appendEvidence.length} 条证据` : status !== current.status ? `状态变为 ${issueStatusText[status]}` : "更新 Issue";
      const issue: Issue = { ...current, ...fields,
        evidence: [...current.evidence, ...appendEvidence],
        activities: [...current.activities, { at: now, kind: appendEvidence.length ? "evidence" : status === "closed" || status === "duplicate" ? "resolved" : "updated", message,
          issueId: fields.duplicateOf, sessionId: patrol?.sessionId }], updatedAt: now };
      this.validateIssue(issue);
      return { record: issue, result: issue };
    });
    this.emit({ type: "issues.changed", workspaceId });
    return saved;
  }

  async readIssue(workspaceId: string, issueId: string): Promise<Issue> {
    const saved = await (await this.context(workspaceId)).store.transactIssue(issueId, (current) => {
      if (!current) throw new Error("Unknown issue: " + issueId);
      const issue = current.unread ? { ...current, unread: false } : current;
      return { record: issue, result: issue };
    });
    if (!saved.unread) this.emit({ type: "issues.changed", workspaceId });
    return saved;
  }

  async discussIssue(workspaceId: string, issueId: string): Promise<Issue> {
    return this.integrate(workspaceId, async () => {
      const current = await this.getIssue(workspaceId, issueId);
      if (current.discussionSessionId) return current;
      if (!this.issueDiscussionStarter) throw new Error("issue.discuss requires a running desktop instance.");
      const result = await this.issueDiscussionStarter({ workspaceId, issueId, title: current.title,
        content: [
          `请围绕 Issue ${current.issueId} 与用户讨论，明确预期和处理范围。`,
          `标题：${current.title}`, `问题与影响：${current.summary}`,
          current.decisionQuestion && `需要用户决定：${current.decisionQuestion}`,
          current.requirement && `要求依据：${[current.requirement.text, current.requirement.path, current.requirement.section, current.requirement.commit && "commit: " + current.requirement.commit].filter(Boolean).join("\n")}`,
          current.evidence.length && `证据：\n${current.evidence.map((entry) => `- ${entry.kind}：${entry.text}${entry.path ? "\n  " + entry.path : ""}`).join("\n")}`,
          current.suggestion && `建议方向：${current.suggestion}`,
          "如果用户决定开工，沿正常 work.start 流程创建工单；工作台会按本讨论会话自动关联此 Issue。"
        ].filter(Boolean).join("\n\n") });
      const now = this.now();
      const saved = await (await this.context(workspaceId)).store.transactIssue(issueId, (record) => {
        if (!record) throw new Error("Unknown issue: " + issueId);
        const issue: Issue = { ...record, discussionSessionId: result.sessionId, discussionTurnId: result.turnId,
          unread: false, activities: [...record.activities, { at: now, kind: "discussion", message: "创建设计讨论会话", sessionId: result.sessionId }], updatedAt: now };
        return { record: issue, result: issue };
      });
      this.emit({ type: "issues.changed", workspaceId });
      return saved;
    });
  }

  private validateIssue(issue: Issue): void {
    if (issue.status === "started" && !issue.workItemIds.length) throw new Error("已开工 Issue 必须关联实际工单。");
    if (issue.status === "decision" && !issue.decisionQuestion) throw new Error("待决策 Issue 必须提供具体决策问题。");
    if (issue.status === "closed" && !issue.resolutionReason) throw new Error("关闭 Issue 必须提供处理原因。");
    if (issue.status === "duplicate" && (!issue.duplicateOf || !issue.resolutionReason)) throw new Error("重复 Issue 必须提供原 Issue 和处理原因。");
  }

  /** Commit the worktree edits a scope still holds; a scope whose work is already committed has none. */
  private async commitDocChanges(docs: DocsService, message: string, paths: string[] | undefined) {
    if (paths?.length === 0) throw new Error("Select at least one doc path to commit.");
    const pending = await docs.editedChanges();
    const selected = paths ? pending.filter((c) => paths.includes(c.path)) : pending;
    if (selected.length === 0) throw new Error("No pending doc changes to commit.");
    const selectedPaths = selected.map((c) => c.path);
    const commit = await docs.commit(message, selectedPaths);
    return { commit, message, paths: selectedPaths };
  }

  async listWorkItems(workspaceId: string): Promise<WorkItem[]> {
    const list = (await (await this.context(workspaceId)).store.listRecords()).map((record) => this.projectExecutionItem(record));
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async search(input: SearchQuery): Promise<SearchResult> {
    return searchWorkbench({
      query: input,
      workspaces: await this.listWorkspaces(),
      listWorkItems: (workspaceId) => this.listWorkItems(workspaceId),
      listDocs: (workspaceId) => this.listDocs(workspaceId),
      readDoc: (workspaceId, path) => this.readDoc(workspaceId, path),
      sessionSearch: this.sessionSearch,
      rolloutsDir: this.rolloutsDir
    });
  }

  /**
   * Starts a streaming search and returns right away. Hits arrive as `search.hits` events and the
   * scan reports `search.completed`. Only one streaming search runs at a time: starting another one
   * stops the previous scan, so a superseded keystroke never holds up the current query.
   */
  startSearch(input: SearchQuery): { queryId: string } {
    this.activeSearch?.controller.abort();
    const queryId = createId("search");
    const controller = new AbortController();
    this.activeSearch = { queryId, controller };
    void this.streamSearch(queryId, input, controller.signal);
    return { queryId };
  }

  cancelSearch(queryId: string): { cancelled: boolean } {
    if (this.activeSearch?.queryId !== queryId) return { cancelled: false };
    this.activeSearch.controller.abort();
    this.activeSearch = undefined;
    return { cancelled: true };
  }

  private async streamSearch(queryId: string, input: SearchQuery, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    try {
      const result = await searchWorkbench({
        query: input,
        workspaces: await this.listWorkspaces(),
        listWorkItems: (workspaceId) => this.listWorkItems(workspaceId),
        listDocs: (workspaceId) => this.listDocs(workspaceId),
        readDoc: (workspaceId, path) => this.readDoc(workspaceId, path),
        sessionSearch: this.sessionSearch,
        rolloutsDir: this.rolloutsDir,
        signal,
        onHits: (hits) => {
          if (!signal.aborted) this.emit({ type: "search.hits", queryId, hits });
        }
      });
      if (signal.aborted) return;
      this.emit({ type: "search.completed", queryId, stats: result.stats });
    } catch (error) {
      if (signal.aborted) return;
      this.emit({
        type: "search.completed",
        queryId,
        stats: { sourcesScanned: 0, bytesScanned: 0, durationMs: Math.max(0, Date.now() - started), truncated: false },
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (this.activeSearch?.queryId === queryId) this.activeSearch = undefined;
    }
  }

  async askSource(workspaceId: string, workItemId: string, sessionId: string, question: string): Promise<SourceAskResult> {
    if (!question.trim()) throw new Error("asksource question is required.");
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status !== "running" || item.run.sessionId !== sessionId) {
      throw new Error("asksource 只允许当前 Worker 在执行中的工单调用：" + workItemId);
    }
    if (!item.sourceSessionId || !item.sourceTurnId) {
      throw new Error("工单没有有效的开单来源位置：" + workItemId);
    }
    if (!this.sourceAsker) {
      throw new Error("asksource requires a running desktop instance.");
    }
    return this.sourceAsker({
      workspaceId,
      workItemId,
      sourceSessionId: item.sourceSessionId,
      sourceTurnId: item.sourceTurnId,
      question: question.trim()
    });
  }

  async steerSession(sessionId: string, content: string): Promise<Omit<SessionDispatchReceipt, "delivery"> & SessionSteerResult & { delivery: "steered" | "started" | "queued" }> {
    if (!content.trim()) throw new Error("steer content is required.");
    if (!this.sessionSteerer) {
      throw new Error("steer requires a running desktop instance.");
    }
    const result = await this.dispatchSessionMessage({ sessionId, content: content.trim(), messageId: createId("message") },
      async (message) => {
        const result = await this.sessionSteerer!(message);
        return { accepted: result.accepted ?? (!result.queued && result.delivery !== "queued"), error: result.error, turnId: result.turnId, queued: result.queued,
          delivery: result.delivery === "queued" ? undefined : result.delivery };
      });
    return { ...result, sessionId, delivery: result.queued ? "queued" : result.delivery ?? "started" };
  }

  async startWork(workspaceId: string, input: { sessionId: string; turnId?: string; scope?: string; message?: WorkRequest["message"] }): Promise<WorkRequest> {
    if (!input.turnId && !this.sourceTurnResolver) throw new Error("需要有效 turnId；省略时必须连接桌面解析当前会话节点。");
    const turnId = input.turnId ?? await this.sourceTurnResolver?.(input.sessionId);
    if (!turnId && !input.message?.content.trim() && !input.message?.attachments?.length) throw new Error("空会话需要提供开工内容。");
    return this.putWorkRequest(workspaceId, { requestId: createId("work"), sourceSessionId: input.sessionId,
      sourceTurnId: turnId, message: input.message, scope: input.scope, status: "pending", control: "auto",
      createdAt: this.now(), updatedAt: this.now() });
  }

  async listWorkRequests(workspaceId: string): Promise<WorkRequest[]> {
    const [requests, items] = await Promise.all([
      (await this.context(workspaceId)).store.workRequests.list(), this.listWorkItems(workspaceId)
    ]);
    return requests.map((request) => ({ ...request,
      turnStatus: this.inspectedTurnStatus(request.workerSessionId, request.activeTurnId),
      workItemIds: items.filter((item) => item.requestId === request.requestId).map((item) => item.workItemId)
    }));
  }

  async diagnoseWork(workspaceId: string, requestId: string): Promise<WorkDiagnosis> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("Unknown work request: " + requestId);
    const workItems = (await this.listWorkItems(workspaceId)).filter((item) => item.requestId === requestId);
    const scheduler = await this.getScheduler(workspaceId);
    const waiting = [request.waitReason, request.failure, request.retryAt ? "下次自动重试：" + request.retryAt : undefined].filter((value): value is string => Boolean(value));
    if (request.turnStatus === "unknown") waiting.push("执行轮次状态等待确认");
    if (!scheduler.enabled && !["ready", "cancelled"].includes(request.status)) waiting.push("自动推进已关闭");
    const availableActions = [{ method: "work.diagnose", condition: "随时查询当前工作。" }];
    if (request.pendingMessageId || request.activeTurnId) availableActions.push({ method: "work.confirm", condition: "核对引擎实际消息/轮次后再继续。" });
    if (request.control === "paused") availableActions.push({ method: "work.resume", condition: "恢复当前工作的自动推进。" });
    else if (request.status !== "ready" && request.status !== "cancelled") availableActions.push({ method: "work.pause", condition: "暂停准备、重试和后续自动推进。" });
    if (request.status === "failed") availableActions.push({ method: "work.retry", condition: "确认故障已处理后重新开始。" });
    if (request.status !== "cancelled") availableActions.push({ method: "work.cancel", condition: "取消当前准备及尚未结束的关联工单。" });
    return { request, workItems, scheduler, waiting, availableActions };
  }

  async putWorkRequest(workspaceId: string, request: WorkRequest): Promise<WorkRequest> {
    const store = (await this.context(workspaceId)).store;
    const saved = await store.transactWorkRequest(request.requestId, (current) => {
      const record = current?.status === "cancelled" && request.status !== "cancelled" ? current : { ...request, updatedAt: this.now() };
      return { record, result: record };
    });
    this.emit({ type: "workRequests.changed", workspaceId });
    return saved;
  }

  async updateWorkRequest(workspaceId: string, requestId: string, update: (current: WorkRequest) => WorkRequest): Promise<WorkRequest> {
    const store = (await this.context(workspaceId)).store;
    const saved = await store.transactWorkRequest(requestId, (current) => {
      if (!current) throw new Error("Unknown work request: " + requestId);
      const record = { ...update(current), updatedAt: this.now() };
      return { record, result: record };
    });
    this.emit({ type: "workRequests.changed", workspaceId });
    return saved;
  }

  async retryWork(workspaceId: string, requestId: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || !(request.status === "failed" || (["pending", "preparing"].includes(request.status) && request.retryAt)))
      throw new Error("只有失败或等待重试的开工请求可以重试。");
    if (request.pendingMessageId) throw new Error("消息受理状态不明，请先调用 work.confirm。");
    return this.updateWorkRequest(workspaceId, requestId, (current) => current.status === "cancelled" ? current : ({ ...transitionControl(current, { type: "resume", retry: true, attemptId: createId("attempt") }), status: current.workerSessionId ? "preparing" : "pending" }));
  }

  async pauseWork(workspaceId: string, requestId: string): Promise<WorkRequest> {
    const request = await this.integrate(workspaceId, async () => {
      const current = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
      if (!current || current.status === "cancelled") throw new Error("当前工作不能暂停：" + requestId);
      return this.updateWorkRequest(workspaceId, requestId, (latest) => transitionControl(latest, { type: "pause", reason: "用户已暂停当前工作" }));
    });
    for (const item of (await this.listWorkItems(workspaceId)).filter((entry) => entry.requestId === requestId && !["closed", "cancelled"].includes(entry.status)))
      await this.pauseWorkItem(workspaceId, { workItemId: item.workItemId });
    return request;
  }

  async resumeWork(workspaceId: string, requestId: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || !["paused", "manual"].includes(request.control ?? "")) throw new Error("当前工作不是可恢复状态：" + requestId);
    for (const item of (await this.listWorkItems(workspaceId)).filter((entry) => entry.requestId === requestId && entry.run.control === "paused"))
      await this.resumeWorkItem(workspaceId, item.workItemId);
    return this.updateWorkRequest(workspaceId, requestId, (current) => current.status === "cancelled" ? current : ({ ...transitionControl(current, { type: "resume", attemptId: createId("attempt") }),
      status: current.status === "ready" ? "ready" : current.workerSessionId ? "preparing" : "pending" }));
  }

  async completePreparation(workspaceId: string, input: { requestId: string; sessionId: string; workItemIds: string[]; refs?: WorkItem["refs"] }): Promise<WorkRequest> {
    return this.integrate(workspaceId, () => this.completePreparationRecord(workspaceId, input));
  }

  private async completePreparationRecord(workspaceId: string, input: { requestId: string; sessionId: string; workItemIds: string[]; refs?: WorkItem["refs"] }): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === input.requestId);
    if (!request || request.status !== "preparing" || request.workerSessionId !== input.sessionId)
      throw new Error("准备请求不属于当前准备分支：" + input.requestId);
    const items = (await this.listWorkItems(workspaceId)).filter((item) => item.requestId === input.requestId);
    const actual = new Set(items.map((item) => item.workItemId));
    const declared = new Set(input.workItemIds);
    if (actual.size !== declared.size || [...actual].some((id) => !declared.has(id)))
      throw new Error("准备交接必须登记本请求的完整工单清单。");
    const refs = input.refs ? await this.validateWorkItemRefs(workspaceId, input.refs) : [];
    const saved = await this.updateWorkRequest(workspaceId, input.requestId, (current) => ({ ...current,
      handoff: { sessionId: input.sessionId, workItemIds: [...declared], refs, at: this.now() },
      failure: undefined, waitReason: current.control === "paused" ? current.waitReason : undefined, retryAt: undefined }));
    return saved;
  }

  async holdPreparation(workspaceId: string, requestId: string, reason: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || request.status === "cancelled") return request ?? (() => { throw new Error("Unknown work request: " + requestId); })();
    return this.updateWorkRequest(workspaceId, requestId, (current) => transitionControl(current, { type: "hold", reason }));
  }

  async preparationWithoutHandoff(workspaceId: string, requestId: string): Promise<void> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || request.status === "cancelled" || request.control === "paused") return;
    if (request.control === "manual" || (request.idleTurns ?? 0) >= 1) {
      await this.holdPreparation(workspaceId, requestId, request.control === "manual" ? "等待手动继续" : "缺少交接结果");
    } else await this.updateWorkRequest(workspaceId, requestId, (current) => current.control !== "auto" || current.status === "cancelled" ? current : ({ ...current, idleTurns: 1, activeTurnId: undefined,
      waitReason: "请完成准备交接，调用 work.prepare.complete 登记完整工单与文档依据" }));
  }

  async confirmPreparationDelivery(workspaceId: string, requestId: string, messageId: string, turnId?: string, active = true, expectedSessionId?: string, expectedAttemptId?: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request || request.pendingMessageId !== messageId) return request ?? (() => { throw new Error("Unknown work request: " + requestId); })();
    if ((expectedSessionId && request.workerSessionId !== expectedSessionId) || (expectedAttemptId && request.attemptId !== expectedAttemptId))
      return request;
    const deliveryStore = await this.sessionDeliveries(workspaceId);
    const delivery = await deliveryStore.get(messageId);
    if (!delivery || delivery.sessionId !== request.workerSessionId || delivery.requestId !== requestId || !["sending", "unknown", "accepted"].includes(delivery.state)) return request;
    if (delivery) await deliveryStore.put({ ...delivery, state: "accepted", turnId });
    const latest = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId)!;
    return this.updateWorkRequest(workspaceId, requestId, (current) => current.pendingMessageId !== messageId || current.workerSessionId !== request.workerSessionId ? current : ({ ...current,
      deliveryUncertain: undefined, pendingMessageId: undefined, failure: undefined,
      waitReason: current.control === "paused" ? current.waitReason : undefined,
      ...(turnId ? { activeTurnId: turnId } : {}) }));
  }

  async markPreparationDeliveryUnknown(workspaceId: string, requestId: string, messageId: string, failure: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("Unknown work request: " + requestId);
    return this.updateWorkRequest(workspaceId, requestId, (current) => current.status === "cancelled" || current.pendingMessageId !== messageId ? current : ({ ...current,
      waitReason: "消息受理状态不明，请核对准备分支后再继续",
      failure, deliveryUncertain: true, pendingMessageId: messageId }));
  }

  async confirmWorkRequestDelivery(workspaceId: string, requestId: string): Promise<WorkRequest> {
    await this.reconcileExecutionTurns(workspaceId);
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("Unknown work request: " + requestId);
    if (!request.pendingMessageId) return request;
    if (!this.deliveryConfirmer || !request.workerSessionId) return request;
    const expectedSessionId = request.workerSessionId;
    const expectedAttemptId = request.attemptId;
    const messageId = request.pendingMessageId;
    const result = await this.deliveryConfirmer(expectedSessionId, messageId);
    if (!result.accepted) return request;
    await this.confirmPreparationDelivery(workspaceId, requestId, messageId, result.turnId, result.active !== false, expectedSessionId, expectedAttemptId);
    await this.reconcileExecutionTurns(workspaceId);
    return (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId)!;
  }

  async confirmWorkItemDelivery(workspaceId: string, workItemId: string): Promise<WorkItem> {
    await this.reconcileExecutionTurns(workspaceId);
    const item = await this.getWorkItem(workspaceId, workItemId);
    const action = (await this.listActions(workspaceId)).find((entry): entry is Execution => entry.kind === "execute" && entry.workItemId === workItemId);
    if (!action?.pendingMessageId || !action.sessionId) return item;
    if (!this.deliveryConfirmer) return item;
    const result = await this.deliveryConfirmer(action.sessionId, action.pendingMessageId);
    if (!result.accepted) return item;
    const deliveryStore = await this.sessionDeliveries(workspaceId);
    const delivery = await deliveryStore.get(action.pendingMessageId);
    if (delivery) await deliveryStore.put({ ...delivery, state: "accepted", turnId: result.turnId });
    const expectedSessionId = action.sessionId;
    const expectedAttemptId = action.attemptId;
    const active = result.active !== false;
    const confirmed = await this.transactRecord(workspaceId, workItemId, (record) => {
      if (!record) throw new Error("Unknown work item: " + workItemId);
      const current = record.execution;
      if (current.pendingMessageId !== action.pendingMessageId || current.sessionId !== expectedSessionId || current.attemptId !== expectedAttemptId ||
          !delivery || delivery.sessionId !== expectedSessionId || delivery.workItemId !== workItemId || !["sending", "unknown", "accepted"].includes(delivery.state)) return { record, result: false };
      const now = this.now();
      if (delivery?.mode === "supplement") return { record: { ...record, execution: {
        ...acceptExecutionMessage(current, delivery, active ? result.turnId : undefined), pendingMessageId: undefined,
        deliveryUncertain: undefined, failure: undefined, waitReason: current.control === "paused" ? current.waitReason : undefined, updatedAt: now
      } }, result: true };
      return { record: { ...record,
        execution: { ...acceptExecutionMessage(current, delivery, result.turnId), pendingMessageId: undefined, deliveryUncertain: undefined,
          scheduledTurnId: delivery.origin === "scheduler" ? result.turnId : current.scheduledTurnId,
          activeTurnId: result.turnId ?? current.activeTurnId,
          deliveredAt: now,
          waitReason: current.control === "paused" ? current.waitReason : undefined, failure: undefined, updatedAt: now }
      }, result: true };
    });
    if (!confirmed) return this.getWorkItem(workspaceId, workItemId);
    if (delivery) await this.stopCancelledDelivery(workspaceId, delivery, result.turnId);
    await this.reconcileExecutionTurns(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  async cancelWorkRequest(workspaceId: string, input: { requestId?: string; sessionId?: string }): Promise<{ cancelled: boolean; request?: WorkRequest }> {
    return this.integrate(workspaceId, async () => {
      const request = (await this.listWorkRequests(workspaceId)).find((entry) => input.requestId
        ? entry.requestId === input.requestId
        : entry.workerSessionId === input.sessionId);
      if (!request) return { cancelled: false };
      if (request.status === "cancelled") return { cancelled: true, request };
      if (!["pending", "preparing", "failed"].includes(request.status) && !(input.requestId && request.status === "ready")) return { cancelled: false, request };
      for (const item of await this.listWorkItems(workspaceId)) {
        if (item.requestId === request.requestId && !["closed", "cancelled"].includes(item.status))
          await this.cancelResult(workspaceId, item.workItemId, false);
      }
      const saved = await this.updateWorkRequest(workspaceId, request.requestId, (current) => ({
        ...current, status: "cancelled", control: "paused", failure: undefined, retryAt: undefined,
        waitReason: "用户已取消当前工作"
      }));
      this.emit({ type: "workRequest.cancelled", workspaceId, requestId: request.requestId, sessionId: request.workerSessionId, turnId: request.activeTurnId });
      return { cancelled: true, request: saved };
    });
  }

  async failWorkRequest(workspaceId: string, requestId: string, failure: string): Promise<WorkRequest> {
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("Unknown work request: " + requestId);
    if (request.status === "cancelled" || request.control === "paused") return request;
    return this.updateWorkRequest(workspaceId, requestId, (current) => {
      if (current.status === "cancelled" || current.control === "paused") return current;
      const next = transitionControl(current, { type: "failed", failure, now: this.now() });
      return { ...next, status: next.retryAt ? current.workerSessionId ? "preparing" : "pending" : "failed" };
    });
  }

  async finishPreparation(workspaceId: string, sessionId: string, turnId?: string): Promise<void> {
    return this.integrate(workspaceId, () => this.finishPreparationRecord(workspaceId, sessionId, turnId));
  }

  private async finishPreparationRecord(workspaceId: string, sessionId: string, turnId?: string): Promise<void> {
    let request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.workerSessionId === sessionId && entry.status === "preparing");
    if (!request) return;
    if (!request.handoff || request.handoff.sessionId !== sessionId) {
      await this.holdPreparation(workspaceId, request.requestId, "准备轮结束但尚未登记完整交接，等待手动继续。");
      return;
    }
    const handoffIds = new Set(request.handoff.workItemIds);
    const requestItems = (await this.listWorkItems(workspaceId)).filter((item) => item.requestId === request.requestId);
    if (requestItems.length !== handoffIds.size || requestItems.some((item) => !handoffIds.has(item.workItemId))) {
      await this.holdPreparation(workspaceId, request.requestId, "准备交接清单与实际工单不一致，等待修正。");
      return;
    }
    const forkTurnId = turnId ?? await this.sourceTurnResolver?.(sessionId);
    for (const item of await this.listWorkItems(workspaceId)) {
      if (item.status === "preparing" && item.requestId === request.requestId) {
        if (!item.run.sessionId && !forkTurnId) throw new Error("无法解析准备分支末端，不能 fork 其余工单。");
        await this.mutateRecord(workspaceId, item.workItemId, (record) => ({ ...record,
          item: { ...record.item, status: "queued", updatedAt: this.now() },
          execution: { ...record.execution, ...(!record.execution.sessionId ? { forkSessionId: sessionId, forkTurnId } : {}), updatedAt: this.now() } }));
      }
    }
    for (const request of await this.listWorkRequests(workspaceId)) {
      if (request.workerSessionId === sessionId && request.status === "preparing")
        await this.updateWorkRequest(workspaceId, request.requestId, (current) => current.status !== "preparing" || current.workerSessionId !== sessionId ? current : ({ ...current, status: "ready", failure: undefined, retryAt: undefined,
          activeTurnId: undefined, waitReason: current.control === "paused" ? current.waitReason : undefined }));
    }
  }

  async refreshActions(workspaceId: string): Promise<void> {
    for (const card of await this.listDecisions(workspaceId)) if (card.deliveryPending) await this.flushDecision(workspaceId, card);
    const items = await this.listWorkItems(workspaceId);
    for (const item of items) {
      const actions = (await this.listActions(workspaceId)).filter((a) => a.workItemId === item.workItemId && actionIsOpen(a));
      if (["closed", "cancelled", "merging", "decision"].includes(item.status)) {
        for (const action of actions.filter((a) => a.kind === "execute" && a.status !== "decision"))
          await this.finishAction(workspaceId, action.actionId, "工单已进入 " + item.status);
      }
      if (item.status !== "queued" && item.status !== "running") continue;
      const cancelled = item.dependsOn.filter((id) => items.find((other) => other.workItemId === id)?.status === "cancelled");
      if (cancelled.length) {
        await this.createDecision(workspaceId, { workItemId: item.workItemId, sessionId: item.run.sessionId,
          question: "前置工作已取消，如何继续？", context: "当前工作需要的前置已取消。请调整依赖或取消本单。", details: cancelled.join(", "),
          options: [{ key: "adjust", label: "调整依赖" }, { key: "cancel", label: "取消" }] });
        continue;
      }
      if (!actions.some((a) => a.kind === "execute") && !(await this.isWorkItemBlocked(workspaceId, item.workItemId))) {
        const execution = (await this.listActions(workspaceId)).find((a): a is Execution => a.kind === "execute" && a.workItemId === item.workItemId)!;
        await this.updateAction(workspaceId, execution, (execution) => ({ ...execution, status: "pending", stage: execution.sessionId ? "deliver" : "open" }));
      }
    }
  }

  async getWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    const record = await (await this.context(workspaceId)).store.getRecord(workItemId);
    if (!record) throw new Error("Unknown work item: " + workItemId);
    return this.projectExecutionItem(record);
  }

  async listActions(workspaceId: string): Promise<WorkflowAction[]> {
    return (await (await this.context(workspaceId)).store.listRecords()).flatMap((record) => [record.execution, ...record.integrations]);
  }

  async createAction(workspaceId: string, input: Omit<Integration, "actionId" | "history" | "createdAt" | "updatedAt" | "attempts">, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<Integration> {
    const now = this.now();
    return this.transactRecord(workspaceId, input.workItemId, (current) => {
      if (!current) throw new Error("Unknown work item: " + input.workItemId);
      const active = current.integrations.find(actionIsOpen);
      if (active) {
        if (active.integration.operation !== input.integration.operation) throw new Error("Another integration is still active for " + input.workItemId);
        return { record: current, result: active };
      }
      const action: Integration = { ...input, actionId: createId("action"), attempts: 0, history: [{ at: now, event: "created", message: input.message }], createdAt: now, updatedAt: now };
      return { record: { ...current, item: mutateItem ? mutateItem(current.item) : current.item, integrations: [...current.integrations, action] }, result: action };
    });
  }

  async updateAction<T extends WorkflowAction>(workspaceId: string, action: T, mutate: (current: T) => T, mutateItem?: (item: WorkItemRecord["item"]) => WorkItemRecord["item"]): Promise<T> {
    return this.transactRecord(workspaceId, action.workItemId, (current) => {
      if (!current) throw new Error("Unknown work item: " + action.workItemId);
      const saved = action.kind === "execute" ? current.execution : current.integrations.find((entry) => entry.actionId === action.actionId);
      if (!saved) throw new Error("Unknown process: " + action.actionId);
      const updated: WorkflowAction = { ...mutate(saved as T), updatedAt: this.now() };
      const record: WorkItemRecord = { ...current,
        item: mutateItem ? mutateItem(current.item) : current.item,
        ...(updated.kind === "execute" ? { execution: updated } : { integrations: current.integrations.map((entry) => entry.actionId === updated.actionId ? updated : entry) }) };
      return { record, result: updated as T };
    });
  }

  private async transactRecord<T>(workspaceId: string, workItemId: string, update: (current: WorkItemRecord | undefined) => { record: WorkItemRecord; result: T }, events: WorkbenchEvent[] = []): Promise<T> {
    const saved = await (await this.context(workspaceId)).store.transactRecord(workItemId, update);
    for (const event of events) this.emit(event);
    this.emit({ type: "workItems.changed", workspaceId });
    this.emit({ type: "actions.changed", workspaceId });
    return saved;
  }

  private async getAction(workspaceId: string, actionId: string): Promise<WorkflowAction> {
    const action = (await this.listActions(workspaceId)).find((entry) => entry.actionId === actionId);
    if (!action) throw new Error("Unknown action: " + actionId);
    return action;
  }

  async finishAction(workspaceId: string, actionId: string, note: string): Promise<WorkflowAction> {
    const action = await this.getAction(workspaceId, actionId);
    return this.updateAction(workspaceId, action, (action) => ({ ...action, status: "done", retryAt: undefined, history: [...action.history, { at: this.now(), event: "resolved", message: note }] }));
  }

  async isWorkItemBlocked(workspaceId: string, workItemId: string): Promise<boolean> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    const items = await this.listWorkItems(workspaceId);
    return !await this.preparationReady(workspaceId, item) || item.dependsOn.some((id) => items.find((other) => other.workItemId === id)?.status !== "closed")
      || (await this.listActions(workspaceId)).some((action) => actionIsOpen(action) && action.workItemId === workItemId && action.kind === "integration" && !action.agent)
      || (await this.listDecisions(workspaceId)).some((card) => card.workItemId === workItemId && !card.answer && !card.withdrawn);
  }

  private async preparationReady(workspaceId: string, item: Pick<WorkItem, "requestId">): Promise<boolean> {
    if (!item.requestId) return true;
    const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === item.requestId);
    return request?.status === "ready" && !!request.handoff;
  }

  registerScheduler(): () => void {
    const owner = {};
    this.schedulerOwner = owner;
    return () => { if (this.schedulerOwner === owner) this.schedulerOwner = undefined; };
  }

  async getRuntimeInfo() {
    return { ...runtimeInfo, schedulerOnline: !!this.schedulerOwner };
  }

  async diagnoseWorkItem(workspaceId: string, workItemId: string) {
    return diagnose(this, workspaceId, workItemId, !!this.schedulerOwner);
  }

  async failAction(workspaceId: string, actionId: string, failure: string): Promise<WorkflowAction> {
    const action = await this.getAction(workspaceId, actionId);
    if (!actionIsOpen(action) || action.status === "decision") return action;
    const quotaBlocked = action.kind === "execute" && /quota|credit|insufficient|认证|authentication|unauthorized|forbidden/i.test(failure);
    const failed = await this.updateAction(workspaceId, action, (action) => {
      const next = this.failedAction(action, failure);
      return next.kind === "execute" && (next.status === "decision" || quotaBlocked)
        ? { ...next, status: "decision", control: "manual", waitReason: quotaBlocked ? "工作受阻：额度、认证或配置需要处理" : "自动恢复次数已用尽", retryAt: undefined }
        : next;
    }, action.kind === "execute" ? (item) => ({ ...item, status: quotaBlocked || RETRY_MINUTES[action.attempts] === undefined ? "decision" : "queued" }) : undefined);
    await this.ensureFailureDecision(workspaceId, failed);
    return this.getAction(workspaceId, actionId);
  }

  private failedAction<T extends WorkflowAction>(action: T, failure: string): T {
    if (action.kind === "execute") {
      const next = transitionControl(action, { type: "failed", failure, now: this.now() });
      return { ...next, status: next.retryAt ? "retry" : "decision",
        history: [...action.history, { at: this.now(), event: "failed:" + action.stage, message: failure }] } as T;
    }
    const attempts = action.attempts + 1;
    const delay = RETRY_MINUTES[attempts - 1];
    return { ...action, attempts, failure, status: delay === undefined ? "decision" : "retry",
      retryAt: delay === undefined ? undefined : new Date(Date.parse(this.now()) + delay * 60_000).toISOString(),
      history: [...action.history, { at: this.now(), event: "failed:" + action.stage, message: failure }] };
  }

  private async ensureFailureDecision(workspaceId: string, failed: WorkflowAction): Promise<void> {
    if (failed.kind === "execute") return;
    if (failed.kind === "integration" && failed.stage === "merge") return;
    const action = failed;
    const actionId = action.actionId;
    if (failed.status === "decision" && !(await this.listDecisions(workspaceId)).some((card) => card.actionId === actionId && !card.answer && !card.withdrawn)) {
      await this.createDecision(workspaceId, { actionId, kind: "attempts", workItemId: action.workItemId,
        question: "自动恢复已用尽，要再试还是取消当前工作？", context: "工作台已尝试自动恢复四次，仍未完成当前处理。原会话与成果保留，选择再试后会从未完成的动作继续。",
        details: "阶段：" + action.stage + "\n受影响工单：" + action.workItemId + "\n" + failed.history.filter((h) => h.event.startsWith("failed:")).map((h) => h.at + " " + h.message).join("\n"),
        options: [{ key: "retry", label: "再试", detail: "清零此处理过程的失败计数，从未完成动作继续。" }, { key: "cancel", label: "取消当前工作", detail: "取消该过程关联的工单；已合入成果保持保留。" }], recommended: "retry", recommendation: "故障已排除时可沿原处理过程继续。" });
    }
  }

  /** Completion's ownership test and all execution changes share one record transaction. */
  async settleWorkerTurn(workspaceId: string, workItemId: string, input: {
    ownsExecution: () => boolean; turnId?: string; scheduled: boolean; finishReason: string; failure?: string; completion: string; requireCurrentTurn?: boolean;
  }): Promise<{ status: "done" | "failed"; note: string } | undefined> {
    const result = await this.transactRecord(workspaceId, workItemId, (record) => {
      if (!record) throw new Error("Unknown work item: " + workItemId);
      if (!input.ownsExecution()) return { record, result: undefined };
      const action = record.execution;
      if (input.requireCurrentTurn && action.activeTurnId !== input.turnId) return { record, result: undefined };
      let execution = action;
      let item = record.item;
      let note: string;
      let failure: string | undefined;
      if (action.control === "paused") note = "已暂停执行的轮次完成结算";
      else if (!actionIsOpen(action) || action.status === "decision") note = action.status;
      else if (item.status === "queued" || action.stage === "deliver") {
        execution = { ...action, stage: "deliver", status: "pending" };
        note = "待送达后续消息";
      } else if (item.status !== "running") {
        execution = { ...action, status: "done", retryAt: undefined,
          history: [...action.history, { at: this.now(), event: "resolved", message: "工单已进入 " + item.status }] };
        note = "已交接";
      } else if (!input.scheduled) {
        execution = { ...transitionControl(action, { type: "hold", reason: "等待手动继续" }), status: "decision" };
        item = { ...item, status: "decision" };
        note = "等待手动继续";
      }
      else if (input.finishReason === "completed" && action.idleTurns >= 1) {
        execution = { ...action, status: "decision", control: "manual", activeTurnId: undefined, retryAt: undefined, waitReason: "缺少交接结果" };
        item = { ...item, status: "decision" };
        note = "缺少交接结果";
      }
      else if (input.finishReason !== "completed") {
        failure = input.finishReason !== "completed" ? "turn " + input.finishReason + (input.failure ? ": " + input.failure : "")
          : "连续未落实处置：" + input.completion;
        execution = this.failedAction(action, failure);
        item = { ...item, status: execution.status === "decision" ? "decision" : "queued" };
        note = failure;
      } else {
        execution = { ...action, heartbeatAt: this.now(), idleTurns: action.idleTurns + 1, stage: "deliver", status: "pending",
          notices: [...action.notices, pendingNotice("nag", "尚未落实处置。请执行：" + input.completion, this.now())] };
        note = "要求落实具体动作";
      }
      return { record: { ...record, item: { ...item, updatedAt: this.now() }, execution: {
        ...transitionControl(execution, { type: "settled", turnId: input.turnId ?? "" }),
        history: [...execution.history, { at: this.now(), event: "turn." + input.finishReason, message: input.failure ?? note }], updatedAt: this.now() } },
        result: { status: failure ? "failed" as const : "done" as const, note, failed: failure ? execution : undefined } };
    });
    if (result?.failed) await this.ensureFailureDecision(workspaceId, result.failed);
    return result;
  }

  /** Dependencies and agent actions share one durable queue; facts, not delivery receipts, release waiting work. */
  async createWorkItem(
    workspaceId: string,
    input: WorkItemCreateInput
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.createWorkItemIntegrated(workspaceId, input));
  }

  private async createWorkItemIntegrated(workspaceId: string, input: WorkItemCreateInput): Promise<WorkItem> {
    const refs = input.refs ? await this.validateWorkItemRefs(workspaceId, input.refs) : undefined;
    const explicitIssue = input.issueId ? await this.getIssue(workspaceId, input.issueId) : undefined;
    const request = input.requestId ? await (await this.context(workspaceId)).store.workRequests.get(input.requestId) : undefined;
    const sourceSessionId = request?.sourceSessionId ?? input.sourceSessionId;
    const linkedIssue = explicitIssue ?? (sourceSessionId ? (await this.listIssues(workspaceId)).find((issue) => issue.discussionSessionId === sourceSessionId) : undefined);
    if (linkedIssue && ["closed", "duplicate"].includes(linkedIssue.status)) throw new Error("已关闭或重复的 Issue 不能创建关联工单。");
    const item = await this.createWorkItemRecord(workspaceId, { ...input, refs, issueId: linkedIssue?.issueId });
    if (!linkedIssue) return item;
    const now = this.now();
    await (await this.context(workspaceId)).store.transactIssue(linkedIssue.issueId, (current) => {
      if (!current) throw new Error("Unknown issue: " + linkedIssue.issueId);
      const issue: Issue = { ...current, status: "started", unread: true,
        workItemIds: [...new Set([...current.workItemIds, item.workItemId])],
        activities: [...current.activities, { at: now, kind: "workItem", message: input.owner ? "Owner 根据领域授权创建工单" : "关联工单", workItemId: item.workItemId }], updatedAt: now };
      return { record: issue, result: issue };
    });
    this.emit({ type: "issues.changed", workspaceId });
    return item;
  }

  async createAuthorizedIssueWorkItem(workspaceId: string, input: Pick<WorkItemCreateInput, "title" | "objective" | "risk" | "scope" | "acceptance" | "refs" | "needs" | "dependsOn"> & {
    patrolRunId: string; sessionId: string; issueId: string; authorizationReason: string; expectedBehavior: string;
  }): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const run = await this.getPatrolRun(workspaceId, input.patrolRunId);
      if (run.status !== "running" || run.sessionId !== input.sessionId) throw new Error("只有当前领域巡检会话能自动开单。");
      const issue = await this.getIssue(workspaceId, input.issueId);
      if (issue.domainId !== run.domainId) throw new Error("Issue 不属于当前巡检领域。");
      if (issue.type !== "problem" || ["decision", "closed", "duplicate", "started"].includes(issue.status)) throw new Error("当前 Issue 状态不允许 Owner 自动开单。");
      const config = await this.getDomainConfig(workspaceId, run.domainId);
      if (!config.autoWorkEnabled || !config.authorizationScope.length) throw new Error("当前领域未启用自动开单或授权范围为空。");
      if (!issue.requirement?.path || !issue.requirement.commit) throw new Error("自动开单需要固定版本的要求路径与 commit。");
      if (!issue.evidence.some((entry) => entry.kind === "static" || entry.kind === "reproduced")) throw new Error("自动开单需要静态证据或实际复现证据。");
      if (!input.refs?.some((ref) => ref.path === issue.requirement!.path && ref.commit === issue.requirement!.commit)) throw new Error("工单 refs 必须包含 Issue 的固定要求引用。");
      if (!input.scope.allowedPaths.length || !input.acceptance.length) throw new Error("自动修复工单需要允许路径和可观察验收结果。");
      const { docs } = await this.context(workspaceId);
      const fixedRefs = await Promise.all(input.refs.map(async (ref) => {
        if (!/^[0-9a-f]{40}$/i.test(ref.commit)) throw new Error("自动修复工单的 refs 必须使用完整、不可漂移的 commit：" + ref.path);
        const commit = await docs.resolveRevision(ref.commit);
        if (commit.toLowerCase() !== ref.commit.toLowerCase()) throw new Error("自动修复工单的 ref 未解析为完整 commit：" + ref.path);
        await docs.read(ref.path, commit);
        return { ...ref, commit };
      }));
      const requirementRef = fixedRefs.find((ref) => ref.path === issue.requirement!.path && ref.commit.toLowerCase() === issue.requirement!.commit!.toLowerCase());
      if (!requirementRef) throw new Error("工单 refs 必须包含已验证的固定要求引用。");
      const requirement = { ...issue.requirement, commit: requirementRef.commit };
      const { patrolRunId: _patrolRunId, sessionId: _callerSessionId, issueId: _issueId,
        authorizationReason: _authorizationReason, expectedBehavior: _expectedBehavior, ...workInput } = input;
      const item = await this.createWorkItemIntegrated(workspaceId, {
        ...workInput, refs: fixedRefs, issueId: issue.issueId, sourceSessionId: run.sessionId, sourceTurnId: run.turnId,
        owner: { domainId: run.domainId, patrolRunId: run.patrolRunId,
          authorizationScope: config.authorizationScope, authorizationReason: input.authorizationReason.trim(),
          expectedBehavior: input.expectedBehavior.trim(), requirement, evidence: issue.evidence }
      });
      await (await this.context(workspaceId)).store.transactPatrolRun(run.patrolRunId, (current) => {
        if (!current) throw new Error("Unknown patrol run: " + run.patrolRunId);
        const updated = { ...current, workItemIds: [...new Set([...current.workItemIds, item.workItemId])], updatedAt: this.now() };
        return { record: updated, result: updated };
      });
      this.emit({ type: "domains.changed", workspaceId });
      return item;
    });
  }

  private async createWorkItemRecord(workspaceId: string, input: WorkItemCreateInput): Promise<WorkItem> {
    const now = this.now();
    const { store } = await this.context(workspaceId);
    if (!!input.worktreePath !== !!input.branch) throw new Error("worktreePath 与 branch 必须同时提供。");
    if (input.needs?.some((need) => ["browser", "desktop"].includes(need.trim()))) throw new Error("needs 必须指明具体共享实例，例如 browser:qa-profile。");
    const request = input.requestId ? await store.workRequests.get(input.requestId) : undefined;
    if (input.requestId && (!request || request.status !== "preparing" || (input.sessionId && request.workerSessionId !== input.sessionId))) throw new Error("requestId 必须属于当前准备分支。");
    if (input.sessionId && (await this.listWorkItems(workspaceId)).some((item) => item.run.sessionId === input.sessionId && !["closed", "cancelled"].includes(item.status))) throw new Error("同一执行分支只能绑定一张未结束工单。其他工单请 fork 兄弟分支。");
    await this.checkDependencies(workspaceId, "(new)", input.dependsOn ?? []);
    const item: WorkItemRecord["item"] = {
      workItemId: createId("wi"),
      issueId: input.issueId,
      owner: input.owner,
      sourceSessionId: request?.sourceSessionId ?? input.sourceSessionId, sourceTurnId: request?.sourceTurnId ?? input.sourceTurnId, treeId: request?.treeId ?? input.treeId, requestId: input.requestId,
      contractRevision: 0,
      title: input.title.trim(),
      objective: input.objective,
      status: request ? "preparing" : "queued",
      risk: input.risk,
      needs: input.needs ?? [],
      dependsOn: input.dependsOn ?? [],
      refs: input.refs ?? [],
      scope: input.scope,
      acceptance: input.acceptance,
      review: [],
      rejections: [],
      decisions: [],
      createdAt: now,
      updatedAt: now
    };
    return this.transactRecord(workspaceId, item.workItemId, (current) => {
      if (current) throw new Error("Work item already exists: " + item.workItemId);
      const record: WorkItemRecord = { workItemId: item.workItemId, item, integrations: [], cleanup: [], execution: {
        sessionId: input.sessionId, worktreePath: input.worktreePath, branch: input.branch,
        kind: "execute", actionId: "execution-" + item.workItemId, workItemId: item.workItemId,
        status: "pending", stage: "open", control: "auto", notices: [], attempts: 0, idleTurns: 0, history: [], createdAt: now, updatedAt: now
      } };
      return { record, result: projectWorkItem(record) };
    });
  }

  private async mutateRecord(workspaceId: string, workItemId: string, mutate: (record: WorkItemRecord) => WorkItemRecord, events: WorkbenchEvent[] = []): Promise<WorkItem> {
    return this.transactRecord(workspaceId, workItemId, (current) => {
      if (!current) throw new Error("Unknown work item: " + workItemId);
      const record = mutate(current);
      return { record, result: projectWorkItem(record) };
    }, events);
  }

  /** Worker claimed the item; records the session and worktree it runs in. */
  /** A (re)start begins a new turn: the pending message is claimed and any stale-turn mark from the previous run is over. */
  async startWorkItem(workspaceId: string, workItemId: string, run: Pick<Execution, "sessionId" | "heartbeatAt">): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.startWorkItemRecord(workspaceId, workItemId, run));
  }

  private async startWorkItemRecord(workspaceId: string, workItemId: string, run: Pick<Execution, "sessionId" | "heartbeatAt">): Promise<WorkItem> {
    const current = await this.getWorkItem(workspaceId, workItemId);
    if (current.status !== "queued" && !(current.status === "running" && current.run.sessionId === run.sessionId)) throw new Error("只有可执行的排队工单可以启动，已结束或等待合入的工单不能重新认领。");
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("工单仍有未解决的等待条件，请读取 action.list。");
    const occupancy = await this.getExecutionOccupancy(workspaceId);
    const occupied = occupancy.workItems.filter((item) => item.workItemId !== workItemId);
    const scheduler = await this.getScheduler(workspaceId);
    if (occupancy.sessionIds.filter((sessionId) => sessionId !== current.run.sessionId).length >= scheduler.maxWorkers || occupied.some((item) => effectiveNeeds(item).some((need) => effectiveNeeds(current).includes(need)))) throw new Error("并发或共享资源尚未释放，保持排队。");
    const baseCommit = current.run.baseCommit ?? await (await this.context(workspaceId)).docs.head().catch(() => undefined);
    return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
      item: { ...record.item, status: "running", updatedAt: this.now() },
      execution: { ...record.execution, status: "running", sessionId: run.sessionId ?? record.execution.sessionId, heartbeatAt: run.heartbeatAt ?? record.execution.heartbeatAt,
        baseCommit, control: record.execution.control === "paused" ? "paused" : "auto",
        attemptId: record.execution.attemptId ?? createId("attempt"), activeTurnId: undefined,
        waitReason: undefined, updatedAt: this.now() }
    }));
  }

  async heartbeatWorkItem(workspaceId: string, workItemId: string, lastTurnId?: string): Promise<WorkItem> {
    return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
      item: { ...record.item, updatedAt: this.now() },
      execution: { ...record.execution, lastTurnId: lastTurnId ?? record.execution.lastTurnId, heartbeatAt: this.now(), updatedAt: this.now() } }));
  }

  /** Verified work merges immediately; unsuccessful submissions return to the same worker. */
  async submitWorkItem(
    workspaceId: string,
    workItemId: string,
    input: { sessionId?: string; contractRevision: number; evidence: Omit<NonNullable<WorkItem["evidence"]>, "submittedAt">; review: WorkItem["review"]; verify: VerifySubmission }
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.submitResult(workspaceId, workItemId, input));
  }

  private async submitResult(workspaceId: string, workItemId: string, input: Parameters<WorkbenchService["submitWorkItem"]>[2]): Promise<WorkItem> {
    const bound = await this.getWorkItem(workspaceId, workItemId);
    if (input.sessionId && bound.run.sessionId !== input.sessionId) throw new Error("提交会话已迁移，旧执行分支不能提交当前工单。");
    if (bound.run.migratedFromSessionId && !input.sessionId) throw new Error("该工单已迁移执行，提交时必须传当前 sessionId。");
    if ((await this.listActions(workspaceId)).some((action) => action.kind === "execute" && action.workItemId === workItemId && action.integrationActionId))
      throw new Error("接管合入请调用 workItem.integration.complete，不重复提交开发成果。");
    const now = this.now();
    if (await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("仍有未解决的等待条件，不能提交。");
    type PreparedSubmission = { stale: true; item: WorkItem } | { stale: false; item: WorkItem };
    const prepared = await this.transactRecord<PreparedSubmission>(workspaceId, workItemId, (record) => {
      if (!record) throw new Error("Unknown work item: " + workItemId);
      if (record.item.status !== "running") throw new Error("Work item is not running: " + workItemId);
      if (input.contractRevision !== record.item.contractRevision) {
        const reason = "提交依据已过期：当前合同修订为 " + record.item.contractRevision + "，收到的是 " + input.contractRevision + "。请重新读取工单并仅更新受影响的结果。";
        const updatedAt = this.now();
        const updated = { ...record,
          item: { ...record.item, status: "queued" as const, rejections: [...record.item.rejections, { reason, at: updatedAt }], updatedAt },
          execution: { ...record.execution, idleTurns: 0, updatedAt,
            notices: [...record.execution.notices, pendingNotice("rejected", reason, this.now())] }
        };
        return { record: updated, result: { stale: true as const, item: projectWorkItem(updated) } };
      }
      const previousVerify = record.item.verify;
      const verifyByIndex = new Map((previousVerify?.items ?? []).map((entry) => [entry.index, entry]));
      for (const entry of input.verify.items) verifyByIndex.set(entry.index, entry);
      const mergedItems = [...verifyByIndex.values()].sort((left, right) => left.index - right.index);
      const complete = record.item.acceptance.every((_, index) => verifyByIndex.has(index));
      const mergedPass = input.verify.verdict === "pass" && complete &&
        mergedItems.length === record.item.acceptance.length && mergedItems.every((entry) => entry.status === "pass");
      const mergeUnique = <T>(before: T[], after: T[]): T[] => [...before, ...after].filter((entry, index, all) =>
        all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index);
      const previousEvidence = record.item.evidence;
      const evidence = {
        summary: input.evidence.summary || previousEvidence?.summary || "",
        ...(input.evidence.commit || previousEvidence?.commit ? { commit: input.evidence.commit ?? previousEvidence?.commit } : {}),
        commands: mergeUnique(previousEvidence?.commands ?? [], input.evidence.commands),
        assumptions: mergeUnique(previousEvidence?.assumptions ?? [], input.evidence.assumptions),
        untested: mergeUnique(previousEvidence?.untested ?? [], input.evidence.untested),
        outOfScopeFindings: mergeUnique(previousEvidence?.outOfScopeFindings ?? [], input.evidence.outOfScopeFindings),
        attachments: mergeUnique(previousEvidence?.attachments ?? [], input.evidence.attachments),
        submittedAt: now
      };
      const verify = { items: mergedItems, verdict: mergedPass ? "pass" as const : "rework" as const, verifiedAt: now };
      const updated = { ...record, item: {
        ...record.item,
        updatedAt: now,
        evidence,
        review: mergeUnique(record.item.review, input.review),
        verify
      } };
      return { record: updated, result: { stale: false as const, item: projectWorkItem(updated) } };
    });
    if (prepared.stale) return prepared.item;
    const submitted = prepared.item;
    const failed = submitted.verify?.items.filter((entry) => entry.status !== "pass") ?? [];
    const missing = submitted.acceptance.some((_, index) => !submitted.verify?.items.some((entry) => entry.index === index));
    if (submitted.verify?.verdict !== "pass" || failed.length || missing) {
      const statusText = failed.map((entry) => ({ defect: "发现缺陷", blocked: "条件不足", incomplete: "尚未完成", pass: "通过" }[entry.status] + "：" + entry.evidence)).join("\n");
      const reason = "验收未通过：" + (statusText || (missing ? "验收报告未覆盖全部条目" : "验收报告要求返工"));
      return this.returnWorkItem(workspaceId, workItemId, reason);
    }
    await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "merge", message: "验收通过，等待合入。", integration: { operation: "merge", contractRevision: submitted.contractRevision, diffStat: "" } },
      (item) => ({ ...item, status: "merging", updatedAt: this.now() }));
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  /** Accepts the work: merges the worker's branch into the workspace (when it ran in a worktree) and closes the item. */
  async continueIntegrations(workspaceId: string): Promise<void> {
    await this.integrate(workspaceId, () => this.drainIntegrations(workspaceId));
  }

  async retryIntegration(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const action = (await this.listActions(workspaceId)).find((entry): entry is Integration =>
        entry.kind === "integration" && entry.workItemId === workItemId && entry.stage === "merge" && actionIsOpen(entry));
      if (!action || action.agent || !["retry", "decision"].includes(action.status)) throw new Error("当前合入没有可立即重试的失败动作：" + workItemId);
      const retried = await this.updateAction(workspaceId, action, (current) => ({ ...current,
        status: "pending", attempts: 0, retryAt: undefined, failure: undefined,
        history: [...current.history, { at: this.now(), event: "retry:merge", message: "用户立即重试合入" }] }));
      await this.drainIntegrations(workspaceId);
      return this.getWorkItem(workspaceId, retried.workItemId);
    });
  }

  async takeoverIntegration(workspaceId: string, workItemId: string, note?: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const item = await this.getWorkItem(workspaceId, workItemId);
      if (item.run.pendingMessageId) throw new Error("消息受理状态不明，请先调用 workItem.confirm。");
      const action = (await this.listActions(workspaceId)).find((entry): entry is Integration =>
        entry.kind === "integration" && entry.workItemId === workItemId && entry.stage === "merge" && actionIsOpen(entry));
      if (!action) throw new Error("当前工单没有可接管的合入动作：" + workItemId);
      if (action.agent) return item;
      if (!item.run.sessionId) throw new Error("当前工单没有可接管的 Worker 会话：" + workItemId);
      if (!["retry", "decision"].includes(action.status)) throw new Error("合入尚未失败，暂不能交给 Agent：" + workItemId);
      const now = this.now();
      const instruction = ["接管合入本单。", "workspaceId: " + workspaceId, "workItemId: " + workItemId,
        "integrationActionId: " + action.actionId, "sessionId: " + item.run.sessionId,
        "工作目录: " + (item.run.worktreePath ?? await this.workspaceRoot(workspaceId)),
        "当前成果: " + (item.evidence?.commit ?? "未登记 commit"), "已失败次数: " + action.attempts,
        action.failure ? "最近合入失败：" + action.failure : "", note?.trim() ? "用户说明：" + note.trim() : "",
        "保留已通过且未受影响的开发与验收。读取 workItem.get 和 action.list，在原 worktree 处理冲突和 rebase，最终合入交给工作台串行入口，不自行写主分支。"
      ].filter(Boolean).join("\n");
      return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
        item: { ...record.item, status: "queued", updatedAt: now },
        execution: { ...record.execution, integrationActionId: action.actionId, status: "pending", stage: "deliver",
          runId: undefined, scheduledTurnId: undefined, deliveredAt: undefined,
          attempts: 0, idleTurns: 0, retryAt: undefined, failure: undefined, updatedAt: now,
          notices: [...record.execution.notices, pendingNotice("resumed", instruction, now)] },
        integrations: record.integrations.map((entry) => entry.actionId === action.actionId ? { ...entry,
          status: "pending", retryAt: undefined,
          agent: { sessionId: item.run.sessionId!, ...(note?.trim() ? { note: note.trim() } : {}), requestedAt: now },
          history: [...entry.history, { at: now, event: "takeover:merge", message: "用户交给原 Worker 处理合入" }], updatedAt: now
        } : entry)
      }));
    });
  }

  async completeIntegration(workspaceId: string, workItemId: string, actionId: string, sessionId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const item = await this.getWorkItem(workspaceId, workItemId);
      let action = await this.getAction(workspaceId, actionId);
      if (action.kind !== "integration" || action.workItemId !== workItemId || action.stage !== "merge" || !action.agent || action.agent.sessionId !== sessionId || !actionIsOpen(action))
        throw new Error("当前合入动作不属于该 Agent：" + actionId);
      if (item.run.control === "paused") throw new Error("用户已暂停合入，请先恢复工单：" + workItemId);
      if (item.status !== "running" || await this.isWorkItemBlocked(workspaceId, workItemId)) throw new Error("当前 Worker 尚未取得执行资格：" + workItemId);
      const { docs } = await this.context(workspaceId);
      const recoveredMerge = action.integration.before && action.integration.target
        ? await docs.getMergeCommit(action.integration.target, action.integration.before) : undefined;
      if (!recoveredMerge && item.run.branch) {
        const snapshot = await docs.integrationSnapshot(item.run.branch);
        action = await this.updateAction(workspaceId, action, (current) => ({ ...current,
          integration: { ...current.integration, before: snapshot.head, target: snapshot.target, diffStat: snapshot.diffStat } }));
      }
      await this.updateAction(workspaceId, action, (current) => ({ ...current,
        status: "pending", retryAt: undefined, failure: undefined,
        history: [...current.history, { at: this.now(), event: "agent:merge", message: "Agent 请求执行最终合入" }] }));
      await this.drainIntegrations(workspaceId, actionId);
      const latest = await this.getAction(workspaceId, actionId);
      if (latest.status !== "done") throw new Error(latest.failure ?? "Agent 合入未完成，请读取 action.list 后继续处理。");
      return this.getWorkItem(workspaceId, workItemId);
    });
  }

  private async drainIntegrations(workspaceId: string, requestedActionId?: string): Promise<void> {
    const actions = await this.listActions(workspaceId);
    const { docs } = await this.context(workspaceId);
    const pending = actions.filter((a): a is Integration => a.kind === "integration" && actionIsOpen(a) && a.status !== "decision" &&
      (requestedActionId ? a.actionId === requestedActionId && !!a.agent : !a.agent && (!a.retryAt || a.retryAt <= this.now())));
    for (let action of pending) {
      const workItemId = action.workItemId;
      let item = await this.getWorkItem(workspaceId, workItemId);
      if (item.run.control === "paused") continue;
      try {
        action = await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "running", retryAt: undefined, failure: undefined,
          history: [...current.history, { at: this.now(), event: "started:" + current.stage, message: (current.agent ? "Agent" : "工作台") + " 开始合入" }] }));
        let integration = action.integration!;
        if (action.stage === "merge" && integration.contractRevision !== item.contractRevision) {
          const reason = "合入作废：合同已更新为修订 " + item.contractRevision + "，成果依据为 " + integration.contractRevision + "。请按当前合同复核后重新提交。";
          await this.finishAction(workspaceId, action.actionId, reason);
          await this.returnWorkItem(workspaceId, workItemId, reason);
          continue;
        }
        if (action.stage === "merge") {
          if (item.run.worktreePath && item.run.branch) {
            if (!integration.target) {
              const snapshot = await docs.integrationSnapshot(item.run.branch);
              integration = { ...integration, before: snapshot.head, target: snapshot.target, diffStat: snapshot.diffStat };
              action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration }));
            }
            const result = await docs.mergeWorktree(item.run.worktreePath, item.run.branch, item.title, integration.target);
            // Recovering an already merged target still uses the original frozen diff and commit.
            integration = { ...integration, commit: result.commit ?? await docs.getMergeCommit(integration.target!, integration.before!) };
          } else {
            integration = { ...integration, ...await docs.rootResult(item.evidence?.commit, item.run.baseCommit, item.scope.allowedPaths) };
          }
        }
        if (action.stage === "rollback") {
          if (!integration.before) {
            integration = { ...integration, before: await docs.head() };
            action = await this.updateAction(workspaceId, action, (action) => ({ ...action, integration }));
          }
          let commit: string | undefined;
          for (const target of [...(integration.targets ?? [integration.target!])].reverse()) commit = await docs.rollbackMerge(target, integration.before);
          integration = { ...integration, commit };
        }
        const now = this.now();
        await this.mutateRecord(workspaceId, workItemId, (record) => {
          const rollback = integration.operation === "rollback";
          const detached = rollback ? record : this.detachWorktree(record, false);
          return { ...detached,
            cleanup: rollback ? detached.cleanup.map((candidate) => ({ ...candidate, detachedAt: undefined })) : detached.cleanup,
            item: { ...record.item, status: rollback ? "queued" : "closed", updatedAt: now,
              merge: rollback ? { ...record.item.merge!, rollbackCommit: integration.commit, acknowledgedAt: now }
                : { commit: integration.commit, commits: integration.commits, diffStat: integration.diffStat, mergedAt: now } },
            execution: { ...detached.execution, integrationActionId: undefined, status: rollback ? "pending" : "done", stage: rollback ? "deliver" : detached.execution.stage,
              updatedAt: now, baseCommit: rollback ? integration.commit : detached.execution.baseCommit,
              notices: rollback ? [...detached.execution.notices,
                pendingNotice("resumed", "用户回滚：" + integration.reason + "。重新判断隔离目录，需要时创建新 worktree 并通过 workItem.update 登记。", now)]
                : detached.execution.notices },
            integrations: record.integrations.map((entry) => entry.actionId === action.actionId
              ? { ...entry, integration, status: "done", updatedAt: now } : entry)
          };
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (action.agent) {
          await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "running", retryAt: undefined, failure: reason,
            history: [...current.history, { at: this.now(), event: "failed:merge:agent", message: reason }] }));
        } else if (error instanceof WorktreeMergeConflict || error instanceof WorktreeNotReady) {
          await this.finishAction(workspaceId, action.actionId, "转回原 Worker：" + reason);
          await this.returnWorkItem(workspaceId, workItemId, reason + "\n在原 worktree rebase 并更新受影响验证后重新提交。");
        } else {
          await this.failAction(workspaceId, action.actionId, reason);
          return;
        }
      }
    }
  }

  private async returnWorkItem(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    return this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
      item: { ...record.item, status: "queued", rejections: [...record.item.rejections, { reason, at: this.now() }], updatedAt: this.now() },
      execution: { ...record.execution, integrationActionId: undefined, idleTurns: 0, updatedAt: this.now(),
        notices: [...record.execution.notices, pendingNotice("rejected", reason, this.now())] }
    }));
  }

  async acknowledgeWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.mutateRecord(workspaceId, workItemId, (record) => {
      const { item } = record;
      if (item.status !== "closed" || !item.merge) throw new Error("Work item has no merged notification");
      return { ...record, item: { ...item, merge: { ...item.merge, acknowledgedAt: this.now() }, updatedAt: this.now() } };
    });
  }

  async rollbackWorkItem(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.rollbackResult(workspaceId, workItemId, reason));
  }

  private async rollbackResult(workspaceId: string, workItemId: string, reason: string): Promise<WorkItem> {
    if (!reason.trim()) throw new Error("请填写回滚理由");
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status !== "closed" || !item.merge?.commit) throw new Error("Work item has no merge to roll back");
    if (!(await this.listActions(workspaceId)).some((a) => a.kind === "integration" && a.workItemId === workItemId && actionIsOpen(a))) {
      await this.createAction(workspaceId, { kind: "integration", workItemId: workItemId, status: "pending", stage: "rollback", message: "用户回滚：" + reason.trim(), integration: { operation: "rollback", contractRevision: item.contractRevision, target: item.merge.commit, targets: item.merge.commits, diffStat: "", reason: reason.trim() } });
    }
    await this.drainIntegrations(workspaceId);
    return this.getWorkItem(workspaceId, workItemId);
  }

  async cancelWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.cancelResult(workspaceId, workItemId));
  }

  private async cancelResult(workspaceId: string, workItemId: string, notify = true): Promise<WorkItem> {
    const item = await this.getWorkItem(workspaceId, workItemId);
    if (item.status === "cancelled") return item;
    if (item.status === "closed") throw new Error("已合入工单请使用回滚入口，不能取消已完成成果。");
    const dependants = (await this.listWorkItems(workspaceId)).filter((w) => !["closed", "cancelled"].includes(w.status) && w.dependsOn.includes(workItemId)).map((w) => w.workItemId);
    const cancelled = await this.mutateRecord(workspaceId, workItemId, (record) => {
      const detached = this.detachWorktree(record, true);
      return { ...detached, item: { ...record.item, status: "cancelled", updatedAt: this.now() },
        execution: { ...detached.execution, status: "cancelled", updatedAt: this.now() },
        integrations: record.integrations.map((action) => actionIsOpen(action) ? { ...action, status: "cancelled", updatedAt: this.now() } : action) };
    }, notify ? [{ type: "workItem.cancelled", workspaceId, workItemId, sessionId: item.run.sessionId, turnId: item.run.activeTurnId, dependants }] : []);
    return cancelled;
  }

  async pauseWorkItem(workspaceId: string, input: { sessionId?: string; workItemId?: string } | string): Promise<{ paused: boolean; workItem?: WorkItem }> {
    return this.integrate(workspaceId, async () => {
      const target = typeof input === "string" ? { sessionId: input } : input;
      const item = (await this.listWorkItems(workspaceId)).find((entry) =>
        (target.workItemId ? entry.workItemId === target.workItemId : entry.run.sessionId === target.sessionId) &&
        !["closed", "cancelled"].includes(entry.status));
      if (!item) return { paused: false };
      const paused = await this.mutateRecord(workspaceId, item.workItemId, (record) => {
        const now = this.now();
        return { ...record,
          item: { ...record.item, updatedAt: now },
          execution: { ...transitionControl(record.execution, { type: "pause", reason: "用户已暂停当前工单" }),
            history: [...record.execution.history, { at: now, event: "paused:user", message: "用户已暂停 Worker" }], updatedAt: now } };

      });
      return { paused: true, workItem: paused };
    });
  }

  async resumeWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const current = await this.getWorkItem(workspaceId, workItemId);
      if (current.run.control !== "paused") throw new Error("工单不是用户暂停状态：" + workItemId);
      const prepared = await this.preparationReady(workspaceId, current);
      const blocked = await this.isWorkItemBlocked(workspaceId, workItemId);
      return this.mutateRecord(workspaceId, workItemId, (record) => {
        const now = this.now();
        const sessionId = record.execution.sessionId;
        return { ...record,
          item: { ...record.item, status: !prepared ? "preparing" : record.item.status === "decision" && !blocked ? "queued" : record.item.status, updatedAt: now },
          execution: { ...transitionControl(record.execution, { type: "resume", attemptId: createId("attempt") }), status: "pending", stage: sessionId ? "deliver" : "open",
            deliveries: record.execution.deliveries?.map((message) => message.state === "rejected" ? { ...message, state: "queued" as const, reason: undefined } : message),
            notices: [...record.execution.notices, pendingNotice("resumed", "用户已恢复执行。", now)],
            history: [...record.execution.history, { at: now, event: "resumed:user", message: "用户已恢复 Worker" }], updatedAt: now } };
      });
    });
  }

  async retryWorkItem(workspaceId: string, workItemId: string): Promise<WorkItem> {
    return this.integrate(workspaceId, async () => {
      const item = await this.getWorkItem(workspaceId, workItemId);
      if (item.run.pendingMessageId) throw new Error("消息受理状态不明，请先调用 workItem.confirm。");
      const action = (await this.listActions(workspaceId)).find((entry): entry is Execution => entry.kind === "execute" && entry.workItemId === workItemId && actionIsOpen(entry));
      if (!action || (!["retry", "decision"].includes(action.status) && action.control !== "manual")) throw new Error("当前工单没有可恢复的执行故障：" + workItemId);
      await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "pending", stage: current.sessionId ? "deliver" : "open",
        deliveries: current.deliveries?.map((message) => message.state === "rejected" ? { ...message, state: "queued" as const, reason: undefined } : message),
        attempts: 0, retryAt: undefined, failure: undefined, control: "auto", waitReason: undefined,
        pendingMessageId: undefined, attemptId: createId("attempt"), activeTurnId: undefined,
        history: [...current.history, { at: this.now(), event: "retry:user", message: "用户重新开始当前执行" }] }),
        (current) => ({ ...current, status: "queued" }));
      return this.getWorkItem(workspaceId, workItemId);
    });
  }

  async continueWorkItemFrom(workspaceId: string, workItemId: string, input: { sessionId: string; turnId: string }): Promise<WorkItem> {
    await this.transferExecution(workspaceId, { workItemId }, input);
    return this.getWorkItem(workspaceId, workItemId);
  }

  async continueWorkFrom(workspaceId: string, requestId: string, input: { sessionId: string; turnId: string }): Promise<WorkRequest> {
    await this.transferExecution(workspaceId, { requestId }, input);
    return (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === requestId)!;
  }

  private async transferExecution(workspaceId: string, target: { workItemId?: string; requestId?: string }, input: { sessionId: string; turnId: string }): Promise<void> {
    if (!this.executionTransfer) throw new Error("从历史节点继续执行需要桌面调度器在线。");
    const reason = "正在迁移执行，等待新分支就绪";
    const owner = await this.integrate(workspaceId, async () => {
      if (target.workItemId) {
        const item = await this.getWorkItem(workspaceId, target.workItemId);
        if (["closed", "cancelled"].includes(item.status)) throw new Error("已结束工单不能迁移执行");
        await this.mutateRecord(workspaceId, item.workItemId, (record) => ({ ...record,
          item: { ...record.item, status: "decision" }, execution: { ...transitionControl(record.execution, { type: "pause", reason }), status: "decision" } }));
        const decisions = (await this.listDecisions(workspaceId)).filter((card) => card.workItemId === item.workItemId && !card.answer && !card.withdrawn);
        return { sessionId: item.run.sessionId, attemptId: item.run.attemptId, title: "Worker · " + item.title,
          metadata: { role: "worker", workItemId: item.workItemId },
          summary: ["当前执行归属与有效进度", "workItemId: " + item.workItemId, "contractRevision: " + item.contractRevision,
            "目标: " + item.objective, "工作目录: " + (item.run.worktreePath ?? await this.workspaceRoot(workspaceId)),
            "已确认决策: " + JSON.stringify(item.decisions),
            "成果: " + JSON.stringify(item.evidence ?? {}), "待决策: " + JSON.stringify(decisions),
            "读取最新工单后继续，磁盘成果保持不变。"].join("\n") };
      }
      const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === target.requestId);
      if (!request || ["ready", "cancelled"].includes(request.status)) throw new Error("当前准备不能迁移执行");
      await this.updateWorkRequest(workspaceId, request.requestId, (current) => transitionControl(current, { type: "pause", reason }));
      return { sessionId: request.workerSessionId, attemptId: request.attemptId, title: "开工准备", metadata: { role: "work-preparation", requestId: request.requestId },
        summary: ["当前准备归属与有效进度", "requestId: " + request.requestId, "开工范围: " + (request.scope ?? ""),
          "已登记工单: " + JSON.stringify((await this.listWorkItems(workspaceId)).filter((item) => item.requestId === request.requestId)),
          "交接依据: " + JSON.stringify(request.handoff?.refs ?? []), "准备完成后登记完整交接。"].join("\n") };
    });
    if (owner.sessionId) {
      const unresolved = (await (await this.sessionDeliveries(workspaceId)).list()).some((message) => message.sessionId === owner.sessionId &&
        (["sending", "unknown"].includes(message.state) || this.inFlightMessages.has(message.messageId)));
      if (unresolved) throw new Error("原执行存在尚未确认的发送，保持暂停与原归属；请先确认消息受理结果。");
      await this.executionTransfer.interrupt(owner.sessionId);
      for (let attempt = 0; attempt < 40 && (this.workerActive?.(owner.sessionId) || this.workerSettling?.(owner.sessionId)); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.workerActive?.(owner.sessionId) || this.workerSettling?.(owner.sessionId)) throw new Error("原执行尚未退出，保持当前工作暂停状态。");
      const current = await this.executionBinding(owner.sessionId);
      const turnId = (current?.request ?? current?.item?.run)?.activeTurnId;
      if (turnId && this.turnInspector) {
        const inspected = await this.turnInspector(owner.sessionId, turnId);
        if (inspected.status !== "completed") throw new Error("原执行轮次尚未确认退出，保持暂停与原归属；请先确认轮次结果。");
      }
    }
    const forked = await this.executionTransfer.fork({ workspaceId, sourceSessionId: input.sessionId, sourceTurnId: input.turnId, title: owner.title, metadata: owner.metadata });
    const moveDeliveries = (messages: SessionDelivery[] = []) => messages.map((message) => !["queued", "rejected"].includes(message.state) ? message : message.decisionId
      ? { ...message, state: "queued" as const, sessionId: forked.sessionId, reason: undefined }
      : { ...message, state: "cancelled" as const, content: "", attachments: undefined, execution: undefined });
    await this.integrate(workspaceId, async () => {
      if (target.workItemId) await this.mutateRecord(workspaceId, target.workItemId, (record) => {
        if (record.execution.attemptId !== owner.attemptId || record.execution.sessionId !== owner.sessionId || record.execution.control !== "paused" || record.item.status === "cancelled") throw new Error("执行归属已改变，迁移未生效");
        return { ...record, item: { ...record.item, status: "queued" }, execution: {
          ...transitionControl(record.execution, { type: "resume", attemptId: createId("attempt") }), control: "manual",
          sessionId: forked.sessionId, forkSessionId: input.sessionId, forkTurnId: input.turnId, stage: "deliver", status: "pending",
          migratedFromSessionId: owner.sessionId, pendingMessageId: undefined, continuationSummary: owner.summary,
          notices: [], deliveries: moveDeliveries(record.execution.deliveries),
          waitReason: "已迁移到新分支，等待人工继续", updatedAt: this.now() } };
      });
      else {
        const request = (await this.listWorkRequests(workspaceId)).find((entry) => entry.requestId === target.requestId)!;
        if (request.attemptId !== owner.attemptId || request.workerSessionId !== owner.sessionId || request.control !== "paused" || request.status === "cancelled") throw new Error("执行归属已改变，迁移未生效");
        await this.updateWorkRequest(workspaceId, request.requestId, (current) => ({ ...transitionControl(current, { type: "resume", attemptId: createId("attempt") }), control: "manual",
          workerSessionId: forked.sessionId, status: "preparing", handoff: undefined, pendingMessageId: undefined,
          continuationSummary: owner.summary, migratedToSessionId: forked.sessionId, migratedFromSessionId: owner.sessionId,
          deliveries: moveDeliveries(current.deliveries),
          waitReason: "已迁移到新分支，等待人工继续" }));
        for (const item of await this.listWorkItems(workspaceId)) {
          if (item.requestId !== request.requestId || item.status !== "preparing") continue;
          await this.mutateRecord(workspaceId, item.workItemId, (record) => ({ ...record, execution: { ...record.execution,
            ...(record.execution.sessionId === owner.sessionId ? { sessionId: forked.sessionId, migratedFromSessionId: owner.sessionId } : {}),
            ...(record.execution.forkSessionId === owner.sessionId ? { forkSessionId: forked.sessionId, forkTurnId: undefined } : {}),
            activeTurnId: undefined, pendingMessageId: undefined } }));
        }
      }
      const { store } = await this.context(workspaceId);
      for (const card of await store.decisions.list()) {
        if (card.sessionId === owner.sessionId && (target.workItemId ? card.workItemId === target.workItemId : card.requestId === target.requestId))
          await store.decisions.put({ ...card, sessionId: forked.sessionId });
      }
      this.emit({ type: "decisions.changed", workspaceId });
    });
  }

  async settleManualTurn(sessionId: string, turnId: string): Promise<void> {
    for (const { workspaceId } of await this.listWorkspaces()) {
      await this.integrate(workspaceId, async () => {
        for (const request of await this.listWorkRequests(workspaceId)) {
          if (request.workerSessionId === sessionId && request.activeTurnId === turnId)
            await this.updateWorkRequest(workspaceId, request.requestId, (current) => transitionControl(current, { type: "settled", turnId }));
        }
        for (const item of await this.listWorkItems(workspaceId)) {
          if (item.run.sessionId !== sessionId || item.run.activeTurnId !== turnId) continue;
          await this.mutateRecord(workspaceId, item.workItemId, (record) => {
            const waiting = record.execution.control === "manual" && record.item.status === "running";
            return { ...record, item: { ...record.item, status: waiting ? "decision" : record.item.status },
              execution: { ...record.execution, activeTurnId: undefined,
                status: waiting ? "decision" : record.execution.status,
                waitReason: waiting ? "等待手动继续" : record.execution.waitReason, updatedAt: this.now() } };
          });
        }
      });
    }
  }

  private detachWorktree(record: WorkItemRecord, discard: boolean): WorkItemRecord {
    const { sessionId, worktreePath, branch } = record.execution;
    return { ...record,
      cleanup: worktreePath && branch ? [...record.cleanup, { sessionId, worktreePath, branch, discard }] : record.cleanup,
      execution: { ...record.execution, worktreePath: undefined, branch: undefined }
    };
  }

  async listWorktreeCleanup(workspaceId: string) {
    return (await (await this.context(workspaceId)).store.listRecords())
      .flatMap((record) => record.cleanup.map((candidate) => ({ workItemId: record.workItemId, ...candidate })));
  }

  /** A user can resume a completed worker directly, without reopening its work item. */
  async workerTurnCompleted(workspaceId: string, sessionId: string): Promise<void> {
    await this.integrate(workspaceId, async () => {
      this.releasedWorkers.delete(sessionId);
      const { store } = await this.context(workspaceId);
      for (const record of await store.listRecords()) {
        if (!record.cleanup.some((candidate) => candidate.sessionId === sessionId && candidate.detachedAt)) continue;
        await this.mutateRecord(workspaceId, record.workItemId, (current) => ({ ...current,
          cleanup: current.cleanup.map((candidate) => candidate.sessionId === sessionId ? { ...candidate, detachedAt: undefined } : candidate) }));
      }
    });
  }

  /** Requests unsubscribe only for idle terminal workers; never waits for native thread shutdown. */
  async releaseIdleWorkers(workspaceId: string): Promise<void> {
    await this.integrate(workspaceId, async () => {
      const items = await this.listWorkItems(workspaceId);
      const candidates = await this.listWorktreeCleanup(workspaceId);
      const owners = new Set(items.filter((item) => !["closed", "cancelled"].includes(item.status) || item.run.pendingMessageId || item.run.activeTurnId).map((item) => item.run.sessionId));
      for (const sessionId of owners) if (sessionId) this.releasedWorkers.delete(sessionId);
      for (const item of items) {
        const sessionId = item.run.sessionId;
        if (!sessionId || owners.has(sessionId) || this.workerActive?.(sessionId) || this.releasedWorkers.has(sessionId) || !this.releaseWorkerEnvironment) continue;
        const owned = candidates.filter((candidate) => candidate.sessionId === sessionId);
        if (owned.length && owned.every((candidate) => candidate.detachedAt)) continue;
        this.releasedWorkers.add(sessionId);
        try {
          void this.releaseWorkerEnvironment(sessionId).then(async () => {
            for (const candidate of owned) await this.mutateRecord(workspaceId, candidate.workItemId, (record) => ({ ...record,
              cleanup: record.cleanup.map((entry) => ["closed", "cancelled"].includes(record.item.status) && entry.sessionId === sessionId && entry.worktreePath === candidate.worktreePath && entry.branch === candidate.branch
                ? { ...entry, detachedAt: this.now() } : entry) }));
          }).catch(() => this.releasedWorkers.delete(sessionId));
        } catch { this.releasedWorkers.delete(sessionId); }
      }
    });
  }

  /** Only persisted, detached ownership can authorize deletion. Busy paths remain for the next sweep. */
  async cleanupWorktrees(workspaceId: string) {
    return this.integrate(workspaceId, async () => {
      const { docs } = await this.context(workspaceId);
      const removed: string[] = [];
      const retained: Array<{ workItemId?: string; worktreePath: string; reason: string }> = [];
      for (const candidate of await this.listWorktreeCleanup(workspaceId)) {
        const items = await this.listWorkItems(workspaceId);
        const reused = items.some((item) => (!["closed", "cancelled"].includes(item.status) || item.run.pendingMessageId || item.run.activeTurnId) &&
          ((candidate.sessionId && item.run.sessionId === candidate.sessionId) || item.run.branch === candidate.branch ||
            (item.run.worktreePath && this.sameWorktreePath(item.run.worktreePath, candidate.worktreePath))));
        let reason = reused ? "owned" :
          candidate.sessionId && this.workerActive?.(candidate.sessionId) ? "active" :
          candidate.sessionId && !candidate.detachedAt ? "subscribed" : undefined;
        if (!reason) {
          try {
            await docs.dropWorktree(candidate.worktreePath, candidate.branch, candidate.discard);
            await this.mutateRecord(workspaceId, candidate.workItemId, (record) => ({ ...record,
              cleanup: record.cleanup.filter((entry) => entry.worktreePath !== candidate.worktreePath || entry.branch !== candidate.branch) }));
            removed.push(candidate.worktreePath);
          } catch (error) { reason = error instanceof Error ? error.message : String(error); }
        }
        if (reason) retained.push({ workItemId: candidate.workItemId, worktreePath: candidate.worktreePath, reason });
      }
      for (const draft of await docs.listDrafts()) {
        const reason = await this.draftCleanupBlocker(workspaceId, docs, draft);
        if (reason) { retained.push({ worktreePath: draft.path, reason }); continue; }
        try {
          await docs.dropWorktree(draft.path, draft.branch, true);
          removed.push(draft.path);
        } catch (error) {
          retained.push({ worktreePath: draft.path, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { removed, retained };
    });
  }

  /**
   * Why a document draft must stay: an unfinished work item, unfetched main branch work, or its own
   * edits. A draft that holds nothing the main branch lacks is safe to recycle even while its session
   * is open: the next write creates the draft again at the main branch tip and finds the same files.
   */
  private async draftCleanupBlocker(workspaceId: string, docs: DocsService, draft: DocDraft): Promise<string | undefined> {
    const owned = (await this.listWorkItems(workspaceId)).some((item) =>
      !["closed", "cancelled"].includes(item.status) && !!item.treeId && draftKey(item.treeId) === draft.treeId);
    if (owned) return "该会话树仍有未结束工单";
    try {
      await docs.syncDraft(draft);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return await docs.draftMerged(draft) ? undefined : "草稿仍有未合入的文档修改";
  }

  private sameWorktreePath(left: string, right: string): boolean {
    const normalize = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    return normalize(left) === normalize(right);
  }

  async updateWorkItem(
    workspaceId: string,
    workItemId: string,
    input: Partial<Pick<WorkItem, "title" | "objective" | "refs" | "scope" | "acceptance" | "risk" | "needs" | "dependsOn">> & {
      note: string; worktreePath?: string; branch?: string; sessionId?: string;
    }
  ): Promise<WorkItem> {
    return this.integrate(workspaceId, () => this.updateWorkItemRecord(workspaceId, workItemId, input));
  }

  private async updateWorkItemRecord(workspaceId: string, workItemId: string, input: Parameters<WorkbenchService["updateWorkItem"]>[2]): Promise<WorkItem> {
    const { note, worktreePath, branch, sessionId, ...rawChanges } = input;
    const changes = rawChanges.refs === undefined ? rawChanges : { ...rawChanges, refs: await this.validateWorkItemRefs(workspaceId, rawChanges.refs) };
    if (!!worktreePath !== !!branch) throw new Error("worktreePath 与 branch 必须同时提供。");
    if (changes.needs?.some((need) => ["browser", "desktop"].includes(need.trim()))) throw new Error("needs 必须指明具体共享实例。");
    const current = await this.getWorkItem(workspaceId, workItemId);
    // A worker editing its own item reads its own contract, so it is not a notice to deliver.
    const selfOriginated = !!sessionId && sessionId === current.run.sessionId;
    if (changes.dependsOn) await this.checkDependencies(workspaceId, workItemId, changes.dependsOn);
    const occupied = changes.needs?.length
      ? new Set((await this.listWorkItems(workspaceId)).filter((item) => item.workItemId !== workItemId && item.status === "running").flatMap((item) => item.needs))
      : new Set<string>();
    const updated = await this.mutateRecord(workspaceId, workItemId, (record) => {
      const { execution, item } = record;
      if (item.status === "closed" || item.status === "cancelled") throw new Error("Work item is " + item.status + ": " + workItemId);
      const conflict = item.status === "running" ? changes.needs?.find((need) => occupied.has(need)) : undefined;
      if (conflict !== undefined) throw new Error("Resource is in use: " + conflict + ". Release it before updating this running work item.");
      const status = item.status;
      // Only the fields that state what to deliver move the revision a submission has to match.
      const deliverableChanged = (["objective", "scope", "acceptance", "refs"] as const)
        .some((field) => changes[field] !== undefined && JSON.stringify(changes[field]) !== JSON.stringify(item[field]));
      const dependencyChanged = changes.dependsOn !== undefined && JSON.stringify(changes.dependsOn) !== JSON.stringify(item.dependsOn);
      const acceptanceChanged = changes.acceptance && JSON.stringify(changes.acceptance) !== JSON.stringify(item.acceptance);
      let verify = item.verify;
      let history = execution.history;
      if (acceptanceChanged && verify) {
        // An index locates a result only within its original acceptance list.
        const key = (entry: WorkItem["acceptance"][number]) => JSON.stringify([entry.text, entry.source ?? null]);
        const previousKeys = item.acceptance.map(key);
        const nextKeys = changes.acceptance!.map(key);
        const previousResults = new Map(verify.items.map((entry) => [entry.index, entry]));
        const items = nextKeys.map((value, index) => {
          const previousIndex = previousKeys.indexOf(value);
          const unambiguous = previousIndex >= 0 && previousKeys.lastIndexOf(value) === previousIndex &&
            nextKeys.indexOf(value) === nextKeys.lastIndexOf(value);
          const previous = unambiguous ? previousResults.get(previousIndex) : undefined;
          return previous ? { ...previous, index } : { index, status: "incomplete" as const, evidence: "当前验收条目尚未验证。" };
        });
        history = [...history, { at: this.now(), event: "acceptance.updated",
          message: "合同修订 " + item.contractRevision + " 的验收记录：\n" + JSON.stringify({ acceptance: item.acceptance, verify }) }];
        verify = { ...verify, items, verdict: verify.verdict === "pass" && items.every((entry) => entry.status === "pass") ? "pass" : "rework" };
      } else if (deliverableChanged || dependencyChanged) {
        history = [...history, { at: this.now(), event: deliverableChanged ? "contract.updated" : "dependency.updated", message: note }];
      }
      // While parked the note lives on the decision card and reaches the worker inside the answer line.
      const decisions = status === "decision" ? item.decisions : [...item.decisions, "工单调整：" + note];
      return {
        ...record,
        item: { ...item, ...changes, verify, ...(deliverableChanged ? { contractRevision: item.contractRevision + 1 } : {}), status, decisions, updatedAt: this.now() },
        execution: { ...execution, history, ...(worktreePath ? { worktreePath, branch } : {}),
          notices: status === "decision" || selfOriginated ? execution.notices
            : [...execution.notices, pendingNotice("contract", note + "\n" + rereadContract, this.now())], updatedAt: this.now() }

      };
    });
    if (changes.dependsOn?.some((id) => !current.dependsOn.includes(id)) && updated.status === "running") {
      await this.mutateRecord(workspaceId, workItemId, (record) => ({ ...record,
        item: { ...record.item, status: "queued", updatedAt: this.now() },
        execution: { ...record.execution, updatedAt: this.now(),
          notices: [...record.execution.notices, pendingNotice("resumed", "依赖调整已落实。前置关闭后读取最新合同，rebase 后继续。", this.now())] } }));
    }
    if (!selfOriginated && updated.status === "running" && updated.run.sessionId) this.emit({ type: "workItem.updated", workspaceId, workItemId, sessionId: updated.run.sessionId });
    // Parked on a decision: the user reads the change on the card before answering; the answer carries it to the worker.
    {
      const { store } = await this.context(workspaceId);
      for (const card of (await store.decisions.list()).filter((c) => c.workItemId === workItemId && !c.answer && !c.withdrawn)) {
        await store.decisions.put({ ...card, adjustments: [...(card.adjustments ?? []), { note, at: this.now() }] });
        this.emit({ type: "decisions.changed", workspaceId });
      }
    }
    return this.getWorkItem(workspaceId, workItemId);
  }

  private async checkDependencies(workspaceId: string, workItemId: string, dependsOn: string[]): Promise<void> {
    const items = await this.listWorkItems(workspaceId);
    const graph = new Map(items.map((item) => [item.workItemId, item.dependsOn]));
    graph.set(workItemId, dependsOn);
    const visit = (id: string, chain: string[]): void => {
      if (chain.includes(id)) throw new Error("循环依赖：" + [...chain, id].join(" → "));
      const children = graph.get(id);
      if (!children) throw new Error("前置工单不存在：" + id + "。请调整 dependsOn。");
      for (const child of children) visit(child, [...chain, id]);
    };
    visit(workItemId, []);
  }

  /**
   * Scheduler: the worker session ended without submit or decision. Back to the queue with the failure noted; after
   * four delayed retries the item is parked on a decision card instead so the user sees it.
   */
  async requeueWorkItem(workspaceId: string, workItemId: string, failure: string): Promise<WorkItem> {
    await this.refreshActions(workspaceId);
    const action = (await this.listActions(workspaceId)).find((entry) => entry.kind === "execute" && entry.workItemId === workItemId && actionIsOpen(entry));
    if (action) await this.failAction(workspaceId, action.actionId, failure);
    return this.getWorkItem(workspaceId, workItemId);
  }

  // ---- scheduler ----

  async getScheduler(workspaceId: string): Promise<Scheduler> {
    return (await this.context(workspaceId)).store.readScheduler();
  }

  async setScheduler(workspaceId: string, value: Scheduler): Promise<Scheduler> {
    const saved = await (await this.context(workspaceId)).store.writeScheduler(value);
    this.emit({ type: "scheduler.changed", workspaceId });
    return saved;
  }

  async listRuns(workspaceId: string): Promise<AgentRun[]> {
    const list = await (await this.context(workspaceId)).store.runs.list();
    return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async putRun(workspaceId: string, run: AgentRun): Promise<AgentRun> {
    const saved = await (await this.context(workspaceId)).store.runs.put(run);
    this.emit({ type: "runs.changed", workspaceId });
    return saved;
  }

  async workspaceRoot(workspaceId: string): Promise<string> {
    return (await this.context(workspaceId)).rootPath;
  }

  // ---- decisions ----

  async listDecisions(workspaceId: string): Promise<DecisionCard[]> {
    return (await this.context(workspaceId)).store.decisions.list();
  }

  /** Parks the linked work item (if any) until the user answers. */
  async createDecision(workspaceId: string, input: Omit<DecisionCard, "decisionId" | "createdAt" | "answer">): Promise<DecisionCard> {
    const { store } = await this.context(workspaceId);
    const action = input.actionId ? await this.getAction(workspaceId, input.actionId) : (await this.listActions(workspaceId)).find((a) => actionIsOpen(a) && a.kind === "execute" && (input.workItemId ? a.workItemId === input.workItemId : a.sessionId === input.sessionId));
    if (action && !actionIsOpen(action)) throw new Error("处理过程已结束，不能再挂起决策。");
    const card = await store.decisions.put({ ...input, actionId: action?.actionId, decisionId: createId("d"), createdAt: this.now() });
    if (action) await this.updateAction(workspaceId, action,
      (action) => ({ ...action, status: "decision", history: [...action.history, { at: this.now(), event: "decision.created", message: card.decisionId + " " + card.question }] }),
      action.kind === "execute" && input.workItemId ? (item) => ["running", "queued"].includes(item.status) ? { ...item, status: "decision" } : item : undefined);
    this.emit({ type: "decisions.changed", workspaceId });
    return card;
  }

  /**
   * Records the answer on the card and on the work item, which goes back to the queue. Either an option key, a free
   * note, or both; the work item's decision line carries the answer plus any contract adjustments made while parked,
   * so the worker's resume message has everything in one place.
   */
  async answerDecision(workspaceId: string, decisionId: string, answer: { key?: string; note?: string }): Promise<DecisionCard> {
    const { store } = await this.context(workspaceId);
    const card = await store.decisions.get(decisionId);
    if (!card) throw new Error("Unknown decision: " + decisionId);
    if (card.answer || card.withdrawn) throw new Error("决策已答复或撤回，不能重复答复。");
    if (card.kind === "attempts" && (!answer.key || answer.note?.trim())) throw new Error("运行故障请选择重试或取消，不接受备注答复。");
    if (!answer.key && !answer.note?.trim()) throw new Error("Answer needs an option key or a note");
    if (answer.key && !card.options.some((o) => o.key === answer.key)) throw new Error("Unknown option: " + answer.key);
    const answered = await store.decisions.put({ ...card, answer: { ...answer, at: this.now() }, deliveryPending: true });
    await this.flushDecision(workspaceId, answered);
    this.emit({ type: "decisions.changed", workspaceId });
    return (await store.decisions.get(decisionId))!;
  }

  private async flushDecision(workspaceId: string, card: DecisionCard): Promise<void> {
    const key = workspaceId + ":" + card.decisionId;
    const existing = this.decisionDeliveries.get(key);
    if (existing) return existing;
    const delivery = Promise.resolve().then(async () => {
      if (!card.answer) return;
      const message = "用户决策答复：" + describeAnswer(card, card.answer);
      const accepted = await this.deliverDecision(workspaceId, card, message, card.answer?.key === "cancel" || card.answer?.key === "retry" ? card.answer.key : undefined);
      if (!accepted) return;
      const { store } = await this.context(workspaceId);
      await store.decisions.put({ ...(await store.decisions.get(card.decisionId))!, deliveryPending: false });
    });
    this.decisionDeliveries.set(key, delivery);
    try { await delivery; } finally { this.decisionDeliveries.delete(key); }
  }

  private async deliverDecision(workspaceId: string, card: DecisionCard, message: string, recoveryChoice?: string): Promise<boolean> {
    if (card.requestId && card.kind !== "worker" && !card.workItemId && !card.actionId) {
      if (recoveryChoice === "retry") await this.retryWork(workspaceId, card.requestId);
      if (recoveryChoice === "cancel") for (const item of await this.listWorkItems(workspaceId)) {
        if (item.requestId === card.requestId && !["closed", "cancelled"].includes(item.status)) await this.cancelWorkItem(workspaceId, item.workItemId);
      }
      return true;
    }
    const action = card.actionId ? await this.getAction(workspaceId, card.actionId) : undefined;
    const cards = await this.listDecisions(workspaceId);
    const recordAnswer = (item: WorkItemRecord["item"]): WorkItemRecord["item"] => ({ ...item,
      status: item.status === "decision" && action?.kind === "execute" && action.control !== "paused" && !cards.some((other) => other.workItemId === item.workItemId && !other.answer && !other.withdrawn) ? "queued" : item.status,
      decisions: item.decisions.includes(message) ? item.decisions : [...item.decisions, message] });
    if (!action || !actionIsOpen(action)) {
      if (card.workItemId) await this.mutateRecord(workspaceId, card.workItemId, (record) => ({ ...record, item: { ...recordAnswer(record.item), updatedAt: this.now() } }));
      return true;
    }
    if (recoveryChoice === "cancel") {
      {
        const id = action.workItemId;
        const item = await this.getWorkItem(workspaceId, id);
        if (item.status !== "closed" && item.status !== "cancelled") await this.cancelWorkItem(workspaceId, id);
        else for (const pending of await this.listActions(workspaceId)) if (pending.kind === "integration" && pending.workItemId === id && actionIsOpen(pending)) await this.updateAction(workspaceId, pending, (pending) => ({ ...pending, status: "cancelled" }));
      }
      await this.updateAction(workspaceId, action, (current) => ({ ...current, status: "cancelled", history: [...current.history, { at: this.now(), event: "decision.cancelled", message, decisionId: card.decisionId }] }), card.workItemId ? recordAnswer : undefined);
      return true;
    }
    if (action.kind === "execute") {
      if (!action.sessionId) return false;
      if (!action.history.some((entry) => entry.decisionId === card.decisionId)) await this.updateAction(workspaceId, action, (current) => ({ ...current,
        ...(recoveryChoice === "retry" ? { attempts: 0, failure: undefined, retryAt: undefined } : {}),
        history: [...current.history, { at: this.now(), event: "decision.answered", message, decisionId: card.decisionId }] }), recordAnswer);
      const receipt = await this.dispatchSessionMessage({ sessionId: action.sessionId, messageId: "decision-" + card.decisionId,
        content: "【恢复执行】" + message, decisionId: card.decisionId, origin: action.control === "manual" ? "user" : "scheduler" },
        this.messageDeliveryPort ?? (this.sessionSteerer ? async (input) => {
          const result = await this.sessionSteerer!(input);
          return { accepted: result.accepted ?? (!result.queued && !result.error), queued: result.queued, error: result.error, turnId: result.turnId,
            delivery: result.delivery === "queued" ? undefined : result.delivery };
        } : async () => ({ accepted: false, queued: { messageId: "decision-" + card.decisionId, reason: "等待桌面会话在线" } })));
      return receipt.accepted;
    }
    if (action.history.some((entry) => entry.decisionId === card.decisionId)) return true;
    const waiting = cards.some((other) => other.actionId === action.actionId && !other.answer && !other.withdrawn);
    await this.updateAction(workspaceId, action, (current) => {
      const now = this.now();
      const answered = { status: waiting ? "decision" as const : "pending" as const,
        ...(recoveryChoice === "retry" ? { attempts: 0, failure: undefined, retryAt: undefined } : {}),
        history: [...current.history, { at: now, event: "decision.answered", message, decisionId: card.decisionId }] };
      return { ...current, ...answered };
    }, card.workItemId ? recordAnswer : undefined);
    return true;
  }

  // ---- inbox ----

  async listInbox(includeProcessed = false): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const workspace of await this.listWorkspaces()) {
      const { store } = await this.context(workspace.workspaceId);
      for (const card of await store.decisions.list()) {
        if (card.answer ? includeProcessed : !card.withdrawn) items.push({ kind: "decision", workspaceId: workspace.workspaceId, card });
      }
      const actions = await this.listActions(workspace.workspaceId);
      for (const workItem of await this.listWorkItems(workspace.workspaceId)) {
        const integration = actions.find((action): action is Integration => action.kind === "integration" && action.workItemId === workItem.workItemId &&
          action.stage === "merge" && actionIsOpen(action) &&
          ((!action.agent && ["retry", "decision"].includes(action.status)) || (!!action.agent && !!workItem.run.retryAt)));
        if (integration) items.push({ kind: "integration", workspaceId: workspace.workspaceId, workItem, action: integration });
        if (!workItem.merge || (workItem.merge.acknowledgedAt ? !includeProcessed : workItem.status !== "closed")) continue;
        items.push({ kind: "merged", workspaceId: workspace.workspaceId, workItem });
      }
    }
    return items;
  }
}

/** "question -> chosen option (note)" or "question -> 备注：note", followed by the contract changes made while the card waited. */
const describeAnswer = (card: DecisionCard, answer: { key?: string; note?: string }): string => {
  const option = card.options.find((o) => o.key === answer.key);
  const note = answer.note?.trim();
  const chosen = option ? option.label + (note ? " (" + note + ")" : "") : "备注：" + note;
  const adjustments = (card.adjustments ?? []).map((a) => "；挂起期间工单调整：" + a.note).join("");
  return card.question + " -> " + chosen + adjustments;
};

const watchedAreas: Record<string, Exclude<Extract<WorkbenchEvent, { workspaceId: string }>, { sessionId: string } | { workItemId: string } | { requestId: string }>["type"] | undefined> = {
  docs: "docs.changed",
  roles: "roles.changed",
  domains: "domains.changed",
  patrols: "domains.changed",
  "work-requests": "workRequests.changed",
  workitems: "workItems.changed",
  decisions: "decisions.changed",
  runs: "runs.changed",
  actions: "actions.changed",
  "scheduler.json": "scheduler.changed"
};
