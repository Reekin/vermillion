import type {
  ChatSession,
  DomainSnapshot,
  SessionBrowserItemRpc,
  SessionBrowserPageRpc
} from "@vermillion/shared";
import {
  SessionBrowserReadModel,
  type SessionBrowserReadModelSeed
} from "./session-browser-read-model.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionIndexEntry, SessionIndexStore } from "./session-index.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

export type SessionStatusDot = "none" | "running" | "unread_completed";

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
  archivedAt?: string;
  runtimeStatus?: ChatSession["status"];
  unreadState?: SessionIndexEntry["unreadState"];
  metadata?: Record<string, unknown>;
};

const resolveSeedActivityAt = (seed: SessionCatalogSeed): string =>
  seed.lastCompletedTurnAt ?? seed.createdAt;

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

const toSeedFromRuntime = (
  snapshot: DomainSnapshot,
  session: ChatSession,
  lastCompletedTurnAtBySessionId: ReadonlyMap<string, string>
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
    archivedAt: session.archivedAt,
    runtimeStatus: session.status,
    metadata: session.metadata
  };
};

const isBrowserVisibleSeed = (
  seed: SessionCatalogSeed,
  runtimeSessionIds: ReadonlySet<string>
): boolean =>
  !seed.archivedAt &&
  (runtimeSessionIds.has(seed.sessionId) || Boolean(seed.providerSessionId));

export class SessionCatalogService {
  private readonly runtimeService: SessionRuntimeService;
  private readonly workspaceRegistry: WorkspaceRegistryService;
  private readonly sessionIndexStore: SessionIndexStore;
  private catalogRevision = 0;
  private materialized:
    | { sourceRevision: string; model: SessionBrowserReadModel }
    | undefined;
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
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
    kind?: "user" | "agent";
  }): Promise<SessionBrowserPageRpc> {
    return (await this.getReadModel()).list(input);
  }

  public async get(sessionId: string): Promise<SessionBrowserItemRpc | undefined> {
    return (await this.getReadModel()).get(sessionId);
  }

  public invalidate(): void {
    this.catalogRevision += 1;
    this.materialized = undefined;
  }

  public async markSessionRead(sessionId: string): Promise<void> {
    await this.sessionIndexStore.markSessionRead(sessionId);
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
          this.materialized = { sourceRevision, model };
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
        this.materialized = { sourceRevision, model };
        return model;
      }
    }
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
        archivedAt: entry.archivedAt,
        unreadState: entry.unreadState,
        metadata: entry.metadata
      });
    }
    for (const session of snapshot.sessions) {
      const runtimeSeed = toSeedFromRuntime(snapshot, session, lastCompletedTurnAtBySessionId);
      if (!runtimeSeed) {
        continue;
      }
      const existing = bySessionId.get(runtimeSeed.sessionId);
      bySessionId.set(runtimeSeed.sessionId, {
        ...existing,
        ...runtimeSeed,
        lastCompletedTurnAt: runtimeSeed.lastCompletedTurnAt ?? existing?.lastCompletedTurnAt,
        summaryText: existing?.summaryText,
        unreadState: existing?.unreadState,
        metadata: runtimeSeed.metadata ?? existing?.metadata
      });
    }

    // Only subagent relations nest; forks stay peers of their origin.
    const subagentParentById = new Map<string, string>();
    for (const relation of [...snapshot.sessionRelations, ...this.sessionIndexStore.listRelations()]) {
      if (relation.relationType === "subagent" && !subagentParentById.has(relation.childSessionId)) {
        subagentParentById.set(relation.childSessionId, relation.parentSessionId);
      }
    }

    const seeds: SessionBrowserReadModelSeed[] = [...bySessionId.values()]
      .filter((seed) => isBrowserVisibleSeed(seed, runtimeSessionIds))
      .map((seed) => {
      const activityAt = resolveSeedActivityAt(seed);
      return {
        sessionId: seed.sessionId,
        parentSessionId: subagentParentById.get(seed.sessionId),
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
