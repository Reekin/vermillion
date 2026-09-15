import { RuntimeEventBus, type RuntimeEventEnvelope, type RuntimeEventFilter, type RuntimeEventReplayInput } from "@vermillion/core";
import type {
  ChatSession,
  Command,
  CommandEnvelope,
  DomainSnapshot,
  EngineModelCatalogRpc,
  EventEnvelope,
  ProviderSessionHandle,
  SessionRelationType
} from "@vermillion/shared";
import {
  invalidatesSessionBrowser,
  type SessionExecutionProfileInput
} from "@vermillion/shared";
import type {
  SessionIndexStore,
  SessionRelationIndex
} from "./session-index.js";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import { DomainService } from "./domain-service.js";
import { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import { SessionIndexSyncService } from "./session-index-sync-service.js";
import type { SessionTitleGenerator } from "./title-generation-service.js";
import type {
  EngineSelectionInput,
  EventReplayResult,
  CommandReceipt,
  SnapshotResult,
  SessionAgentBinding,
  SessionEngineDescriptor,
  SessionListOptions
} from "./runtime-types.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

type Clock = () => string;
type IdFactory = () => string;

export type {
  EngineSelectionInput,
  EventReplayResult,
  CommandReceipt,
  SnapshotResult,
  SessionAgentBinding,
  SessionEngineDescriptor,
  SessionListOptions
} from "./runtime-types.js";

export type SessionRuntimeServiceOptions = {
  engines?: SessionEngineDescriptor[];
  agentBindings?: SessionAgentBinding[];
  workspaceRegistry?: WorkspaceRegistryService;
  sessionIndexStore?: SessionIndexStore;
  now?: Clock;
  createConversationId?: IdFactory;
  createRelationId?: IdFactory;
  createSessionId?: IdFactory;
  createEventId?: IdFactory;
  titleGenerator?: SessionTitleGenerator;
};

export class SessionRuntimeService {
  private readonly workspaceRegistry?: WorkspaceRegistryService;
  private readonly sessionIndexStore?: SessionIndexStore;
  private readonly eventBus: RuntimeEventBus;
  private readonly domainService: DomainService;
  private readonly runtimeOrchestrator: RuntimeOrchestrator;
  private readonly sessionIndexTasks = new Set<Promise<void>>();
  private sessionBrowserRevision = 0;

  public constructor(options: SessionRuntimeServiceOptions = {}) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.domainService = new DomainService({
      now: options.now,
      createRelationId: options.createRelationId,
      createSessionId: options.createSessionId,
      assertEngineRegistered: (engineId) =>
        this.runtimeOrchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        this.runtimeOrchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: (event) => {
        this.publishRuntimeEvent(event);
      },
      markSessionUnreadCompleted: (sessionId) => {
        this.trackSessionIndexTask(this.markSessionUnreadCompleted(sessionId));
      }
    });
    this.eventBus = new RuntimeEventBus({
      now: options.now,
      createId: options.createEventId,
      resolveConversationIdBySessionId: (sessionId) =>
        this.resolveConversationIdForSession(sessionId)
    });
    const workspaceSelectionService = new WorkspaceSelectionService({
      workspaceRegistry: this.workspaceRegistry
    });
    const sessionIndexSyncService = new SessionIndexSyncService({
      sessionIndexStore: this.sessionIndexStore,
      resolveSessionRecord: (sessionId) =>
        this.runtimeOrchestrator?.resolveSessionIndexRecord(sessionId)
    });
    this.runtimeOrchestrator = new RuntimeOrchestrator({
      domainService: this.domainService,
      sessionIndexSyncService,
      workspaceSelectionService,
      publishRuntimeEvent: (event) => {
        this.publishRuntimeEvent(event);
      },
      engines: options.engines,
      agentBindings: options.agentBindings,
      titleGenerator: options.titleGenerator,
      now: options.now,
      createConversationId: options.createConversationId
    });
  }

  public registerEngine(engine: SessionEngineDescriptor): void {
    this.runtimeOrchestrator.registerEngine(engine);
  }

  public registerAgentBinding(binding: SessionAgentBinding): void {
    this.runtimeOrchestrator.registerAgentBinding(binding);
  }

  public setSessionRoleResolver(
    resolver: (workspaceId: string, metadata: Record<string, unknown>) => Promise<string | undefined>
  ): void {
    this.runtimeOrchestrator.setSessionRoleResolver(resolver);
  }

  public resolveSessionRoleInstructions(
    sessionId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<string | undefined> {
    return this.runtimeOrchestrator.resolveSessionRoleInstructions(sessionId, metadata);
  }

  public selectEngine(input: EngineSelectionInput): { selectedEngineId: string } {
    return this.runtimeOrchestrator.selectEngine(input);
  }

  public getSelectedEngineId(): string | undefined {
    return this.runtimeOrchestrator.getSelectedEngineId();
  }

  public async listEngineModels(engineId: string): Promise<EngineModelCatalogRpc> {
    return this.runtimeOrchestrator.listEngineModels(engineId);
  }

  public getWorkspaceRegistry(): WorkspaceRegistryService | undefined {
    return this.workspaceRegistry;
  }

  public getSessionIndexStore(): SessionIndexStore | undefined {
    return this.sessionIndexStore;
  }

  public hydrateDiscoveredSession(
    snapshot: HydratedSessionSnapshot,
    input: {
      relatedIndexRelations?: SessionRelationIndex[];
      replaceSessionHistory?: boolean;
    } = {}
  ): ChatSession {
    return this.runtimeOrchestrator.hydrateDiscoveredSession(snapshot, input);
  }

  public async executeCommand(input: CommandEnvelope): Promise<CommandReceipt> {
    return this.runtimeOrchestrator.executeCommand(input);
  }

  public setSessionTitle(sessionId: string, title: string): Promise<void> {
    return this.runtimeOrchestrator.setSessionTitle(sessionId, title);
  }

  public updateSessionMetadata(sessionId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.runtimeOrchestrator.updateSessionMetadata(sessionId, metadata);
  }

  public listSessions(options: SessionListOptions = {}): ChatSession[] {
    return this.domainService.listSessions(options);
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.domainService.getSession(sessionId);
  }

  public async createSession(
    command: Extract<Command, { type: "createSession" }>
  ): Promise<ChatSession> {
    return this.runtimeOrchestrator.createSession(command);
  }

  public async createRelatedSession(command: {
    parentSessionId: string;
    engineId: string;
    relationType: SessionRelationType;
    sourceTurnId?: string;
    sessionProfile?: SessionExecutionProfileInput;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }): Promise<ChatSession> {
    return this.runtimeOrchestrator.createRelatedSession(command);
  }

  public resolveConversationIdForSession(
    sessionId: string
  ): string | undefined {
    // History can emit status events before its snapshot has been hydrated.
    return this.domainService.resolveConversationIdForSession(sessionId)
      ?? this.sessionIndexStore?.getEntry(sessionId)?.conversationId;
  }

  private async markSessionUnreadCompleted(sessionId: string): Promise<void> {
    if (!this.sessionIndexStore) {
      return;
    }
    if (this.workspaceRegistry) {
      await this.workspaceRegistry.ready();
      if (this.workspaceRegistry.getState().lastActiveSessionId === sessionId) {
        await this.sessionIndexStore.markSessionRead(sessionId);
        return;
      }
    }
    await this.sessionIndexStore.markSessionUnreadCompleted(sessionId);
  }

  public resolveProviderSessionHandle(
    sessionId: string
  ): ProviderSessionHandle | undefined {
    return this.runtimeOrchestrator.resolveProviderSessionHandle(sessionId);
  }

  public getSnapshot(): DomainSnapshot {
    return this.domainService.getSnapshot();
  }

  public applyRuntimeEvent(
    event: EventEnvelope["event"],
    occurredAt?: string
  ): void {
    this.domainService.ingestRuntimeEvent(event, occurredAt);
    this.advanceSessionBrowserRevision(event);
  }

  public getSnapshotResult(): SnapshotResult {
    return {
      snapshot: this.getSnapshot(),
      cursor: this.eventBus.getLatestCursor()
    };
  }

  public getRevision(): string {
    return this.eventBus.getLatestCursor() ?? "initial";
  }

  public getSessionBrowserRevision(): number {
    return this.sessionBrowserRevision;
  }

  public notifyChatTreeChanged(sessionId: string, visibleTurnIds: string[]): void {
    this.publishRuntimeEvent({
      type: "conversationGraph.updated", sessionId,
      currentNodeId: visibleTurnIds.at(-1), visibleNodeIds: visibleTurnIds, visibleTurnIds
    });
  }

  public subscribe(
    listener: (envelope: EventEnvelope) => void,
    filter: RuntimeEventFilter = {}
  ): () => void {
    return this.eventBus.subscribe((envelope) => {
      listener(this.toSharedEnvelope(envelope));
    }, filter);
  }

  public subscribeFromCursor(
    listener: (envelope: EventEnvelope) => void,
    input: RuntimeEventReplayInput = {}
  ): () => void {
    return this.eventBus.subscribeWithReplay((envelope) => {
      listener(this.toSharedEnvelope(envelope));
    }, input);
  }

  public replay(input: RuntimeEventReplayInput = {}): EventEnvelope[] {
    return this.replayResult(input).envelopes;
  }

  public replayResult(input: RuntimeEventReplayInput = {}): EventReplayResult {
    const result = this.eventBus.replayResult(input);
    return {
      ...result,
      envelopes: result.envelopes.map((envelope) => this.toSharedEnvelope(envelope))
    };
  }

  public async dispose(): Promise<void> {
    await this.runtimeOrchestrator.dispose();
    await Promise.all(this.sessionIndexTasks);
  }

  private trackSessionIndexTask(task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => {
        console.warn("[vermillion] Failed to update session read state", error);
      })
      .finally(() => {
        this.sessionIndexTasks.delete(tracked);
      });
    this.sessionIndexTasks.add(tracked);
  }

  private toSharedEnvelope(envelope: RuntimeEventEnvelope): EventEnvelope {
    return {
      eventId: envelope.eventId,
      cursor: envelope.cursor,
      occurredAt: envelope.occurredAt,
      event: envelope.event
    };
  }

  private publishRuntimeEvent(event: EventEnvelope["event"]): void {
    this.advanceSessionBrowserRevision(event);
    this.eventBus.publish(event);
  }

  private advanceSessionBrowserRevision(event: EventEnvelope["event"]): void {
    if (invalidatesSessionBrowser(event)) {
      this.sessionBrowserRevision += 1;
    }
  }
}
