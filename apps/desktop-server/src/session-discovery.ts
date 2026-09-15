import type {
  ChatSession,
  Conversation,
  MessageBlock,
  SessionRelation,
  SessionStatus,
  TerminalStream,
  ToolCall,
  Turn
} from "@vermillion/shared";
import {
  appendLimitedStreamText,
  parseChatSession,
  parseConversation,
  parseMessageBlock,
  parseSessionRelation,
  parseTerminalStream,
  parseToolCall,
  parseTurn
} from "@vermillion/shared";
import { readTurnExecutionProfiles } from "@vermillion/shared";
import type {
  SessionIndexEntry,
  SessionRelationIndex,
  SessionIndexStore,
  UpsertSessionIndexInput,
  UpsertSessionRelationInput
} from "./session-index.js";
import type { WorkspaceRecord, WorkspaceRegistryService } from "./workspace-registry.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";

export const discoveredConversationId = (rootSessionId: string): string =>
  `conversation-discovered:${rootSessionId}`;

export const buildRelationId = (
  parentSessionId: string,
  childSessionId: string,
  relationType: SessionRelation["relationType"]
): string => `relation-discovered:${parentSessionId}:${childSessionId}:${relationType}`;


export type DiscoveredSessionRecord = {
  sessionId: string;
  engineId: string;
  providerKind: string;
  providerSessionId: string;
  title: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
  lastCompletedTurnAt?: string;
  archivedAt?: string;
  metadata?: Record<string, unknown>;
};

export type DiscoveredSessionRelation = {
  parentSessionId: string;
  childSessionId: string;
  relationType: "fork" | "subagent";
  createdAt: string;
};

export type DiscoveredWorkspaceResult = {
  sessions: DiscoveredSessionRecord[];
  relations: DiscoveredSessionRelation[];
};

export type HydratedTurn = Turn & {
  finalMessageId?: string;
};

export type HydratedSessionSnapshot = {
  workspaceId: string;
  conversation: Conversation;
  session: ChatSession;
  turns: HydratedTurn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  sessionRelations: SessionRelation[];
  runtimeBinding?: {
    providerKind: string;
    providerSessionId: string;
  };
};

export type HydratedSessionWindowSnapshot = HydratedSessionSnapshot & {
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
};

export type SessionDiscoveryProvider = {
  readonly engineId: string;
  discoverWorkspaces: (
    workspaces: readonly WorkspaceRecord[]
  ) => Promise<ReadonlyMap<string, DiscoveredWorkspaceResult>>;
  hydrateSession: (
    entry: SessionIndexEntry,
    input?: {
      signal?: AbortSignal;
      retainExecution?: boolean;
      historySources?: { entry: SessionIndexEntry; sourceTurnIds: string[] }[];
    }
  ) => Promise<HydratedSessionSnapshot | undefined>;
  hydrateSessionWindow?: (
    entry: SessionIndexEntry,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      signal?: AbortSignal;
      retainExecution?: boolean;
    }
  ) => Promise<HydratedSessionWindowSnapshot | undefined>;
  ensureSessionExecutable?: (
    entry: SessionIndexEntry,
    input?: { signal?: AbortSignal }
  ) => Promise<boolean>;
  /** 引擎报告会话已在引擎侧归档时返回 true，对账层据此归档索引项而不是中断读取。 */
  isSessionArchivedError?: (entry: SessionIndexEntry, error: unknown) => boolean;
};

/** 不携带 signal 的调用方视为不会取消读取。 */
const uncancellableSignal = new AbortController().signal;

type SharedHydrationTask<T> = {
  promise: Promise<T>;
  /** 共享任务自己的 signal；已取消的任务不再接受新消费者。 */
  signal: AbortSignal;
  addConsumer: (signal: AbortSignal | undefined) => void;
};

/**
 * 同一段历史读取可由多个调用方共享，只有全部调用方都取消时才中止底层请求；
 * 共享任务持有自己的 signal，读取方只需判断这一个 signal。
 */
const shareHydration = <T>(
  start: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined
): SharedHydrationTask<T> => {
  const controller = new AbortController();
  const consumers = new Set<AbortSignal>();
  const abortIfAllConsumersCancelled = (): void => {
    if ([...consumers].every((consumer) => consumer.aborted)) {
      controller.abort();
    }
  };
  const addConsumer = (next: AbortSignal | undefined): void => {
    const consumer = next ?? uncancellableSignal;
    consumers.add(consumer);
    if (consumer.aborted) {
      abortIfAllConsumersCancelled();
      return;
    }
    consumer.addEventListener("abort", abortIfAllConsumersCancelled, { once: true });
  };
  addConsumer(signal);
  return { promise: start(controller.signal), signal: controller.signal, addConsumer };
};

/** 任务收尾时只清理仍属于本次的登记，避免覆盖接管同一 key 的新任务。 */
const clearSharedHydration = <T>(
  registry: Map<string, SharedHydrationTask<T>>,
  key: string,
  task: SharedHydrationTask<T>
): void => {
  if (registry.get(key) === task) {
    registry.delete(key);
  }
};

const resolveHydratedLastCompletedTurnAt = (
  turns: readonly HydratedTurn[]
): string | undefined => {
  let latestCompletedAt: string | undefined;
  for (const turn of turns) {
    if (turn.status !== "completed" || !turn.completedAt) {
      continue;
    }
    if (!latestCompletedAt || turn.completedAt > latestCompletedAt) {
      latestCompletedAt = turn.completedAt;
    }
  }
  return latestCompletedAt;
};

const resolveHydratedLastUserMessageAt = (
  messageBlocks: readonly MessageBlock[]
): string | undefined => {
  let latestUserMessageAt: string | undefined;
  for (const messageBlock of messageBlocks) {
    if (messageBlock.role !== "user") {
      continue;
    }
    if (!latestUserMessageAt || messageBlock.startedAt > latestUserMessageAt) {
      latestUserMessageAt = messageBlock.startedAt;
    }
  }
  return latestUserMessageAt;
};

const isActiveSessionStatus = (status: SessionStatus): boolean =>
  status === "running" || status === "awaiting_approval";

const mergeTurnIds = (...lists: readonly string[][]): string[] => [
  ...new Set(lists.flat())
];

export const latestIso = (
  left: string | undefined,
  right: string | undefined
): string | undefined => {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs > rightMs ? left : right;
  }
  return left > right ? left : right;
};

export class SessionReconciliationService {
  private readonly workspaceRegistry: WorkspaceRegistryService;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly runtimeService: SessionRuntimeService;
  private readonly providersByEngineId: Map<string, SessionDiscoveryProvider>;
  private readonly sessionIdentity: SessionIdentityRegistry;
  private readonly hydrationBySessionId = new Map<
    string,
    SharedHydrationTask<boolean>
  >();
  private readonly fullyHydratedSessionIds = new Set<string>();
  private readonly windowHydrationByKey = new Map<
    string,
    SharedHydrationTask<HydratedSessionWindowSnapshot | undefined>
  >();
  private repairQueue: Promise<void> = Promise.resolve();

  public constructor(options: {
    workspaceRegistry: WorkspaceRegistryService;
    sessionIndexStore: SessionIndexStore;
    runtimeService: SessionRuntimeService;
    sessionIdentity?: SessionIdentityRegistry;
    capabilityRegistry?: CapabilityRegistry;
    providers?: SessionDiscoveryProvider[];
  }) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.runtimeService = options.runtimeService;
    this.sessionIdentity =
      options.sessionIdentity ??
      new SessionIdentityRegistry({
        runtimeService: options.runtimeService,
        sessionIndexStore: options.sessionIndexStore
      });
    this.providersByEngineId = new Map(
      (options.providers ?? options.capabilityRegistry?.listSessionDiscoveryProviders() ?? []).map(
        (provider) => [provider.engineId, provider] as const
      )
    );
  }

  public repairWorkspaces(workspaceIds: readonly string[]): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    const normalizedWorkspaceIds = [...new Set(workspaceIds)];
    const repair = this.repairQueue.then(() =>
      this.runWorkspaceRepair(normalizedWorkspaceIds)
    );
    this.repairQueue = repair.then(
      () => undefined,
      () => undefined
    );
    return repair;
  }

  private async runWorkspaceRepair(workspaceIds: readonly string[]): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    await this.workspaceRegistry.ready();
    await this.sessionIndexStore.ready();
    const workspaces = workspaceIds
      .map((workspaceId) => this.workspaceRegistry.getWorkspace(workspaceId))
      .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));

    if (workspaces.length === 0) {
      return {
        workspaces: 0,
        sessions: 0,
        relations: 0
      };
    }

    let sessionCount = 0;
    let relationCount = 0;

    for (const provider of this.providersByEngineId.values()) {
      const discoveredByWorkspaceId = await provider.discoverWorkspaces(workspaces);
      for (const workspace of workspaces) {
        const discovered = discoveredByWorkspaceId.get(workspace.workspaceId);
        if (!discovered) {
          throw new Error(
            `Session discovery provider ${provider.engineId} omitted workspace ${workspace.workspaceId}.`
          );
        }
        const sessionIdAliases = this.buildSessionIdAliases(
          workspace.workspaceId,
          discovered.sessions
        );
        const normalizedSessions = discovered.sessions.map((session) => ({
          ...session,
          sessionId: sessionIdAliases.get(session.sessionId) ?? session.sessionId
        }));
        const normalizedRelations = discovered.relations.map((relation) => ({
          ...relation,
          parentSessionId:
            sessionIdAliases.get(relation.parentSessionId) ?? relation.parentSessionId,
          childSessionId:
            sessionIdAliases.get(relation.childSessionId) ?? relation.childSessionId
        }));
        const conversationIdBySessionId = buildConversationMap(
          normalizedSessions,
          normalizedRelations
        );
        const entries: UpsertSessionIndexInput[] = normalizedSessions.map((session) => ({
          workspaceId: workspace.workspaceId,
          session: {
            sessionId: session.sessionId,
            conversationId:
              conversationIdBySessionId.get(session.sessionId) ??
              discoveredConversationId(session.sessionId),
            engineId: session.engineId,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            archivedAt: session.archivedAt,
            metadata: session.metadata
          },
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId,
          summaryText: session.summaryText,
          lastCompletedTurnAt: session.lastCompletedTurnAt,
          source: "reconciled"
        }));
        const relations: UpsertSessionRelationInput[] = normalizedRelations.map((relation) => ({
          workspaceId: workspace.workspaceId,
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType,
          createdAt: relation.createdAt
        }));

        const result = await this.sessionIndexStore.applyWorkspaceRepair({
          workspaceId: workspace.workspaceId,
          engineId: provider.engineId,
          entries,
          relations
        });
        sessionCount += result.sessionCount;
        relationCount += result.relationCount;
      }
    }

    return {
      workspaces: workspaces.length,
      sessions: sessionCount,
      relations: relationCount
    };
  }

  private buildSessionIdAliases(
    workspaceId: string,
    sessions: DiscoveredSessionRecord[]
  ): Map<string, string> {
    const aliases = new Map<string, string>();

    for (const session of sessions) {
      const existingSessionId = this.sessionIdentity.resolveWorkbenchSessionId(
        {
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId
        },
        workspaceId
      );
      if (existingSessionId) {
        aliases.set(session.sessionId, existingSessionId);
      }
    }

    return aliases;
  }

  public async ensureSessionLoaded(
    sessionId: string,
    input: {
      force?: boolean;
      requireFull?: boolean;
      signal?: AbortSignal;
      retainExecution?: boolean;
    } = {}
  ): Promise<boolean> {
    const loaded = this.runtimeService
      .listSessions({ includeArchived: true })
      .some((session) => session.sessionId === sessionId);
    if (
      loaded &&
      !input.force &&
      (!input.requireFull || this.fullyHydratedSessionIds.has(sessionId))
    ) {
      const existingHydration = this.reusableHydration(sessionId);
      if (!existingHydration) {
        return true;
      }
      existingHydration.addConsumer(input.signal);
      const loadedByExisting = await existingHydration.promise;
      return input.signal?.aborted ? false : loadedByExisting;
    }

    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return false;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider) {
      return false;
    }
    const existingHydration = this.reusableHydration(sessionId);
    if (existingHydration) {
      existingHydration.addConsumer(input.signal);
      const loadedByExisting = await existingHydration.promise;
      return input.signal?.aborted ? false : loadedByExisting;
    }
    const hydration: SharedHydrationTask<boolean> = shareHydration(
      (signal) => this.hydrateSessionEntry(entry, provider, {
        signal,
        retainExecution: input.retainExecution
      }),
      input.signal
    );
    this.hydrationBySessionId.set(sessionId, hydration);
    hydration.promise = hydration.promise.finally(() =>
      clearSharedHydration(this.hydrationBySessionId, sessionId, hydration)
    );
    const loadedByHydration = await hydration.promise;
    return input.signal?.aborted ? false : loadedByHydration;
  }

  /** 已经取消的共享任务不再复用：新调用方需要重新发起读取。 */
  private reusableHydration(
    sessionId: string
  ): SharedHydrationTask<boolean> | undefined {
    const existing = this.hydrationBySessionId.get(sessionId);
    return existing && !existing.signal.aborted ? existing : undefined;
  }

  public async ensureSessionExecutable(
    sessionId: string,
    input: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return false;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider?.ensureSessionExecutable) {
      return true;
    }
    return provider.ensureSessionExecutable(entry, input);
  }

  public async hydrateSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      signal?: AbortSignal;
      retainExecution?: boolean;
    }
  ): Promise<HydratedSessionWindowSnapshot | undefined> {
    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return undefined;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider?.hydrateSessionWindow) {
      return undefined;
    }
    const anchorTurnId = input.cursor ? undefined : input.anchorTurnId;
    const hydrationKey = `${sessionId}\u0000${input.cursor ?? ""}\u0000${
      anchorTurnId ?? ""
    }\u0000${input.limit}`;
    const reusable = this.windowHydrationByKey.get(hydrationKey);
    const existingHydration = reusable && !reusable.signal.aborted ? reusable : undefined;
    if (existingHydration) {
      existingHydration.addConsumer(input.signal);
      const hydrated = await existingHydration.promise;
      return input.signal?.aborted ? undefined : hydrated;
    }
    const hydration: SharedHydrationTask<HydratedSessionWindowSnapshot | undefined> =
      shareHydration(
      (signal) => provider
        .hydrateSessionWindow!(entry, {
          limit: input.limit,
          cursor: input.cursor,
          anchorTurnId,
          signal,
          retainExecution: input.retainExecution
        })
        .then(async (hydrated) => {
          if (!hydrated || signal.aborted) {
            return undefined;
          }
          return this.commitHydratedSession(entry, hydrated, { partial: true });
        }),
      input.signal
    );
    this.windowHydrationByKey.set(hydrationKey, hydration);
    hydration.promise = hydration.promise.finally(() =>
      clearSharedHydration(this.windowHydrationByKey, hydrationKey, hydration)
    );
    const hydrated = await hydration.promise;
    if (!hydrated || input.signal?.aborted) {
      return undefined;
    }
    return hydrated;
  }

  private async hydrateSessionEntry(
    entry: SessionIndexEntry,
    provider: SessionDiscoveryProvider,
    input: {
      signal?: AbortSignal;
      retainExecution?: boolean;
    } = {}
  ): Promise<boolean> {
    let hydrated: HydratedSessionSnapshot | undefined;
    try {
      const historySources: { entry: SessionIndexEntry; sourceTurnIds: string[] }[] = [];
      if (entry.archivedAt) {
        const forks = this.sessionIndexStore.listRelations(entry.workspaceId)
          .filter((relation) => relation.relationType === "fork");
        const visit = (parentSessionId: string, sourceTurnIds: string[] = []): void => {
          for (const fork of forks.filter((relation) => relation.parentSessionId === parentSessionId)) {
            const child = this.sessionIndexStore.getEntry(fork.childSessionId);
            if (!child || !fork.sourceTurnId) continue;
            const boundaries = [...sourceTurnIds, fork.sourceTurnId];
            if (child.archivedAt) visit(child.sessionId, boundaries);
            else historySources.push({ entry: child, sourceTurnIds: boundaries });
          }
        };
        visit(entry.sessionId);
      }
      hydrated = await provider.hydrateSession(entry, {
        signal: input.signal,
        retainExecution: input.retainExecution,
        historySources: entry.archivedAt ? historySources : undefined
      });
    } catch (error) {
      if (!provider.isSessionArchivedError?.(entry, error)) {
        throw error;
      }
      await this.sessionIndexStore.archiveSessions([entry.sessionId]);
      return false;
    }
    if (!hydrated || input.signal?.aborted) {
      return false;
    }
    return Boolean(await this.commitHydratedSession(entry, hydrated));
  }

  private async commitHydratedSession<T extends HydratedSessionSnapshot>(
    entry: SessionIndexEntry,
    hydrated: T,
    input: { partial?: boolean } = {}
  ): Promise<T | undefined> {
    const indexRelations = this.sessionIndexStore.listRelations(entry.workspaceId);
    const relatedIndexRelations = indexRelations.filter(
      (relation) =>
        relation.parentSessionId === entry.sessionId ||
        relation.childSessionId === entry.sessionId
    );
    const hydratedForkSourceTurnId = hydrated.sessionRelations.find(
      (relation) =>
        relation.relationType === "fork" &&
        this.normalizeProviderSessionId(relation.childSessionId, entry) === entry.sessionId
    )?.sourceTurnId;
    const normalizedHydrated = this.normalizeHydratedRelations(
      entry,
      hydrated,
      relatedIndexRelations
    );
    // 轮次归属由引擎适配层判定，这里只补齐索引缺失的 fork 连接点。
    const fork = [...normalizedHydrated.sessionRelations, ...indexRelations].find(
      (relation) =>
        relation.relationType === "fork" && relation.childSessionId === entry.sessionId
    );
    if (fork && !fork.sourceTurnId && hydratedForkSourceTurnId) {
      const repaired = await this.sessionIndexStore.upsertRelation({
        workspaceId: entry.workspaceId,
        parentSessionId: fork.parentSessionId,
        childSessionId: fork.childSessionId,
        relationType: "fork",
        sourceTurnId: hydratedForkSourceTurnId,
        createdAt: fork.createdAt
      });
      const relationIndex = relatedIndexRelations.findIndex(
        (relation) => relation.childSessionId === entry.sessionId
      );
      if (relationIndex >= 0) {
        relatedIndexRelations[relationIndex] = repaired;
      } else {
        relatedIndexRelations.push(repaired);
      }
    }
    const currentSession = this.runtimeService.getSession(entry.sessionId);
    const replaceSessionHistory =
      !input.partial &&
      !isActiveSessionStatus(currentSession?.status ?? "idle");
    const committedHydrated = replaceSessionHistory
      ? normalizedHydrated
      : this.preserveLiveRuntimeState(normalizedHydrated);
    this.runtimeService.hydrateDiscoveredSession(committedHydrated, {
      relatedIndexRelations,
      replaceSessionHistory
    });
    await this.upsertHydratedSession(entry, committedHydrated, input);
    if (!input.partial) {
      this.fullyHydratedSessionIds.add(entry.sessionId);
    }
    return committedHydrated;
  }

  private preserveLiveRuntimeState<T extends HydratedSessionSnapshot>(hydrated: T): T {
    const current = this.runtimeService.getSnapshot();
    const currentSession = current.sessions.find(
      (session) => session.sessionId === hydrated.session.sessionId
    );
    const currentTurns = new Map(
      current.turns
        .filter((turn) => turn.sessionId === hydrated.session.sessionId)
        .map((turn) => [turn.turnId, turn] as const)
    );
    const turns = hydrated.turns.map((turn) => {
      const currentTurn = currentTurns.get(turn.turnId);
      if (!currentTurn || (
        currentTurn.status !== "completed" &&
        !isActiveSessionStatus(currentSession?.status ?? "idle")
      )) {
        return turn;
      }
      return {
        ...turn,
        status: currentTurn.status,
        finishReason: currentTurn.finishReason ?? turn.finishReason,
        completedAt: currentTurn.completedAt ?? turn.completedAt,
        actor: currentTurn.actor ?? turn.actor,
        finalMessageId: currentTurn.finalMessageId ?? turn.finalMessageId,
        executionProfile: currentTurn.executionProfile ?? turn.executionProfile,
        messageIds: mergeTurnIds(turn.messageIds, currentTurn.messageIds),
        toolCallIds: mergeTurnIds(turn.toolCallIds, currentTurn.toolCallIds),
        terminalIds: mergeTurnIds(turn.terminalIds, currentTurn.terminalIds),
        approvalRequestIds: mergeTurnIds(
          turn.approvalRequestIds,
          currentTurn.approvalRequestIds
        ),
        interactionRequestIds: mergeTurnIds(
          turn.interactionRequestIds ?? [],
          currentTurn.interactionRequestIds ?? []
        )
      };
    });
    const session = currentSession &&
      isActiveSessionStatus(currentSession.status)
      ? {
          ...hydrated.session,
          status: currentSession.status,
          lastTurnId: currentSession.lastTurnId ?? hydrated.session.lastTurnId
        }
      : hydrated.session;
    return { ...hydrated, session, turns };
  }

  private normalizeHydratedRelations<
    T extends HydratedSessionSnapshot | HydratedSessionWindowSnapshot
  >(
    entry: SessionIndexEntry,
    hydrated: T,
    relatedIndexRelations: SessionRelationIndex[]
  ): T {
    const indexOwnedChildSessionIds = new Set(
      relatedIndexRelations.map((relation) => relation.childSessionId)
    );
    const normalizedRelations = hydrated.sessionRelations
      .map((relation) => {
        const parentSessionId = this.normalizeProviderSessionId(
          relation.parentSessionId,
          entry
        );
        const childSessionId = this.normalizeProviderSessionId(
          relation.childSessionId,
          entry
        );
        return parseSessionRelation({
          ...relation,
          relationId: buildRelationId(
            parentSessionId,
            childSessionId,
            relation.relationType
          ),
          parentSessionId,
          childSessionId
        });
      })
      .filter(
        (relation) =>
          !indexOwnedChildSessionIds.has(relation.childSessionId)
      );
    return {
      ...hydrated,
      sessionRelations: normalizedRelations
    };
  }

  private normalizeProviderSessionId(
    sessionId: string,
    entry: SessionIndexEntry
  ): string {
    if (!entry.providerKind) {
      return sessionId;
    }
    const prefix = `${entry.providerKind}:`;
    if (!sessionId.startsWith(prefix)) {
      return sessionId;
    }
    const providerSessionId = sessionId.slice(prefix.length);
    return (
      this.sessionIdentity.resolveWorkbenchSessionId(
        {
          providerKind: entry.providerKind,
          providerSessionId
        },
        entry.workspaceId
      ) ?? sessionId
    );
  }

  private async upsertHydratedSession(
    entry: SessionIndexEntry,
    hydrated: HydratedSessionSnapshot,
    input: {
      partial?: boolean;
    } = {}
  ): Promise<void> {
    const hydratedLastCompletedTurnAt = resolveHydratedLastCompletedTurnAt(hydrated.turns);
    const hydratedLastUserMessageAt = resolveHydratedLastUserMessageAt(hydrated.messageBlocks);
    await this.sessionIndexStore.upsertSession({
      workspaceId: hydrated.workspaceId,
      session: hydrated.session,
      providerKind: hydrated.runtimeBinding?.providerKind ?? entry.providerKind,
      providerSessionId:
        hydrated.runtimeBinding?.providerSessionId ?? entry.providerSessionId,
      summaryText: entry.summaryText,
      lastCompletedTurnAt: input.partial
        ? latestIso(entry.lastCompletedTurnAt, hydratedLastCompletedTurnAt)
        : hydratedLastCompletedTurnAt,
      lastUserMessageAt: latestIso(entry.lastUserMessageAt, hydratedLastUserMessageAt),
      unreadState: entry.unreadState,
      source: entry.source
    });
  }
}

export const buildConversationMap = (
  sessions: DiscoveredSessionRecord[],
  relations: DiscoveredSessionRelation[]
): Map<string, string> => {
  const parentByChildId = new Map<string, string>();
  for (const relation of relations) {
    if (!parentByChildId.has(relation.childSessionId)) {
      parentByChildId.set(relation.childSessionId, relation.parentSessionId);
    }
  }

  const conversationIdBySessionId = new Map<string, string>();
  const resolveRoot = (sessionId: string): string => {
    const seen = new Set<string>();
    let current = sessionId;
    while (parentByChildId.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentByChildId.get(current) ?? current;
    }
    return current;
  };

  for (const session of sessions) {
    const rootSessionId = resolveRoot(session.sessionId);
    conversationIdBySessionId.set(
      session.sessionId,
      discoveredConversationId(rootSessionId)
    );
  }
  return conversationIdBySessionId;
};
