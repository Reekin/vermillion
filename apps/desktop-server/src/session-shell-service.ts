import { randomUUID } from "node:crypto";
import { readSession, type ReadSessionArgs } from "./read-session-host-tool.js";
import type { ReadSessionTranscriptResult } from "./read-session-transcript.js";
import type { HostToolRegistry } from "./host-tools.js";
import type { ChatTreeScope, WrapperChatTreeService } from "./wrapper-chat-tree.js";
import type {
  ChatInteractionCapabilitiesRpc,
  ChatSession,
  ComposerSlashSuggestionRpc,
  CommandEnvelope,
  RuntimeCommandReceiptRpc,
  DomainSnapshot,
  DiagnosticsWriteInputRpc,
  DiagnosticsWriteResultRpc,
  EngineDefinitionRpc,
  EngineModelCatalogRpc,
  EngineProgramResolutionRpc,
  EngineSharedCapabilityRpc,
  EngineSurfaceRpc,
  EventEnvelope,
  ErrorLogWriteInputRpc,
  ErrorLogWriteResultRpc,
  SessionExecutionProfileInput,
  SessionBrowserItemRpc,
  SessionBrowserChangesRpc,
  SessionBrowserSnapshotRpc,
  SkillDescriptorRpc,
  SessionSettingsRpc,
  SessionSettingsUpdateRpc,
} from "@vermillion/shared";
import { resolveEngineExecutionPreference } from "@vermillion/shared";
import type { RuntimeEventFilter, RuntimeEventReplayInput } from "@vermillion/core";
import {
  type BackgroundRunSnapshot,
  CapabilityRegistry,
  type CapabilityOperationGuard,
  type CheckpointSnapshot,
  type ConversationGraphSnapshot as ChatTreeSnapshot,
  type DelegationSnapshot,
  type DiagnosticsSnapshot,
  type SessionActionDescriptor,
  type SessionActionKind,
  type SessionActionResult,
  type WorktreeSnapshot
} from "./capability-registry.js";
import { ChatTreeProvider } from "./chat-tree-provider.js";
import { cloneModelSettings } from "./model-settings.js";
import { SessionCatalogService } from "./session-catalog.js";
import { SessionReconciliationService } from "./session-discovery.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import { SessionActionsProvider } from "./session-actions.js";
import type {
  EventReplayResult,
  SessionRuntimeService
} from "./runtime-service.js";
import type { WorkspaceRecord } from "./workspace-registry.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";
import { EngineRegistryService } from "./engine-control/engine-registry.js";
import { EngineCapabilitySurfaceService } from "./engine-control/capability-surface.js";
import {
  buildSessionWindowSnapshotFromPage,
  buildSessionWindowSnapshot,
  type SessionWindowSnapshot
} from "./session-window.js";
import { FileActionService } from "./file-action-service.js";
import { ErrorLogService } from "./error-log-service.js";
import { DiagnosticLogService } from "./diagnostic-log-service.js";
import { resolveEngineProgramCommand } from "./engine-program-resolution.js";
import type { EngineMethodHandler } from "./engine-control/engine-integration.js";

const defaultSessionWindowLimit = 8;
const completeSessionWindowLimit = Number.MAX_SAFE_INTEGER;

/** 新的一次打开或激活会中止上一次；被中止的一代不再继续提交状态。 */
const throwIfOpenCancelled = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new Error("Open session cancelled.");
  }
};

const baseComposerSlashSuggestions: readonly ComposerSlashSuggestionRpc[] = [
  {
    id: "status",
    label: "/status",
    detail: "Summarize the current session state",
    replacement: "Summarize the current session status and the next best action."
  }
];

const composerSlashSuggestionsByCapability: Partial<
  Record<EngineSharedCapabilityRpc, ComposerSlashSuggestionRpc>
> = {
  checkpoint: {
    id: "checkpoint",
    label: "/checkpoint",
    detail: "Ask for a checkpoint summary",
    replacement:
      "Summarize the available checkpoints and explain what changed since the latest one.",
    sourceCapability: "checkpoint"
  },
  goal: {
    id: "goal",
    label: "/goal",
    detail: "Set the current Codex goal",
    replacement: "/goal",
    sourceCapability: "goal"
  },
  delegation: {
    id: "delegation",
    label: "/delegation",
    detail: "Explain the current delegation tree",
    replacement:
      "Summarize the current delegation tree and identify blocked or waiting nodes.",
    sourceCapability: "delegation"
  },
  diagnostics: {
    id: "diagnostics",
    label: "/diagnostics",
    detail: "Review diagnostics and suggest the next fix",
    replacement: "Review the current diagnostics and propose the next fix.",
    sourceCapability: "diagnostics"
  },
  worktree: {
    id: "worktree",
    label: "/worktree",
    detail: "Summarize branch and rollout context",
    replacement: "Summarize the current worktree, branch, and rollout context.",
    sourceCapability: "worktree"
  }
};

const resolveComposerSlashSuggestions = (
  sharedCapabilities: readonly EngineSharedCapabilityRpc[]
): ComposerSlashSuggestionRpc[] => {
  const seen = new Set<string>();
  const items: ComposerSlashSuggestionRpc[] = [];

  for (const suggestion of baseComposerSlashSuggestions) {
    seen.add(suggestion.id);
    items.push(suggestion);
  }

  for (const capability of sharedCapabilities) {
    const suggestion = composerSlashSuggestionsByCapability[capability];
    if (!suggestion || seen.has(suggestion.id)) {
      continue;
    }
    seen.add(suggestion.id);
    items.push(suggestion);
  }

  return items;
};

export type SessionShellServiceOptions = {
  runtimeService: SessionRuntimeService;
  wrapperChatTree?: WrapperChatTreeService;
  sessionCatalog: SessionCatalogService;
  capabilities?: CapabilityRegistry;
  engineMethods?: readonly EngineMethodHandler[];
  sessionIdentity?: SessionIdentityRegistry;
  sessionActions?: SessionActionsProvider;
  chatTreeProvider?: ChatTreeProvider;
  sessionReconciliation?: SessionReconciliationService;
  engineRegistry?: EngineRegistryService;
  engineCapabilitySurface?: EngineCapabilitySurfaceService;
  pickWorkspaceDirectory?: () => Promise<{
    canceled: boolean;
    rootPath?: string;
  }>;
  resolveEngineProgram?: (engineId: string) => EngineProgramResolutionRpc;
  fileActionService?: FileActionService;
  errorLogService?: ErrorLogService;
  diagnosticLogService?: DiagnosticLogService;
};

export class SessionShellService {
  public readSession(input: ReadSessionArgs): Promise<ReadSessionTranscriptResult> {
    return readSession({
      getSnapshot: () => this.getSnapshot(),
      resolveSessionId: (id) => this.resolveSessionIdentifier(id),
      ensureSessionLoaded: (id, options) => this.ensureSessionLoadedForRead(id, options),
      isSessionPartiallyHydrated: (id) => this.isSessionPartiallyHydrated(id),
      getRuntimeState: (id) => ({
        confirmed: this.capabilities?.isSessionLive(id) === true,
        activeTurnId: this.getActiveTurnId(id)
      })
    }, input);
  }

  private readonly wrapperChatTree: WrapperChatTreeService | undefined;
  private readonly runtimeService: SessionRuntimeService;
  private readonly sessionCatalog: SessionCatalogService;
  private readonly capabilities: CapabilityRegistry | undefined;
  private readonly engineMethods: Map<string, EngineMethodHandler["handle"]>;
  private readonly sessionActions: SessionActionsProvider | undefined;
  private readonly chatTreeProvider: ChatTreeProvider | undefined;
  private readonly sessionIdentity: SessionIdentityRegistry;
  private readonly sessionReconciliation: SessionReconciliationService | undefined;
  private readonly engineRegistry: EngineRegistryService | undefined;
  private readonly engineCapabilitySurface: EngineCapabilitySurfaceService | undefined;
  private readonly pickWorkspaceDirectoryImpl:
    | (() => Promise<{ canceled: boolean; rootPath?: string }>)
    | undefined;
  private readonly resolveEngineProgram: NonNullable<
    SessionShellServiceOptions["resolveEngineProgram"]
  >;
  private readonly fileActionService: FileActionService;
  private readonly errorLogService: ErrorLogService;
  private readonly diagnosticLogService: DiagnosticLogService;
  private openSessionAbortController: AbortController | undefined;
  private readonly reads = new Map<string, AbortController>();
  private activationQueue: Promise<void> = Promise.resolve();
  private readonly partiallyHydratedSessionIds = new Set<string>();
  private readonly executionRecoveryBySessionId = new Map<string, Promise<void>>();

  public constructor(options: SessionShellServiceOptions) {
    this.wrapperChatTree = options.wrapperChatTree;
    this.runtimeService = options.runtimeService;
    this.sessionCatalog = options.sessionCatalog;
    this.capabilities = options.capabilities;
    this.engineMethods = new Map(
      (options.engineMethods ?? []).map((handler) => [handler.method, handler.handle])
    );
    this.sessionActions = options.sessionActions;
    this.chatTreeProvider = options.chatTreeProvider;
    const sessionIndexStore = options.runtimeService.getSessionIndexStore?.();
    this.sessionIdentity =
      options.sessionIdentity ??
      new SessionIdentityRegistry({
        runtimeService: options.runtimeService,
        sessionIndexStore:
          sessionIndexStore ??
          ({
            getEntry: () => undefined,
            listEntries: () => []
          } as never)
      });
    this.sessionReconciliation = options.sessionReconciliation;
    this.engineRegistry = options.engineRegistry;
    this.engineCapabilitySurface = options.engineCapabilitySurface;
    this.pickWorkspaceDirectoryImpl = options.pickWorkspaceDirectory;
    this.resolveEngineProgram =
      options.resolveEngineProgram ??
      ((engineId) => {
        const { args: _args, ...resolution } = resolveEngineProgramCommand(engineId);
        return resolution;
      });
    this.fileActionService =
      options.fileActionService ?? new FileActionService();
    this.errorLogService =
      options.errorLogService ?? new ErrorLogService();
    this.diagnosticLogService =
      options.diagnosticLogService ?? new DiagnosticLogService();
  }

  public listEngines(): EngineDefinitionRpc[] {
    return this.engineRegistry?.list() ?? [];
  }

  public getEngineSurface(engineId: string): EngineSurfaceRpc {
    return this.engineCapabilitySurface?.get(engineId) ?? {
      engineId,
      sharedCapabilities: [],
      extensions: []
    };
  }

  public async listEngineModels(engineId: string): Promise<EngineModelCatalogRpc> {
    return this.runtimeService.listEngineModels(engineId);
  }

  public selectEngine(input: {
    engineId: string;
    config?: Record<string, unknown>;
  }): { selectedEngineId: string } {
    return this.runtimeService.selectEngine(input);
  }

  public getSelectedEngineId(): string | undefined {
    return this.runtimeService.getSelectedEngineId();
  }

  public async getSettings(): Promise<SessionSettingsRpc> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const state = registry.getState();
    return {
      defaultNewSessionEngineId: state.defaultNewSessionEngineId,
      titleGenerationModelId: state.titleGenerationModelId,
      engineProgramPathsByEngineId: { ...state.engineProgramPathsByEngineId },
      engineProgramResolutionsByEngineId: Object.fromEntries(
        this.listEngines().map((engine) => [
          engine.engineId,
          this.resolveEngineProgram(engine.engineId)
        ])
      ),
      ...cloneModelSettings(state)
    };
  }

  public async updateSettings(
    input: SessionSettingsUpdateRpc
  ): Promise<SessionSettingsRpc> {
    const registry = this.requireWorkspaceRegistry();
    await registry.updateSettings(input);
    if (input.defaultNewSessionEngineId) {
      this.runtimeService.selectEngine({
        engineId: input.defaultNewSessionEngineId
      });
    }
    return this.getSettings();
  }

  public async executeCommand(input: CommandEnvelope): Promise<RuntimeCommandReceiptRpc> {
    if ("sessionId" in input.command && typeof input.command.sessionId === "string") {
      await this.ensureSessionReadyForCommand(input.command);
    }
    return this.runtimeService.executeCommand(input);
  }

  /** Host tools offered to agent sessions (dynamicTools on thread/start). Set by the service factory. */
  public hostTools?: HostToolRegistry;

  public getSessionMetadata(sessionId: string): Record<string, unknown> | undefined {
    return this.runtimeService.getSession(sessionId)?.metadata;
  }

  public setSessionTitle(sessionId: string, title: string): Promise<void> {
    return this.runtimeService.setSessionTitle(sessionId, title);
  }

  public updateSessionMetadata(sessionId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.runtimeService.updateSessionMetadata(sessionId, metadata);
  }

  public setSessionRoleResolver(
    resolver: (workspaceId: string, metadata: Record<string, unknown>) => Promise<string | undefined>
  ): void {
    this.runtimeService.setSessionRoleResolver(resolver);
  }

  public listSessions(options: {
    conversationId?: string;
    includeArchived?: boolean;
  } = {}): ChatSession[] {
    return this.runtimeService.listSessions(options);
  }

  /** The conversation tree a session belongs to, which one document draft is shared by. */
  public getSessionTreeId(sessionId: string): string {
    return this.runtimeService.getSessionIndexStore?.()?.getTreeId(sessionId) ?? sessionId;
  }

  public getSnapshot(): DomainSnapshot {
    return this.runtimeService.getSnapshot();
  }

  /** Check one member without invalidating its ancestors or the published tree. */
  public async ensureHistoryCurrent(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const engineId = this.sessionIdentity.resolveContext(sessionId).engineId;
    const source = this.capabilities?.getSessionRuntime(engineId)?.historySource;
    if (!source || !this.sessionReconciliation) return false;
    const load = async (force: boolean) => {
      const loaded = await this.sessionReconciliation!.ensureSessionLoaded(sessionId, {
        force, requireFull: true, signal
      });
      signal?.throwIfAborted();
      if (!loaded) throw new Error(`Could not load current history for ${sessionId}.`);
      this.partiallyHydratedSessionIds.delete(sessionId);
    };
    // Adopt any full read already committed by reconciliation (including initial tree load).
    // Active is not a completeness claim: requireFull still fills missing history.
    await load(false);
    if (this.getActiveTurnId(sessionId)) return false;
    const current = await source.isCurrent(sessionId, signal);
    signal?.throwIfAborted();
    if (current) return false;
    await load(true);
    return true;
  }

  public async releaseSessionExecution(sessionId: string): Promise<void> {
    if (this.getSnapshot().turns.some((turn) => turn.sessionId === sessionId && turn.status !== "completed")) {
      throw new Error(`Cannot release session ${sessionId}: a turn is active.`);
    }
    if (!this.capabilities) throw new Error("Execution release is unavailable for this runtime.");
    await this.capabilities.releaseSessionExecution(sessionId);
  }

  public getActiveTurnId(sessionId: string): string | undefined {
    return this.capabilities?.getActiveTurnId(sessionId);
  }

  public isSessionPartiallyHydrated(sessionId: string): boolean {
    return this.partiallyHydratedSessionIds.has(sessionId);
  }

  /** Accepts a workbench sessionId or the engine session id recorded for it. */
  public resolveSessionIdentifier(sessionId: string): string | undefined {
    return this.sessionIdentity.resolveSessionIdentifier(sessionId);
  }

  public async ensureSessionLoadedForRead(
    sessionId: string,
    input: {
      force?: boolean;
    } = {}
  ): Promise<boolean> {
    const loaded =
      (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, input)) ?? false;
    if (loaded) {
      this.partiallyHydratedSessionIds.delete(sessionId);
    }
    return loaded;
  }

  public getSnapshotResult() {
    return this.runtimeService.getSnapshotResult();
  }

  public subscribe(
    listener: (envelope: EventEnvelope) => void,
    filter: RuntimeEventFilter = {}
  ): () => void {
    return this.runtimeService.subscribe(listener, filter);
  }

  public subscribeFromCursor(
    listener: (envelope: EventEnvelope) => void,
    input: RuntimeEventReplayInput = {}
  ): () => void {
    return this.runtimeService.subscribeFromCursor(listener, input);
  }

  public replay(input: RuntimeEventReplayInput = {}): EventEnvelope[] {
    return this.runtimeService.replay(input);
  }

  public replayResult(input: RuntimeEventReplayInput = {}): EventReplayResult {
    return this.runtimeService.replayResult(input);
  }

  public async dispose(): Promise<void> {
    this.openSessionAbortController?.abort();
    for (const controller of this.reads.values()) controller.abort();
    this.reads.clear();
    this.wrapperChatTree?.dispose();
    await this.runtimeService.dispose();
  }

  public async listWorkspaces(): Promise<{
    workspaces: WorkspaceRecord[];
    lastActiveWorkspaceId?: string;
    lastActiveSessionId?: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const state = registry.getState();
    return {
      workspaces: state.workspaces,
      lastActiveWorkspaceId: state.lastActiveWorkspaceId,
      lastActiveSessionId: state.lastActiveSessionId
    };
  }

  public async pickWorkspaceDirectory(): Promise<{
    canceled: boolean;
    rootPath?: string;
  }> {
    if (!this.pickWorkspaceDirectoryImpl) {
      return {
        canceled: true
      };
    }
    return this.pickWorkspaceDirectoryImpl();
  }

  public async addWorkspace(input: {
    rootPath: string;
    label?: string;
  }): Promise<WorkspaceRecord> {
    const registry = this.requireWorkspaceRegistry();
    return registry.registerWorkspace({
      absolutePath: input.rootPath,
      label: input.label
    });
  }

  public async removeWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    removed: boolean;
  }> {
    const registry = this.requireWorkspaceRegistry();
    const removed = await registry.removeWorkspace(workspaceId);
    if (removed) {
      await this.runtimeService.getSessionIndexStore()?.removeWorkspace(workspaceId);
    }
    return {
      workspaceId,
      removed
    };
  }

  public async selectWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    activeSessionId?: string;
  }> {
    return this.createWorkspaceSelectionService().selectWorkspace(workspaceId);
  }

  public async listBrowserSessions(input: {
    workspaceId: string;
    kind?: "user" | "agent";
  }): Promise<SessionBrowserSnapshotRpc> {
    return this.sessionCatalog.list(input);
  }

  public async changesBrowserSessions(input: {
    workspaceId: string;
    revision: string;
    kind?: "user" | "agent";
  }): Promise<SessionBrowserChangesRpc> {
    return this.sessionCatalog.changes(input);
  }

  public async getSessionBrowserItem(sessionId: string): Promise<SessionBrowserItemRpc | undefined> {
    return this.sessionCatalog.get(sessionId);
  }

  public async listSessionSearchEntries(): Promise<Array<{
    sessionId: string;
    providerSessionId?: string;
    workspaceId: string;
    engineId?: string;
    providerKind?: string;
    title?: string;
    treeId?: string;
    treeTitle?: string;
    treeActivityAt?: string;
    activityAt?: string;
    createdAt?: string;
    lastCompletedTurnAt?: string;
    lastUserMessageAt?: string;
    archivedAt?: string;
    rolloutPath?: string;
  }>> {
    const index = this.runtimeService.getSessionIndexStore?.();
    if (!index) return [];
    await index.ready();
    const entries = index.listEntries();
    const displayTitle = (title: string | undefined): string => {
      const value = title?.trim();
      return !value || /^codex-thread:[0-9a-f-]+$/i.test(value) || /^rollout-.*\.jsonl$/i.test(value)
        ? "未命名会话"
        : value;
    };
    const activityAt = (entry: typeof entries[number]): string | undefined =>
      [entry.lastCompletedTurnAt, entry.lastUserMessageAt, entry.createdAt]
        .reduce<string | undefined>(
          (latest, value) => value && (!latest || value > latest) ? value : latest,
          undefined
        );
    const entryBySessionId = new Map(entries.map((entry) => [entry.sessionId, entry]));
    const parentBySessionId = new Map(
      index.listRelations()
        .filter((relation) => relation.relationType === "fork")
        .map((relation) => [relation.childSessionId, relation.parentSessionId])
    );
    const treeIdFor = (sessionId: string): string => {
      const seen = new Set<string>();
      let current = sessionId;
      while (!seen.has(current)) {
        seen.add(current);
        const parent = parentBySessionId.get(current);
        if (!parent || !entryBySessionId.has(parent)) break;
        current = parent;
      }
      return current;
    };
    const treeIdBySessionId = new Map(
      entries.map((entry) => [entry.sessionId, treeIdFor(entry.sessionId)])
    );
    const membersByTreeId = new Map<string, typeof entries>();
    for (const entry of entries) {
      const treeId = treeIdBySessionId.get(entry.sessionId)!;
      const members = membersByTreeId.get(treeId) ?? [];
      members.push(entry);
      membersByTreeId.set(treeId, members);
    }
    const treeMeta = new Map<string, { title: string; activityAt: string | undefined }>();
    for (const [treeId, members] of membersByTreeId) {
      const root = entryBySessionId.get(treeId);
      treeMeta.set(treeId, {
        title: displayTitle(root?.title),
        activityAt: members
          .filter((entry) => !entry.archivedAt)
          .map(activityAt)
          .reduce<string | undefined>(
            (latest, value) => value && (!latest || value > latest) ? value : latest,
            undefined
          )
      });
    }
    return entries.map((entry) => {
      const treeId = treeIdBySessionId.get(entry.sessionId)!;
      const tree = treeMeta.get(treeId)!;
      return {
      sessionId: entry.sessionId,
      ...(entry.providerSessionId ? { providerSessionId: entry.providerSessionId } : {}),
      workspaceId: entry.workspaceId,
      ...(entry.engineId ? { engineId: entry.engineId } : {}),
      ...(entry.providerKind ? { providerKind: entry.providerKind } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      treeId,
      treeTitle: tree.title,
      ...(tree.activityAt ? { treeActivityAt: tree.activityAt } : {}),
      ...(activityAt(entry) ? { activityAt: activityAt(entry) } : {}),
      createdAt: entry.createdAt,
      ...(entry.lastCompletedTurnAt ? { lastCompletedTurnAt: entry.lastCompletedTurnAt } : {}),
      ...(entry.lastUserMessageAt ? { lastUserMessageAt: entry.lastUserMessageAt } : {}),
      ...(entry.archivedAt ? { archivedAt: entry.archivedAt } : {}),
      ...(typeof entry.metadata?.rolloutPath === "string" && entry.metadata.rolloutPath.trim()
        ? { rolloutPath: entry.metadata.rolloutPath }
        : {})
      };
    });
  }

  public async repairSessionBrowser(workspaceIds: string[]): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    return (
      (await this.sessionReconciliation?.repairWorkspaces(workspaceIds)) ?? {
        workspaces: 0,
        sessions: 0,
        relations: 0
      }
    );
  }

  public async createBrowserSession(input: {
    workspaceId: string;
    engineId: string;
    conversationId?: string;
    sessionProfile?: SessionExecutionProfileInput;
    metadata?: Record<string, unknown>;
  }): Promise<{
    sessionId: string;
    conversationId: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const workspace = registry.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }
    const metadata = {
      cwd: workspace.absolutePath,
      ...(input.metadata ?? {})
    };
    const registryState = registry.getState();
    const sessionProfile =
      input.sessionProfile ??
      resolveEngineExecutionPreference(
        registryState.executionPreferencesByEngineId[input.engineId]
      );
    const session = await this.runtimeService.createSession({
      type: "createSession",
      engineId: input.engineId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionProfile,
      metadata
    });
    await this.sessionCatalog.markSessionRead(session.sessionId);
    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId
    };
  }

  public async getChatCapabilities(
    sessionId: string
  ): Promise<ChatInteractionCapabilitiesRpc> {
    const session = this.runtimeService.getSession(sessionId);
    const engineId =
      session?.engineId ?? this.sessionIdentity.resolveContext(sessionId).indexEntry?.engineId;
    if (!engineId) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sharedCapabilities = this.getEngineSurface(engineId).sharedCapabilities;

    return {
      supportsSteer: sharedCapabilities.includes("steer"),
      supportsAttachments: sharedCapabilities.includes("attachments"),
      slashSuggestions: resolveComposerSlashSuggestions(sharedCapabilities)
    };
  }

  public async listSkills(input?: {
    cwds?: string[];
    forceReload?: boolean;
  }): Promise<SkillDescriptorRpc[]> {
    return (await this.capabilities?.listSkills(input)) ?? [];
  }

  public openSession(sessionId: string, input: {
    forceProviderHydration?: boolean; includeWindow: false; readId?: string;
  }): Promise<{ page?: SessionWindowSnapshot }>;
  public openSession(sessionId: string, input?: {
    forceProviderHydration?: boolean; includeWindow?: true; readId?: string;
  }): Promise<{ page: SessionWindowSnapshot }>;
  public openSession(sessionId: string, input: {
    forceProviderHydration?: boolean; includeWindow?: boolean; readId?: string;
  }): Promise<{ page?: SessionWindowSnapshot }>;
  public async openSession(
    sessionId: string,
    input: {
      forceProviderHydration?: boolean;
      includeWindow?: boolean;
      readId?: string;
    } = {}
  ): Promise<{ page?: SessionWindowSnapshot }> {
    return this.withRead(input.readId, (signal) => this.readOpenedSession(
      sessionId, input, signal ?? this.beginOpenSession()
    ));
  }

  private async readOpenedSession(
    sessionId: string,
    input: { forceProviderHydration?: boolean; includeWindow?: boolean },
    signal: AbortSignal
  ): Promise<{ page?: SessionWindowSnapshot }> {
    const refreshedHistory = await this.ensureHistoryCurrent(sessionId, signal);
    if (input.includeWindow === false) {
      if (this.sessionReconciliation) {
        const loaded = await this.sessionReconciliation.ensureSessionLoaded(sessionId, {
          force: input.forceProviderHydration,
          requireFull: true,
          signal
        });
        throwIfOpenCancelled(signal);
        if (!loaded) throw new Error(`Could not load current history for ${sessionId}.`);
        this.partiallyHydratedSessionIds.delete(sessionId);
      }
      await this.activateOpenedSession(sessionId, { signal });
      this.startSessionExecutionRecovery(sessionId);
      return {};
    }
    const loadedSession = this.runtimeService
      .listSessions({ includeArchived: true })
      .find((session) => session.sessionId === sessionId);
    const alreadyLoaded = Boolean(loadedSession);
    const isProviderSession = Boolean(
      loadedSession?.metadata?.providerKind &&
        loadedSession.metadata.providerSessionId
    );
    const anchorTurnId = await this.resolveProviderAnchorTurnId(sessionId);
    const projectedTurns = alreadyLoaded
      ? this.runtimeService
          .getSnapshot()
          .turns.filter((turn) => turn.sessionId === sessionId)
      : [];
    const hasProjectedAnchor = anchorTurnId
      ? projectedTurns.some((turn) => turn.turnId === anchorTurnId)
      : projectedTurns.length > 0;
    const isUncoveredProviderSession = isProviderSession && !hasProjectedAnchor;
    const alreadyFullyLoaded =
      alreadyLoaded &&
      !refreshedHistory &&
      !isUncoveredProviderSession &&
      !this.partiallyHydratedSessionIds.has(sessionId);
    throwIfOpenCancelled(signal);
    if (refreshedHistory && this.sessionReconciliation) {
      await this.activateOpenedSession(sessionId, { signal });
      this.startSessionExecutionRecovery(sessionId);
      return {
        page: this.buildSessionWindow(sessionId, {
          limit: defaultSessionWindowLimit,
          replaceSessionHistory: true
        })
      };
    }
    if (input.forceProviderHydration) {
      const loadedByFullHydration =
        (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
          force: true,
          signal,
          retainExecution: true
        })) ?? false;
      throwIfOpenCancelled(signal);
      if (isProviderSession && !loadedByFullHydration) {
        throw new Error("This session could not be fully loaded.");
      }
      if (loadedByFullHydration) {
        this.partiallyHydratedSessionIds.delete(sessionId);
        await this.activateOpenedSession(sessionId, { signal });
        this.startSessionExecutionRecovery(sessionId);
        return {
          page: this.buildSessionWindow(sessionId, {
            limit: completeSessionWindowLimit,
            replaceSessionHistory: true
          })
        };
      }
    } else if (!alreadyFullyLoaded) {
      const hydratedPage = await this.hydrateSessionWindow(sessionId, {
        limit: defaultSessionWindowLimit,
        anchorTurnId,
        signal,
        retainExecution: true
      });
      throwIfOpenCancelled(signal);
      if (hydratedPage) {
        await this.activateOpenedSession(sessionId, { signal });
        this.startSessionExecutionRecovery(sessionId);
        return {
          page: hydratedPage
        };
      }
    }
    if (!input.forceProviderHydration && !alreadyFullyLoaded) {
      const loadedByFullHydration =
        (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
          force: alreadyLoaded,
          signal,
          retainExecution: true
        })) ?? false;
      throwIfOpenCancelled(signal);
      if (alreadyLoaded && !loadedByFullHydration) {
        throw new Error("This session could not be fully loaded.");
      }
      if (loadedByFullHydration) {
        this.partiallyHydratedSessionIds.delete(sessionId);
      }
    }
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.session && !context.providerHandle) {
      throw new Error(
        "This session does not expose a loadable provider session id. It was likely created by an older build and can no longer be reopened."
      );
    }
    throwIfOpenCancelled(signal);
    await this.activateOpenedSession(sessionId, { signal });
    this.startSessionExecutionRecovery(sessionId);
    return {
      page: this.buildSessionWindow(sessionId, {
        limit: defaultSessionWindowLimit,
        anchorTurnId
      })
    };
  }

  public async activateSession(sessionId: string, options?: { focusTree?: boolean }): Promise<{ sessionId: string }> {
    const signal = this.beginOpenSession();
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.session && !context.indexEntry && !context.providerHandle) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (options?.focusTree) await this.wrapperChatTree?.selectSession(sessionId);
    await this.activateOpenedSession(sessionId, { signal });
    return {
      sessionId
    };
  }

  private beginOpenSession(): AbortSignal {
    this.openSessionAbortController?.abort();
    const controller = new AbortController();
    this.openSessionAbortController = controller;
    return controller.signal;
  }

  public cancelRead(readId: string): { cancelled: boolean } {
    const controller = this.reads.get(readId);
    if (!controller) return { cancelled: false };
    this.reads.delete(readId);
    controller.abort();
    return { cancelled: true };
  }

  private async withRead<T>(readId: string | undefined, read: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (!readId) return read();
    if (this.reads.has(readId)) throw new Error(`Read already in progress: ${readId}`);
    const controller = new AbortController();
    this.reads.set(readId, controller);
    try {
      const result = await read(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (this.reads.get(readId) === controller) this.reads.delete(readId);
    }
  }

  public async loadOlderSessionTurns(input: {
    sessionId: string;
    beforeTurnId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ page: SessionWindowSnapshot }> {
    if (input.cursor) {
      const hydratedPage = await this.hydrateSessionWindow(input.sessionId, {
        limit: input.limit ?? defaultSessionWindowLimit,
        cursor: input.cursor
      });
      if (hydratedPage) {
        return {
          page: hydratedPage
        };
      }
    }
    const forceFullHydration = this.partiallyHydratedSessionIds.has(input.sessionId);
    const loadedByFullHydration =
      (await this.sessionReconciliation?.ensureSessionLoaded(input.sessionId, {
        force: forceFullHydration
      })) ?? false;
    if (forceFullHydration && !loadedByFullHydration) {
      throw new Error("This session could not be fully loaded.");
    }
    if (loadedByFullHydration) {
      this.partiallyHydratedSessionIds.delete(input.sessionId);
    }
    return {
      page: this.buildSessionWindow(input.sessionId, {
        limit: input.limit ?? defaultSessionWindowLimit,
        beforeTurnId: input.beforeTurnId
      })
    };
  }

  public async getSessionActions(
    sessionId: string
  ): Promise<{ actions: SessionActionDescriptor[] }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const isPinned = registry.getState().pinnedSessionIds.includes(sessionId);
    const engineActions = this.capabilities
      ? await this.capabilities.listSessionActions(sessionId)
      : await this.requireSessionActions().listActions(sessionId);
    return {
      actions: [
        {
          action: isPinned ? "unpin" : "pin",
          label: isPinned ? "Unpin" : "Pin"
        },
        ...engineActions
      ]
    };
  }

  public async runSessionAction(input: {
    preserveExecution?: boolean;
    sessionId: string;
    action: SessionActionKind;
    fromTurnId?: string;
    activateFork?: boolean;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionActionResult> {
    if (input.action === "pin" || input.action === "unpin") {
      if (!(await this.sessionCatalog.get(input.sessionId))) {
        throw new Error(`Unknown browser session: ${input.sessionId}`);
      }
      const pinned = input.action === "pin";
      await this.requireWorkspaceRegistry().setSessionPinned(input.sessionId, pinned);
      this.sessionCatalog.invalidate();
      return {
        action: input.action,
        pinned
      } as SessionActionResult;
    }
    const result = this.capabilities
      ? await this.capabilities.runSessionAction(input.sessionId, input.action, input)
      : await this.requireSessionActions().runAction(input.sessionId, input.action, input);
    if (input.action === "resume" && !input.preserveExecution) {
      await this.sessionCatalog.markSessionRead(input.sessionId);
    }
    return result;
  }

  public async renameSession(input: {
    sessionId: string;
    title: string;
  }): Promise<{ sessionId: string; title: string }> {
    return this.sessionCatalog.renameSession(input);
  }

  public async getChatTree(sessionId: string, scope?: ChatTreeScope,
    knownWindows?: Record<string, { revision: string; cursor?: string }>, readId?: string): Promise<ChatTreeSnapshot> {
    return this.withRead(readId, async (signal) => {
      if (this.wrapperChatTree) return this.wrapperChatTree.get(sessionId, scope, knownWindows, signal);
      return this.capabilities
        ? this.capabilities.getConversationGraph(sessionId)
        : this.requireChatTreeProvider().get(sessionId);
    });
  }

  public async jumpChatTree(input: {
    sessionId: string;
    nodeId: string;
    expectedRevision?: number;
  }): Promise<{ jumped: boolean }> {
    if (this.wrapperChatTree) return this.wrapperChatTree.jump(input.sessionId, input.nodeId);
    await this.applyCapabilityOperationGuards(
      input.sessionId,
      this.capabilities?.getOperationGuards(input.sessionId, "conversationGraph.jump") ??
        []
    );
    return this.capabilities
      ? this.capabilities.jumpConversationGraph(
          input.sessionId,
          input.nodeId,
          input.expectedRevision
        )
      : this.requireChatTreeProvider().jump(
          input.sessionId,
          input.nodeId,
          input.expectedRevision
        );
  }

  public async prepareChatTreeSend(input: { sessionId: string; nodeId?: string }): Promise<{ sessionId: string }> {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    return this.wrapperChatTree.prepareSend(input.sessionId, input.nodeId);
  }

  public async markChatTreeRead(input: { sessionId: string; nodeId: string }): Promise<{ readNodeIds: string[] }> {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    return this.wrapperChatTree.markRead(input.sessionId, input.nodeId);
  }

  public async runChatTreeNodeAction(input: import("@vermillion/shared").ChatTreeNodeActionInput): Promise<SessionActionResult> {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    if (input.action === "hide_branch") {
      const index = this.runtimeService.getSessionIndexStore?.();
      if (!index) throw new Error("Session index is unavailable.");
      await this.wrapperChatTree.hideBranch(input.sessionId, input.nodeId,
        (sessionId) => index.hideSession(sessionId));
      return { action: "hide_branch", hidden: true };
    }
    const target = await this.wrapperChatTree.getNodeTarget(input.sessionId, input.nodeId);
    return this.runSessionAction({ sessionId: target.sessionId, action: input.action });
  }

  public submitChatTreeSend(input: import("@vermillion/shared").ChatTreeSendInput) {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    return this.wrapperChatTree.submit(input, (command) => this.executeCommand(command));
  }

  public retryChatTreeSend(input: { operationId: string }) {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    return this.wrapperChatTree.retry(input.operationId, (command) => this.executeCommand(command));
  }

  public async cancelChatTreeSend(operationId: string, action: "cancel" | "remove") {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    return this.wrapperChatTree.cancel(operationId, action, {
      archive: (sessionId) => this.runSessionAction({ sessionId, action: "archive" }),
      interrupt: async (sessionId, turnId) => {
        const receipt = await this.executeCommand({ commandId: randomUUID(), command: {
          type: "interruptTurn", sessionId, turnId
        } });
        if (!receipt.accepted && receipt.error?.message !== "no active turn to interrupt") {
          throw new Error(receipt.error?.message ?? "Branch turn interrupt was not accepted.");
        }
      }
    });
  }

  public getChatTreeOperations(input: { sessionId: string }) {
    if (!this.wrapperChatTree) throw new Error("Wrapper session trees are unavailable.");
    return { operations: this.wrapperChatTree.listOperations(input.sessionId) };
  }

  public async getDelegation(sessionId: string): Promise<DelegationSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        supportsControl: false,
        nodes: [],
        edges: [],
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getDelegation(sessionId);
  }

  public async getWorktree(sessionId: string): Promise<WorktreeSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getWorktree(sessionId);
  }

  public async getCheckpoint(sessionId: string): Promise<CheckpointSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        supportsRestore: false,
        checkpoints: [],
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getCheckpoint(sessionId);
  }

  public async getDiagnostics(sessionId: string): Promise<DiagnosticsSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        authenticated: false,
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getDiagnostics(sessionId);
  }

  public async getBackgroundRun(sessionId: string): Promise<BackgroundRunSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        status: "unsupported",
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getBackgroundRun(sessionId);
  }

  public async writeErrorLog(
    input: ErrorLogWriteInputRpc
  ): Promise<ErrorLogWriteResultRpc> {
    return this.errorLogService.write(input);
  }

  public async writeDiagnosticLog(
    input: DiagnosticsWriteInputRpc
  ): Promise<DiagnosticsWriteResultRpc> {
    return this.diagnosticLogService.write(input);
  }

  public async runFileAction(input: {
    path: string;
    action: "open" | "reveal";
  }) {
    return {
      result: await this.fileActionService.runAction(input)
    };
  }

  /** 引擎自有的扩展 RPC（如 `codex.turnChanges.*`）：方法名由装配单元声明。 */
  public async runEngineMethod(method: string, params: unknown): Promise<unknown> {
    const handler = this.engineMethods.get(method);
    if (!handler) {
      throw new Error(`Engine method is unavailable for this runtime: ${method}`);
    }
    return handler(params as never);
  }

  private requireWorkspaceRegistry() {
    const registry = this.runtimeService.getWorkspaceRegistry();
    if (!registry) {
      throw new Error("Workspace registry is unavailable.");
    }
    return registry;
  }

  private createWorkspaceSelectionService(): WorkspaceSelectionService {
    return new WorkspaceSelectionService({
      workspaceRegistry: this.requireWorkspaceRegistry()
    });
  }

  private requireSessionActions(): SessionActionsProvider {
    if (!this.sessionActions) {
      throw new Error("Session actions are unavailable.");
    }
    return this.sessionActions;
  }

  private requireChatTreeProvider(): ChatTreeProvider {
    if (!this.chatTreeProvider) {
      throw new Error("Conversation graph is unavailable.");
    }
    return this.chatTreeProvider;
  }

  private async activateOpenedSession(
    sessionId: string,
    input: {
      signal?: AbortSignal;
    } = {}
  ): Promise<void> {
    const run = this.activationQueue
      .catch(() => undefined)
      .then(async () => {
        const context = this.sessionIdentity.resolveContext(sessionId);
        if (input.signal) throwIfOpenCancelled(input.signal);
        await this.createWorkspaceSelectionService().activateSelection({
          workspaceId: context.indexEntry?.workspaceId,
          sessionId
        });
        if (input.signal) throwIfOpenCancelled(input.signal);
        await this.sessionCatalog.markSessionRead(sessionId);
        if (input.signal) throwIfOpenCancelled(input.signal);
      });
    this.activationQueue = run.catch(() => undefined);
    await run;
  }

  private async ensureSessionReadyForCommand(
    command: Extract<CommandEnvelope["command"], { sessionId: string }>
  ): Promise<void> {
    const requiresFullHydration =
      command.type === "forkSession" ||
      command.type === "steerTurn" ||
      command.type === "interruptTurn" ||
      command.type === "respondApproval" ||
      command.type === "respondInteraction";
    await this.ensureInteractiveSessionLoaded(command.sessionId, {
      requiresFullHydration
    });
  }

  private async applyCapabilityOperationGuards(
    sessionId: string,
    guards: readonly CapabilityOperationGuard[]
  ): Promise<void> {
    if (guards.includes("interactive-session")) {
      await this.ensureInteractiveSessionLoaded(sessionId);
    }
  }

  private async ensureInteractiveSessionLoaded(
    sessionId: string,
    input: {
      requiresFullHydration?: boolean;
    } = {}
  ): Promise<void> {
    const current = this.runtimeService.getSession(sessionId);
    const needsFullHydration =
      !current || this.partiallyHydratedSessionIds.has(sessionId);
    if (!needsFullHydration) {
      return;
    }
    const loaded =
      (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
        force: Boolean(current)
      })) ?? false;
    if (loaded) {
      this.partiallyHydratedSessionIds.delete(sessionId);
    }
    if (!this.runtimeService.getSession(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (
      input.requiresFullHydration &&
      this.partiallyHydratedSessionIds.has(sessionId)
    ) {
      throw new Error(`Session could not be fully loaded: ${sessionId}`);
    }
  }

  private async ensureOpenedSessionExecutable(sessionId: string): Promise<void> {
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.providerHandle || !this.sessionReconciliation) {
      return;
    }
    const executable = await this.sessionReconciliation.ensureSessionExecutable(
      sessionId
    );
    if (!executable) {
      throw new Error("This session could not be resumed for sending.");
    }
  }

  private startSessionExecutionRecovery(sessionId: string): void {
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.providerHandle || !this.sessionReconciliation ||
        this.executionRecoveryBySessionId.has(sessionId)) {
      return;
    }
    const recovery = (async () => {
      await this.updateExecutionRecoveryStatus(sessionId, { status: "pending" });
      try {
        await this.ensureOpenedSessionExecutable(sessionId);
        await this.updateExecutionRecoveryStatus(sessionId, { status: "ready" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.updateExecutionRecoveryStatus(sessionId, { status: "failed", message });
        console.warn("[vermillion] Session execution recovery failed", {
          sessionId,
          error: message
        });
      }
    })().finally(() => {
      if (this.executionRecoveryBySessionId.get(sessionId) === recovery) {
        this.executionRecoveryBySessionId.delete(sessionId);
      }
    });
    this.executionRecoveryBySessionId.set(sessionId, recovery);
  }

  private async updateExecutionRecoveryStatus(
    sessionId: string,
    executionRecovery: { status: "pending" | "ready" | "failed"; message?: string }
  ): Promise<void> {
    try {
      await this.runtimeService.updateSessionMetadata(sessionId, { executionRecovery });
    } catch (error) {
      console.warn("[vermillion] Failed to persist session execution recovery", {
        sessionId,
        status: executionRecovery.status,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async hydrateSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      signal?: AbortSignal;
      retainExecution?: boolean;
    }
  ): Promise<SessionWindowSnapshot | undefined> {
    const hydration = this.sessionReconciliation?.hydrateSessionWindow?.(
      sessionId,
      input
    );
    const hydrated = await hydration?.catch(() => undefined);
    if (!hydrated || input.signal?.aborted) {
      return undefined;
    }
    this.partiallyHydratedSessionIds.add(sessionId);
    const snapshotResult = this.getRuntimeSnapshotResult();
    const snapshot = snapshotResult.snapshot;
    const participants = snapshot.participants.filter(
      (participant) => participant.conversationId === hydrated.conversation.conversationId
    );
    const sessionRelations = snapshot.sessionRelations.filter(
      (relation) =>
        relation.parentSessionId === sessionId || relation.childSessionId === sessionId
    );
    return buildSessionWindowSnapshotFromPage({
      sessionId,
      cursor: snapshotResult.cursor,
      conversation: hydrated.conversation,
      session: hydrated.session,
      turns: hydrated.turns,
      messageBlocks: hydrated.messageBlocks,
      toolCalls: hydrated.toolCalls,
      terminalStreams: hydrated.terminalStreams,
      approvalRequests: snapshot.approvalRequests.filter(
        (approval) => approval.sessionId === sessionId
      ),
      runtimeInteractions: (snapshot.runtimeInteractions ?? []).filter(
        (interaction) => interaction.sessionId === sessionId
      ),
      threadGoals: (snapshot.threadGoals ?? []).filter(
        (goal) => goal.sessionId === sessionId
      ),
      participants,
      sessionRelations,
      hasOlder: hydrated.hasOlder,
      hasNewer: hydrated.hasNewer,
      olderCursor: hydrated.olderCursor,
      newerCursor: hydrated.newerCursor
    });
  }

  private async resolveProviderAnchorTurnId(
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const chatTree = this.capabilities
        ? await this.capabilities.getConversationGraph(sessionId)
        : await this.requireChatTreeProvider().get(sessionId);
      const visibleAnchorTurnId = chatTree.visibleTurnIds?.at(-1);
      if (visibleAnchorTurnId) {
        return visibleAnchorTurnId;
      }
      if (!chatTree.currentNodeId) {
        return undefined;
      }
      return chatTree.nodes.find((node) => node.nodeId === chatTree.currentNodeId)?.turnId;
    } catch {
      return undefined;
    }
  }

  private buildSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      beforeTurnId?: string;
      anchorTurnId?: string;
      replaceSessionHistory?: boolean;
    }
  ): SessionWindowSnapshot {
    const snapshotResult = this.getRuntimeSnapshotResult();
    const snapshot = snapshotResult.snapshot;
    const session = snapshot.sessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const conversation = snapshot.conversations.find(
      (item) => item.conversationId === session.conversationId
    );
    if (!conversation) {
      throw new Error(`Conversation is unavailable for session: ${sessionId}`);
    }
    return buildSessionWindowSnapshot({
      sessionId,
      cursor: snapshotResult.cursor,
      conversation,
      session,
      turns: snapshot.turns.filter((turn) => turn.sessionId === sessionId),
      messageBlocks: snapshot.messageBlocks.filter((block) => block.sessionId === sessionId),
      toolCalls: snapshot.toolCalls.filter((toolCall) => toolCall.sessionId === sessionId),
      terminalStreams: snapshot.terminalStreams.filter(
        (terminal) => terminal.sessionId === sessionId
      ),
      approvalRequests: snapshot.approvalRequests.filter(
        (approval) => approval.sessionId === sessionId
      ),
      runtimeInteractions: (snapshot.runtimeInteractions ?? []).filter(
        (interaction) => interaction.sessionId === sessionId
      ),
      threadGoals: (snapshot.threadGoals ?? []).filter(
        (goal) => goal.sessionId === sessionId
      ),
      participants: snapshot.participants.filter(
        (participant) => participant.conversationId === conversation.conversationId
      ),
      sessionRelations: snapshot.sessionRelations.filter(
        (relation) =>
          relation.parentSessionId === sessionId || relation.childSessionId === sessionId
      ),
      limit: input.limit,
      beforeTurnId: input.beforeTurnId,
      anchorTurnId: input.anchorTurnId,
      replaceSessionHistory: input.replaceSessionHistory
    });
  }

  private getRuntimeSnapshotResult(): {
    snapshot: ReturnType<SessionRuntimeService["getSnapshot"]>;
    cursor?: string;
  } {
    const runtimeService = this.runtimeService as SessionRuntimeService & {
      getSnapshotResult?: () => {
        snapshot: ReturnType<SessionRuntimeService["getSnapshot"]>;
        cursor?: string;
      };
    };
    return (
      runtimeService.getSnapshotResult?.() ?? {
        snapshot: this.runtimeService.getSnapshot()
      }
    );
  }
}
