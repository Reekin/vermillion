import { createCodexAdapter } from "@vermillion/adapters";
import { createCodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import { SessionRuntimeService } from "./runtime-service.js";
import { SessionIndexStore } from "./session-index.js";
import { SessionCatalogService } from "./session-catalog.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  CodexSessionDiscoveryProvider,
  SessionReconciliationService
} from "./session-discovery.js";
import { SessionShellService } from "./session-shell-service.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { CodexSessionActionsProvider } from "./codex-session-actions-provider.js";
import { CodexChatTreeAgentProvider } from "./codex-chat-tree-provider.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import { CodexDelegationProvider } from "./codex-delegation-provider.js";
import { CodexWorktreeProvider } from "./codex-worktree-provider.js";
import { CodexCheckpointProvider } from "./codex-checkpoint-provider.js";
import { CodexDiagnosticsProvider } from "./codex-diagnostics-provider.js";
import { EngineRegistryService } from "./engine-control/engine-registry.js";
import { EngineCapabilitySurfaceService } from "./engine-control/capability-surface.js";
import { CodexTurnChangesStore } from "./engine-extensions/codex/turn-changes-store.js";
import { FileActionService } from "./file-action-service.js";
import { ErrorLogService } from "./error-log-service.js";
import { DiagnosticLogService } from "./diagnostic-log-service.js";
import { HostToolRegistry } from "./host-tools.js";
import { createReadSessionHostTool } from "./read-session-host-tool.js";
import {
  createOpenAiSessionTitleGenerator,
  type SessionTitleGenerator
} from "./title-generation-service.js";
import type { SkillDescriptorRpc } from "@vermillion/shared";
import { resolveEngineProgramCommand } from "./engine-program-resolution.js";

export type CreateWorkbenchRuntimeServiceOptions = {
  codexCommandPath?: string;
  codexCommandArgs?: string[];
  persistenceBaseDir?: string;
  pickWorkspaceDirectory?: () => Promise<{
    canceled: boolean;
    rootPath?: string;
  }>;
  openFilePath?: (path: string) => Promise<string | void> | string | void;
  revealFilePath?: (path: string) => Promise<string | void> | string | void;
  titleGenerator?: SessionTitleGenerator;
  now?: () => string;
};

export const createSessionRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => {
  const codexAgentId = "codex";
  let service: SessionRuntimeService | undefined;
  const workspaceRegistry = new WorkspaceRegistryService({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const sessionIndexStore = new SessionIndexStore({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const codexTurnChangesStore = new CodexTurnChangesStore({
    now: options.now
  });
  const hostTools = new HostToolRegistry();
  const diagnosticLogService = new DiagnosticLogService({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const configuredPrograms = {
    [codexAgentId]: {
      path: options.codexCommandPath,
      args: options.codexCommandArgs
    }
  };
  const resolveProgram = (engineId: string, customPath?: string) => {
    const configured = configuredPrograms[engineId as keyof typeof configuredPrograms];
    return resolveEngineProgramCommand(engineId, {
      customPath,
      configuredPath: configured?.path,
      configuredArgs: configured?.args
    });
  };
  const resolveRuntimeCommand = async (engineId: string) => {
    await workspaceRegistry.ready();
    const command = resolveProgram(
      engineId,
      workspaceRegistry.getState().engineProgramPathsByEngineId[engineId]
    );
    return { commandPath: command.path, commandArgs: command.args };
  };
  const codexRuntimePort = createCodexAppServerRuntimePort({
    engineId: codexAgentId,
    resolveCommand: () => resolveRuntimeCommand(codexAgentId),
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId),
    recordTurnChanges: (input) => codexTurnChangesStore.record(input),
    hostTools,
    now: options.now,
    writeDiagnostic: (input) => {
      void diagnosticLogService.write(input).catch(() => undefined);
    }
  });
  const codexAdapter = createCodexAdapter(codexRuntimePort, {
    id: codexAgentId,
    fallbackAgentId: codexAgentId,
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId)
  });
  const engineRegistry = new EngineRegistryService({
    engines: [
      {
        engineId: codexAgentId,
        displayName: "Codex",
        integrationTier: "native",
        transportKind: "codex"
      }
    ]
  });
  const engineCapabilitySurface = new EngineCapabilitySurfaceService({
    surfaces: [
      {
        engineId: codexAgentId,
        sharedCapabilities: [
          "chat",
          "turnConfiguration",
          "steer",
          "tool",
          "terminal",
          "approval",
          "attachments",
          "conversationGraph",
          "goal",
          "delegation",
          "checkpoint",
          "worktree",
          "diagnostics"
        ],
        extensions: [
          {
            engineId: codexAgentId,
            key: "changed-files",
            displayName: "Changed Files",
            description: "Codex turn-level file changes and local undo actions.",
            available: true
          },
          {
            engineId: codexAgentId,
            key: "hook-activity",
            displayName: "Hook Activity",
            description: "Codex hook runs, statuses, and hook output entries.",
            available: true
          }
        ]
      }
    ]
  });

  const runtimeService = new SessionRuntimeService({
    now: options.now,
    workspaceRegistry,
    sessionIndexStore,
    titleGenerator:
      options.titleGenerator ??
      createOpenAiSessionTitleGenerator({
        resolveAuth: () => codexRuntimePort.readOpenAiCompatibleAuth()
      }),
    agentBindings: [
      {
        descriptor: {
          engineId: codexAgentId,
          displayName: "Codex",
          capabilities: ["chat", "tool", "terminal", "approval"]
        },
        integrationTier: "native",
        transportKind: "codex",
        adapter: codexAdapter,
        providerKind: "codex-thread",
        sharedCapabilities: engineCapabilitySurface.get(codexAgentId).sharedCapabilities,
        extensions: engineCapabilitySurface.get(codexAgentId).extensions,
        modelCatalog: () => codexRuntimePort.listModelCatalog(),
        resolveProviderSessionId: (sessionId: string) =>
          codexRuntimePort.getThreadIdForSession(sessionId)
      }
    ]
  });

  service = runtimeService;
  const sessionCatalog = new SessionCatalogService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore
  });
  const sessionIdentity = new SessionIdentityRegistry({
    runtimeService,
    sessionIndexStore
  });
  const capabilities = new CapabilityRegistry({
    runtimeService,
    sessionIndexStore,
    sessionIdentity,
    capabilities: [
      {
        engineId: codexAgentId,
        operationGuards: {
          "conversationGraph.jump": ["interactive-session"]
        },
        sessionDiscovery: new CodexSessionDiscoveryProvider({
          codexRuntimePort,
          turnChangesStore: codexTurnChangesStore
        }),
        sessionActions: new CodexSessionActionsProvider({
          codexRuntimePort
        }),
        conversationGraph: new CodexChatTreeAgentProvider({
          codexRuntimePort,
          now: options.now
        }),
        delegation: new CodexDelegationProvider(),
        worktree: new CodexWorktreeProvider({
          codexRuntimePort,
          now: options.now
        }),
        checkpoint: new CodexCheckpointProvider({
          codexRuntimePort,
          now: options.now
        }),
        diagnostics: new CodexDiagnosticsProvider({
          codexRuntimePort,
          now: options.now
        })
      }
    ],
    now: options.now
  });
  const sessionReconciliation = new SessionReconciliationService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore,
    sessionIdentity,
    capabilityRegistry: capabilities
  });

  const shellService = new SessionShellService({
    runtimeService,
    sessionCatalog,
    capabilities,
    skillsProvider: {
      listSkills: async (input): Promise<SkillDescriptorRpc[]> => {
        const result = await codexRuntimePort.listSkills({
          cwds: input?.cwds,
          forceReload: input?.forceReload
        });
        return result.data.flatMap((entry) =>
          entry.skills.map((skill) => ({
            cwd: entry.cwd,
            name: skill.name,
            description: skill.description,
            shortDescription: skill.shortDescription ?? undefined,
            path: skill.path,
            scope: String(skill.scope),
            enabled: skill.enabled
          }))
        );
      }
    },
    sessionIdentity,
    sessionReconciliation,
    engineRegistry,
    engineCapabilitySurface,
    pickWorkspaceDirectory: options.pickWorkspaceDirectory,
    resolveEngineProgram: (engineId, customPath) => {
      const { args: _args, ...resolution } = resolveProgram(engineId, customPath);
      return resolution;
    },
    fileActionService: new FileActionService({
      openPath: options.openFilePath,
      revealPath: options.revealFilePath
    }),
    errorLogService: new ErrorLogService({
      baseDir: options.persistenceBaseDir,
      now: options.now
    }),
    diagnosticLogService
  });
  shellService.hostTools = hostTools;
  hostTools.register(
    createReadSessionHostTool({
      getSnapshot: () => runtimeService.getSnapshot(),
      ensureSessionLoaded: (sessionId, options) =>
        shellService.ensureSessionLoadedForRead(sessionId, options),
      isSessionPartiallyHydrated: (sessionId) =>
        shellService.isSessionPartiallyHydrated(sessionId)
    })
  );
  return shellService;
};

export const createCodexSessionRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => createSessionRuntimeService(options);
