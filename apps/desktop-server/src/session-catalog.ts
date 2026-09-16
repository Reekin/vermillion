import type {
  ChatSession,
  DomainSnapshot,
  SessionBrowserChangesRpc,
  SessionBrowserItemRpc,
  SessionBrowserSnapshotRpc
} from "@vermillion/shared";
import {
  diffRowDeltas,
  resolveRowDelta,
  SessionBrowserReadModel,
  type SessionBrowserRowDelta,
  type SessionBrowserReadModelSeed
} from "./session-browser-read-model.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionIndexEntry, SessionIndexStore } from "./session-index.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

export type SessionStatusDot = "none" | "running" | "unread_completed";

/** How far back a browser session may lag before it must read a full snapshot again. */
const ROW_DELTA_LIMIT = 64;

type SessionCatalogServiceOptions = {
  runtimeService: SessionRuntimeService;
  workspaceRegistry: WorkspaceRegistryService;
  sessionIndexStore: SessionIndexStore;
};

type SessionCatalogSeed = {
  sessionId: string;
  providerKind?: string;
  providerSessionId?: string;
  workspaceId: string;
  conversationId?: string;
  engineId: string;
  title?: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
  lastCompletedTurnAt?: string;
  lastUserMessageAt?: string;
  archivedAt?: string;
  runtimeStatus?: ChatSession["status"];
  unreadState?: SessionIndexEntry["unreadState"];
  metadata?: Record<string, unknown>;
};

const latest = (values: readonly (string | undefined)[]): string | undefined =>
  values.reduce<string | undefined>(
    (result, value) => value && (!result || value > result) ? value : result,
    undefined
  );

const resolveSeedActivityAt = (seed: SessionCatalogSeed): string =>
  latest([seed.lastCompletedTurnAt, seed.lastUserMessageAt, seed.createdAt]) ??
  seed.createdAt;

const collectLastCompletedTurnAtBySessionId = (
  turns: DomainSnapshot["turns"]
): Map<string, string> => {
  const lastCompletedTurnAtBySessionId = new Map<string, string>();
  for (const turn of turns) {
    if (turn.status !== "completed" || !turn.completedAt) {
      continue;
    }
    const existing = lastCompletedTurnAtBySessionId.get(turn.sessionId);
    if (!existing || turn.completedAt > existing) {
      lastCompletedTurnAtBySessionId.set(turn.sessionId, turn.completedAt);
    }
  }
  return lastCompletedTurnAtBySessionId;
};

const collectLastUserMessageAtBySessionId = (
  messageBlocks: DomainSnapshot["messageBlocks"]
): Map<string, string> => {
  const lastUserMessageAtBySessionId = new Map<string, string>();
  for (const messageBlock of messageBlocks) {
    if (messageBlock.role !== "user") {
      continue;
    }
    const existing = lastUserMessageAtBySessionId.get(messageBlock.sessionId);
    if (!existing || messageBlock.startedAt > existing) {
      lastUserMessageAtBySessionId.set(messageBlock.sessionId, messageBlock.startedAt);
    }
  }
  return lastUserMessageAtBySessionId;
};

const toSeedFromRuntime = (
  snapshot: DomainSnapshot,
  session: ChatSession,
  lastCompletedTurnAtBySessionId: ReadonlyMap<string, string>,
  lastUserMessageAtBySessionId: ReadonlyMap<string, string>
): SessionCatalogSeed | undefined => {
  const conversation = snapshot.conversations.find(
    (item) => item.conversationId === session.conversationId
  );
  if (!conversation?.workspaceId) {
    return undefined;
  }
  return {
    sessionId: session.sessionId,
    workspaceId: conversation.workspaceId,
    conversationId: session.conversationId,
    engineId: session.engineId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastCompletedTurnAt: lastCompletedTurnAtBySessionId.get(session.sessionId),
    lastUserMessageAt: lastUserMessageAtBySessionId.get(session.sessionId),
    archivedAt: session.archivedAt,
    runtimeStatus: session.status,
    metadata: session.metadata
  };
};

const isBrowserVisibleSeed = (
  seed: SessionCatalogSeed,
  runtimeSessionIds: ReadonlySet<string>
): boolean =>
  (runtimeSessionIds.has(seed.sessionId) || Boolean(seed.providerSessionId));

export class SessionCatalogService {
  private readonly runtimeService: SessionRuntimeService;
  private readonly workspaceRegistry: WorkspaceRegistryService;
  private readonly sessionIndexStore: SessionIndexStore;
  private catalogRevision = 0;
  private readonly rowDeltasByWorkspaceId = new Map<string, SessionBrowserRowDelta[]>();
  private materialized:
    | { sourceRevision: string; model: SessionBrowserReadModel }
    | undefined;
  /** Last model handed to callers; it stays the diff baseline even when the cache is dropped. */
  private adoptedModel: SessionBrowserReadModel | undefined;
  private materializing:
    | { sourceRevision: string; promise: Promise<SessionBrowserReadModel> }
    | undefined;

  public constructor(options: SessionCatalogServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
  }

  public async list(input: {
    workspaceId: string;
    kind?: "user" | "agent";
  }): Promise<SessionBrowserSnapshotRpc> {
    return (await this.getReadModel()).snapshot(input);
  }

  public async changes(input: {
    workspaceId: string;
    revision: string;
    kind?: "user" | "agent";
  }): Promise<SessionBrowserChangesRpc> {
    const model = await this.getReadModel();
    const revision = model.revision(input.workspaceId);
    const delta = input.revision === revision
      ? { changedIds: [], removedIds: [] }
      : resolveRowDelta(this.rowDeltasByWorkspaceId.get(input.workspaceId) ?? [], input.revision, revision);
    if (!delta) {
      return { status: "full-required", workspaceId: input.workspaceId };
    }
    const rows = new Map(model.rows(input).map((row) => [row.sessionId, row]));
    return {
      status: "changed",
      workspaceId: input.workspaceId,
      revision,
      items: delta.changedIds.flatMap((sessionId) => rows.get(sessionId) ?? []),
      removedSessionIds: delta.removedIds
    };
  }

  public async get(sessionId: string): Promise<SessionBrowserItemRpc | undefined> {
    return (await this.getReadModel()).get(sessionId);
  }

  public invalidate(): void {
    this.catalogRevision += 1;
    this.materialized = undefined;
  }

  public async markSessionRead(sessionId: string): Promise<void> {
    const item = await this.get(sessionId);
    for (const memberId of item?.memberSessionIds ?? [sessionId]) {
      await this.sessionIndexStore.markSessionRead(memberId);
    }
  }

  /** Rename works for every listed session: loaded ones through session state, the rest through the index entry. */
  public async renameSession(input: {
    sessionId: string;
    title: string;
  }): Promise<{ sessionId: string; title: string }> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("Session title must not be blank.");
    }
    const loaded = this.runtimeService
      .getSnapshot()
      .sessions.some((session) => session.sessionId === input.sessionId);
    if (loaded) {
      await this.runtimeService.setSessionTitle(input.sessionId, title);
      return {
        sessionId: input.sessionId,
        title
      };
    }
    const renamed = await this.sessionIndexStore.renameSession(input.sessionId, title);
    if (!renamed) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }
    return {
      sessionId: input.sessionId,
      title: renamed.title ?? title
    };
  }

  private async getReadModel(): Promise<SessionBrowserReadModel> {
    await this.workspaceRegistry.ready();
    await this.sessionIndexStore.ready();
    while (true) {
      const sourceRevision = this.getSourceRevision();
      if (this.materialized?.sourceRevision === sourceRevision) {
        return this.materialized.model;
      }
      if (this.materializing?.sourceRevision === sourceRevision) {
        const model = await this.materializing.promise;
        if (this.getSourceRevision() === sourceRevision) {
          this.adoptReadModel(sourceRevision, model);
          return model;
        }
        continue;
      }
      const promise = this.materializeReadModel();
      this.materializing = { sourceRevision, promise };
      let model: SessionBrowserReadModel;
      try {
        model = await promise;
      } finally {
        if (this.materializing?.promise === promise) {
          this.materializing = undefined;
        }
      }
      if (this.getSourceRevision() === sourceRevision) {
        this.adoptReadModel(sourceRevision, model);
        return model;
      }
    }
  }

  /** Swapping the model records the row deltas callers need to advance from the previous revision. */
  private adoptReadModel(sourceRevision: string, model: SessionBrowserReadModel): void {
    const previous = this.adoptedModel;
    if (previous) {
      for (const delta of diffRowDeltas(previous, model)) {
        const chain = this.rowDeltasByWorkspaceId.get(delta.workspaceId) ?? [];
        this.rowDeltasByWorkspaceId.set(delta.workspaceId, [...chain, delta].slice(-ROW_DELTA_LIMIT));
      }
    }
    this.adoptedModel = model;
    this.materialized = { sourceRevision, model };
  }

  private getSourceRevision(): string {
    return [
      this.runtimeService.getSessionBrowserRevision(),
      this.sessionIndexStore.getRevision(),
      this.workspaceRegistry.getSessionBrowserRevision(),
      this.catalogRevision
    ].join(":");
  }

  private async materializeReadModel(): Promise<SessionBrowserReadModel> {
    const snapshot = this.runtimeService.getSnapshot();
    const registryState = this.workspaceRegistry.getState();
    const runtimeSessionIds = new Set(snapshot.sessions.map((session) => session.sessionId));
    const lastCompletedTurnAtBySessionId = collectLastCompletedTurnAtBySessionId(snapshot.turns);
    const lastUserMessageAtBySessionId = collectLastUserMessageAtBySessionId(snapshot.messageBlocks);
    const bySessionId = new Map<string, SessionCatalogSeed>();

    for (const entry of this.sessionIndexStore.listEntries()) {
      bySessionId.set(entry.sessionId, {
        sessionId: entry.sessionId,
        providerKind: entry.providerKind,
        providerSessionId: entry.providerSessionId,
        workspaceId: entry.workspaceId,
        conversationId: entry.conversationId,
        engineId: entry.engineId,
        title: entry.title,
        summaryText: entry.summaryText,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastCompletedTurnAt: entry.lastCompletedTurnAt,
        lastUserMessageAt: entry.lastUserMessageAt,
        archivedAt: entry.archivedAt,
        unreadState: entry.unreadState,
        metadata: entry.metadata
      });
    }
    for (const session of snapshot.sessions) {
      const runtimeSeed = toSeedFromRuntime(
        snapshot,
        session,
        lastCompletedTurnAtBySessionId,
        lastUserMessageAtBySessionId
      );
      if (!runtimeSeed) {
        continue;
      }
      const existing = bySessionId.get(runtimeSeed.sessionId);
      bySessionId.set(runtimeSeed.sessionId, {
        ...existing,
        ...runtimeSeed,
        archivedAt: runtimeSeed.archivedAt ?? existing?.archivedAt,
        lastCompletedTurnAt: runtimeSeed.lastCompletedTurnAt ?? existing?.lastCompletedTurnAt,
        lastUserMessageAt: latest([
          runtimeSeed.lastUserMessageAt,
          existing?.lastUserMessageAt
        ]),
        summaryText: existing?.summaryText,
        unreadState: existing?.unreadState,
        metadata: runtimeSeed.metadata ?? existing?.metadata
      });
    }

    const forkParentById = new Map<string, string>();
    const subagentParentById = new Map<string, string>();
    for (const relation of [...snapshot.sessionRelations, ...this.sessionIndexStore.listRelations()]) {
      if (relation.relationType === "fork" && !forkParentById.has(relation.childSessionId)) {
        forkParentById.set(relation.childSessionId, relation.parentSessionId);
      }
      if (relation.relationType === "subagent" && !subagentParentById.has(relation.childSessionId)) {
        subagentParentById.set(relation.childSessionId, relation.parentSessionId);
      }
    }

    const seeds: SessionBrowserReadModelSeed[] = [...bySessionId.values()]
      .map((seed) => {
      const activityAt = resolveSeedActivityAt(seed);
      return {
        sessionId: seed.sessionId,
        forkParentSessionId: forkParentById.get(seed.sessionId),
        parentSessionId: subagentParentById.get(seed.sessionId),
        archivedAt: seed.archivedAt,
        isVisible: isBrowserVisibleSeed(seed, runtimeSessionIds),
        workspaceId: seed.workspaceId,
        engineId: seed.engineId,
        title: seed.title ?? seed.sessionId,
        statusDot:
          seed.runtimeStatus === "running" || seed.runtimeStatus === "awaiting_approval"
            ? "running"
            : registryState.lastActiveSessionId === seed.sessionId
              ? "none"
              : seed.unreadState === "unread_completed"
                ? "unread_completed"
                : "none",
        isActive: registryState.lastActiveSessionId === seed.sessionId,
        isPinned: registryState.pinnedSessionIds.includes(seed.sessionId),
        role: typeof seed.metadata?.role === "string" ? seed.metadata.role : undefined,
        activityAt,
        lastCompletedTurnAt: seed.lastCompletedTurnAt,
        sortAt: activityAt
      };
    });
    return new SessionBrowserReadModel(seeds);
  }
}
