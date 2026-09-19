import type { ProviderSessionHandle, SkillDescriptorRpc } from "@vermillion/shared";
import type { SessionIndexStore } from "./session-index.js";
import {
  SessionIdentityRegistry,
  type ResolvedSessionContext
} from "./session-identity-registry.js";
import type { SessionDiscoveryProvider } from "./session-discovery.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionWindowSnapshot } from "./session-window.js";

export type SessionActionKind =
  | "archive"
  | "copy_awb_session_id"
  | "copy_session_id"
  | "fork"
  | "open_rollout"
  | "pin"
  | "refresh"
  | "resume"
  | "unpin";

export type SessionActionDescriptor = {
  action: SessionActionKind;
  label: string;
  disabled?: boolean;
  reason?: string;
};

export type SessionActionResult =
  | { action: "archive"; archived: true }
  | { action: "copy_awb_session_id"; copiedText: string }
  | { action: "copy_session_id"; copiedText: string }
  | {
      action: "fork";
      status: "forked";
      forkedSessionId: string;
      providerSessionId: string;
    }
  | {
      action: "fork";
      status: "unsupported";
      message: string;
    }
  | {
      action: "open_rollout";
      rolloutPath: string;
      rolloutDisplayPath: string;
      rolloutFileUrl: string;
    }
  | { action: "pin"; pinned: true }
  | { action: "refresh"; refreshed: true; details?: string }
  | { action: "resume"; resumed: true }
  | { action: "unpin"; pinned: false };

export type ConversationGraphNodeSnapshot = {
  nodeId: string;
  sessionId?: string;
  canArchive?: boolean;
  providerNodeId?: string;
  parentNodeId?: string;
  label: string;
  summary?: string;
  turnId?: string;
  order: number;
  isCurrent: boolean;
  unread?: boolean;
  status?: "pending" | "completed" | "interrupted" | "replaced" | "reviewEnded";
};

export type ConversationGraphSnapshot = {
  sessionId: string;
  treeId?: string;
  workspaceId?: string;
  currentSessionId?: string;
  memberSessionIds?: string[];
  windows?: SessionWindowSnapshot[];
  engineId: string;
  supportsJump: boolean;
  version?: number;
  revision?: number;
  currentNodeId?: string;
  visibleNodeIds?: string[];
  visibleTurnIds?: string[];
  nodes: ConversationGraphNodeSnapshot[];
  fetchedAt: string;
};

export type DelegationNodeSnapshot = {
  nodeId: string;
  providerNodeId?: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  role: "root" | "delegate";
  parentNodeId?: string;
  linkedSessionId?: string;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
};

export type DelegationEdgeSnapshot = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: "spawn" | "handoff" | "wait" | "resume";
};

export type DelegationSnapshot = {
  sessionId: string;
  engineId: string;
  supported: boolean;
  supportsControl: boolean;
  currentActiveNodeId?: string;
  nodes: DelegationNodeSnapshot[];
  edges: DelegationEdgeSnapshot[];
  fetchedAt: string;
};

export type WorktreeSnapshot = {
  sessionId: string;
  engineId: string;
  supported: boolean;
  workspaceRoot?: string;
  rolloutPath?: string;
  gitBranch?: string;
  gitSha?: string;
  gitOriginUrl?: string;
  diffToRemoteSha?: string;
  diffToRemote?: string;
  fetchedAt: string;
};

export type CheckpointEntrySnapshot = {
  checkpointId: string;
  providerCheckpointId?: string;
  label: string;
  summary?: string;
  turnId?: string;
  order: number;
  isCurrent: boolean;
};

export type CheckpointSnapshot = {
  sessionId: string;
  engineId: string;
  supported: boolean;
  supportsRestore: boolean;
  currentCheckpointId?: string;
  checkpoints: CheckpointEntrySnapshot[];
  fetchedAt: string;
};

export type DiagnosticsSnapshot = {
  sessionId: string;
  engineId: string;
  supported: boolean;
  authenticated: boolean;
  authMethod?: string | null;
  requiresOpenaiAuth?: boolean | null;
  gitBranch?: string;
  gitSha?: string;
  diffToRemoteSha?: string;
  diffToRemote?: string;
  summaryText?: string;
  fetchedAt: string;
};

export type BackgroundRunSnapshot = {
  sessionId: string;
  engineId: string;
  supported: boolean;
  status: "unsupported" | "attached" | "detached";
  resumeToken?: string;
  fetchedAt: string;
};

export type CapabilityOperation = "conversationGraph.jump";

export type CapabilityOperationGuard = "interactive-session";

export type CapabilityOperationGuards = Partial<
  Record<CapabilityOperation, readonly CapabilityOperationGuard[]>
>;

export type SessionCapabilityContext = ResolvedSessionContext & {
  runtimeService: SessionRuntimeService;
  sessionIndexStore: SessionIndexStore;
  sessionIdentity: SessionIdentityRegistry;
};

export type SessionActionOptions = {
  preserveExecution?: boolean;
  fromTurnId?: string;
  activateFork?: boolean;
  cwd?: string;
  metadata?: Record<string, unknown>;
};

export type SessionActionsCapability = {
  resolveDisplayedSessionId?: (input: SessionCapabilityContext) => string | undefined;
  listAdditionalActions?: (
    input: SessionCapabilityContext
  ) => Promise<SessionActionDescriptor[]>;
  prepareArchive?: (input: SessionCapabilityContext) => Promise<void>;
  runAction?: (
    input: SessionCapabilityContext & SessionActionOptions & { action: SessionActionKind }
  ) => Promise<SessionActionResult | undefined>;
};

export type ConversationGraphCapability = {
  get: (input: SessionCapabilityContext) => Promise<ConversationGraphSnapshot>;
  jump?: (
    input: SessionCapabilityContext,
    nodeId: string,
    expectedRevision?: number
  ) => Promise<boolean>;
};

export type DelegationCapability = {
  get: (input: SessionCapabilityContext) => Promise<DelegationSnapshot>;
};

export type WorktreeCapability = {
  get: (input: SessionCapabilityContext) => Promise<WorktreeSnapshot>;
};

export type CheckpointCapability = {
  get: (input: SessionCapabilityContext) => Promise<CheckpointSnapshot>;
};

export type DiagnosticsCapability = {
  get: (input: SessionCapabilityContext) => Promise<DiagnosticsSnapshot>;
};

export type BackgroundRunCapability = {
  get: (input: SessionCapabilityContext) => Promise<BackgroundRunSnapshot>;
};

/**
 * 会话级运行时操作：不产出快照，直接作用于某个会话的执行环境或历史。
 * 未实现的操作按调用点各自的默认行为处理，不伪造成功。
 */
export type SessionRuntimeCapability = {
  releaseSessionExecution?: (sessionId: string) => Promise<void>;
  clearSessionHistory?: (sessionId: string) => Promise<boolean>;
  getActiveTurnId?: (sessionId: string) => string | undefined;
  listSkills?: (input?: {
    cwds?: string[];
    forceReload?: boolean;
  }) => Promise<SkillDescriptorRpc[]>;
};

export type AgentWorkbenchCapabilities = {
  readonly engineId: string;
  readonly operationGuards?: CapabilityOperationGuards;
  readonly sessionActions?: SessionActionsCapability;
  readonly conversationGraph?: ConversationGraphCapability;
  readonly delegation?: DelegationCapability;
  readonly worktree?: WorktreeCapability;
  readonly checkpoint?: CheckpointCapability;
  readonly diagnostics?: DiagnosticsCapability;
  readonly backgroundRun?: BackgroundRunCapability;
  readonly sessionDiscovery?: SessionDiscoveryProvider;
  readonly sessionRuntime?: SessionRuntimeCapability;
};

type CapabilityRegistryOptions = {
  runtimeService: SessionRuntimeService;
  sessionIndexStore: SessionIndexStore;
  sessionIdentity: SessionIdentityRegistry;
  capabilities?: AgentWorkbenchCapabilities[];
  now?: () => string;
};

const unsupportedConversationGraph = (
  sessionId: string,
  engineId: string,
  fetchedAt: string
): ConversationGraphSnapshot => ({
  sessionId,
  engineId,
  supportsJump: false,
  nodes: [],
  fetchedAt
});

const unsupportedDelegation = (
  sessionId: string,
  engineId: string,
  fetchedAt: string
): DelegationSnapshot => ({
  sessionId,
  engineId,
  supported: false,
  supportsControl: false,
  nodes: [],
  edges: [],
  fetchedAt
});

const unsupportedWorktree = (
  sessionId: string,
  engineId: string,
  fetchedAt: string
): WorktreeSnapshot => ({
  sessionId,
  engineId,
  supported: false,
  fetchedAt
});

const unsupportedCheckpoint = (
  sessionId: string,
  engineId: string,
  fetchedAt: string
): CheckpointSnapshot => ({
  sessionId,
  engineId,
  supported: false,
  supportsRestore: false,
  checkpoints: [],
  fetchedAt
});

const unsupportedDiagnostics = (
  sessionId: string,
  engineId: string,
  fetchedAt: string
): DiagnosticsSnapshot => ({
  sessionId,
  engineId,
  supported: false,
  authenticated: false,
  fetchedAt
});

const unsupportedBackgroundRun = (
  sessionId: string,
  engineId: string,
  fetchedAt: string
): BackgroundRunSnapshot => ({
  sessionId,
  engineId,
  supported: false,
  status: "unsupported",
  fetchedAt
});

export class CapabilityRegistry {
  private readonly runtimeService: SessionRuntimeService;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly sessionIdentity: SessionIdentityRegistry;
  private readonly capabilitiesByEngineId: Map<string, AgentWorkbenchCapabilities>;
  private readonly now: () => string;

  public constructor(options: CapabilityRegistryOptions) {
    this.runtimeService = options.runtimeService;
    this.sessionIndexStore = options.sessionIndexStore;
    this.sessionIdentity = options.sessionIdentity;
    this.capabilitiesByEngineId = new Map(
      (options.capabilities ?? []).map((entry) => [entry.engineId, entry] as const)
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public resolveContext(sessionId: string): SessionCapabilityContext {
    return {
      ...this.sessionIdentity.resolveContext(sessionId),
      runtimeService: this.runtimeService,
      sessionIndexStore: this.sessionIndexStore,
      sessionIdentity: this.sessionIdentity
    };
  }

  public getEngineCapabilities(
    engineId: string | undefined
  ): AgentWorkbenchCapabilities | undefined {
    return engineId ? this.capabilitiesByEngineId.get(engineId) : undefined;
  }

  public getSessionDiscoveryProvider(
    engineId: string | undefined
  ): SessionDiscoveryProvider | undefined {
    return this.getEngineCapabilities(engineId)?.sessionDiscovery;
  }

  public getSessionRuntime(
    engineId: string | undefined
  ): SessionRuntimeCapability | undefined {
    return this.getEngineCapabilities(engineId)?.sessionRuntime;
  }

  private sessionRuntime(sessionId: string): SessionRuntimeCapability | undefined {
    return this.getSessionRuntime(this.resolveContext(sessionId).engineId);
  }

  public async releaseSessionExecution(sessionId: string): Promise<void> {
    const capability = this.sessionRuntime(sessionId)?.releaseSessionExecution;
    if (!capability) {
      throw new Error("Execution release is unavailable for this runtime.");
    }
    await capability(sessionId);
  }

  public async clearSessionHistory(sessionId: string): Promise<boolean> {
    return (await this.sessionRuntime(sessionId)?.clearSessionHistory?.(sessionId)) ?? false;
  }

  public getActiveTurnId(sessionId: string): string | undefined {
    return this.sessionRuntime(sessionId)?.getActiveTurnId?.(sessionId);
  }

  /** 技能是用户级资源，按引擎聚合后去重，界面不区分来源引擎。 */
  public async listSkills(input?: {
    cwds?: string[];
    forceReload?: boolean;
  }): Promise<SkillDescriptorRpc[]> {
    const skills = await Promise.all(
      [...this.capabilitiesByEngineId.values()].map(
        (entry) => entry.sessionRuntime?.listSkills?.(input) ?? []
      )
    );
    const seen = new Set<string>();
    return skills.flat().filter((skill) => {
      const key = `${skill.cwd}::${skill.name}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  public async forkSessionFromTurn(
    sessionId: string,
    turnId: string
  ): Promise<string> {
    const result = await this.runSessionAction(sessionId, "fork", {
      fromTurnId: turnId,
      activateFork: false
    });
    if (result.action !== "fork" || result.status !== "forked") {
      throw new Error("Unable to fork this turn.");
    }
    return result.forkedSessionId;
  }

  public getOperationGuards(
    sessionId: string,
    operation: CapabilityOperation
  ): readonly CapabilityOperationGuard[] {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return this.getEngineCapabilities(context.engineId)?.operationGuards?.[operation] ?? [];
  }

  public listSessionDiscoveryProviders(): SessionDiscoveryProvider[] {
    return [...this.capabilitiesByEngineId.values()]
      .map((entry) => entry.sessionDiscovery)
      .filter((entry): entry is SessionDiscoveryProvider => Boolean(entry));
  }

  public async listSessionActions(
    sessionId: string
  ): Promise<SessionActionDescriptor[]> {
    const context = this.resolveContext(sessionId);
    const { session, indexEntry } = context;
    const actions: SessionActionDescriptor[] = [
      {
        action: "copy_session_id",
        label: "Copy session id"
      },
      {
        action: "copy_awb_session_id",
        label: "Copy internal session id"
      }
    ];
    if (!session && !indexEntry) {
      return actions;
    }

    actions.push({
      action: "archive",
      label: "Archive",
      disabled: Boolean(session?.archivedAt ?? indexEntry?.archivedAt),
      reason:
        session?.archivedAt ?? indexEntry?.archivedAt
          ? "Session is already archived."
          : undefined
    });
    actions.push({
      action: "refresh",
      label: "Refresh"
    });
    actions.push({
      action: "resume",
      label: "Resume"
    });
    const provider = this.getEngineCapabilities(context.engineId)?.sessionActions;
    if (provider?.listAdditionalActions) {
      actions.push(...(await provider.listAdditionalActions(context)));
    }

    return actions;
  }

  public async runSessionAction(
    sessionId: string,
    action: SessionActionKind,
    options: SessionActionOptions = {}
  ): Promise<SessionActionResult> {
    const context = this.resolveContext(sessionId);
    const { session, indexEntry } = context;
    if (
      !session &&
      !indexEntry &&
      action !== "copy_session_id" &&
      action !== "copy_awb_session_id"
    ) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const provider = this.getEngineCapabilities(context.engineId)?.sessionActions;
    switch (action) {
      case "copy_awb_session_id":
        return {
          action,
          copiedText: sessionId
        };
      case "copy_session_id":
        return {
          action,
          copiedText:
            provider?.resolveDisplayedSessionId?.(context) ??
            context.providerHandle?.providerSessionId ??
            sessionId
        };
      case "archive":
        await provider?.prepareArchive?.(context);
        await this.archiveSessionCascade(context);
        return {
          action,
          archived: true
        };
      case "refresh": {
        const result = await provider?.runAction?.({
          ...context,
          action
        });
        return (
          result ?? {
            action,
            refreshed: true,
            details: "No runtime environment refresh is available for this session."
          }
        );
      }
      case "resume":
        {
          const result = await provider?.runAction?.({
            ...context,
            ...options,
            action
          });
          if (result) {
            await this.sessionIndexStore.markSessionRead(sessionId);
            return result;
          }
        }
        if (!session && indexEntry) {
          return {
            action,
            resumed: true
          };
        }
        await this.runtimeService.executeCommand({
          commandId: `resume-${sessionId}`,
          command: {
            type: "resumeSession",
            sessionId
          }
        });
        return {
          action,
          resumed: true
        };
      case "fork": {
        const result = await provider?.runAction?.({
          ...context,
          ...options,
          action
        });
        if (result) {
          return result;
        }
        return {
          action,
          status: "unsupported",
          message: `Fork is not supported for ${context.engineId ?? "unknown"} sessions.`
        };
      }
      case "open_rollout": {
        const result = await provider?.runAction?.({
          ...context,
          action
        });
        if (result) {
          return result;
        }
        throw new Error(
          `Open rollout is not supported for ${context.engineId ?? "unknown"} sessions.`
        );
      }
      case "pin":
      case "unpin":
        throw new Error("Pin actions must be handled by the workbench shell.");
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  public async getConversationGraph(
    sessionId: string
  ): Promise<ConversationGraphSnapshot> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.conversationGraph;
    if (!capability) {
      return unsupportedConversationGraph(sessionId, context.engineId, this.now());
    }
    return capability.get(context);
  }

  public async jumpConversationGraph(
    sessionId: string,
    nodeId: string,
    expectedRevision?: number
  ): Promise<{ jumped: boolean }> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.conversationGraph;
    if (!capability?.jump) {
      return {
        jumped: false
      };
    }
    return {
      jumped: await capability.jump(context, nodeId, expectedRevision)
    };
  }

  public async getDelegation(sessionId: string): Promise<DelegationSnapshot> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.delegation;
    if (!capability) {
      return unsupportedDelegation(sessionId, context.engineId, this.now());
    }
    return capability.get(context);
  }

  public async getWorktree(sessionId: string): Promise<WorktreeSnapshot> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.worktree;
    if (!capability) {
      return unsupportedWorktree(sessionId, context.engineId, this.now());
    }
    return capability.get(context);
  }

  public async getCheckpoint(sessionId: string): Promise<CheckpointSnapshot> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.checkpoint;
    if (!capability) {
      return unsupportedCheckpoint(sessionId, context.engineId, this.now());
    }
    return capability.get(context);
  }

  public async getDiagnostics(sessionId: string): Promise<DiagnosticsSnapshot> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.diagnostics;
    if (!capability) {
      return unsupportedDiagnostics(sessionId, context.engineId, this.now());
    }
    return capability.get(context);
  }

  public async getBackgroundRun(sessionId: string): Promise<BackgroundRunSnapshot> {
    const context = this.resolveContext(sessionId);
    if (!context.engineId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const capability = this.getEngineCapabilities(context.engineId)?.backgroundRun;
    if (!capability) {
      return unsupportedBackgroundRun(sessionId, context.engineId, this.now());
    }
    return capability.get(context);
  }

  private async archiveSessionCascade(root: SessionCapabilityContext): Promise<void> {
    const localSessionIds = new Set([
      root.sessionId,
      ...(await this.archiveProviderAliases({
        sessionId: root.sessionId,
        handle: root.providerHandle,
        providerSessionId:
          this.getEngineCapabilities(root.engineId)?.sessionActions?.resolveDisplayedSessionId?.(
            root
          ) ?? root.providerHandle?.providerSessionId,
        workspaceId: root.indexEntry?.workspaceId
      }))
    ]);

    const runtimeSessions = new Map(
      this.runtimeService
        .listSessions({ includeArchived: true })
        .map((session) => [session.sessionId, session] as const)
    );
    for (const sessionId of localSessionIds) {
      const session = runtimeSessions.get(sessionId);
      if (!session || session.archivedAt) {
        continue;
      }
      await this.runtimeService.executeCommand({
        commandId: `archive-${root.sessionId}-${sessionId}`,
        command: {
          type: "archiveSession",
          sessionId
        }
      });
    }
  }

  private async archiveProviderAliases(input: {
    sessionId: string;
    handle: ProviderSessionHandle | undefined;
    providerSessionId?: string;
    workspaceId?: string;
  }): Promise<string[]> {
    const aliases = new Set([input.sessionId]);
    if (input.handle) {
      for (const sessionId of this.sessionIdentity.listSessionIdsByProviderHandle(
        input.handle,
        input.workspaceId
      )) {
        aliases.add(sessionId);
      }
    } else if (input.providerSessionId) {
      for (const entry of this.sessionIndexStore.listEntriesByProviderSessionId(
        input.providerSessionId,
        input.workspaceId
      )) {
        aliases.add(entry.sessionId);
      }
    }
    return (await this.sessionIndexStore.archiveSessions([...aliases])).map(
      (entry) => entry.sessionId
    );
  }
}
