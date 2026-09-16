import { SessionRuntimeService } from "./runtime-service.js";
import { SessionIndexStore } from "./session-index.js";
import { SessionCatalogService } from "./session-catalog.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { SessionReconciliationService } from "./session-discovery.js";
import { SessionShellService } from "./session-shell-service.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { WrapperChatTreeService } from "./wrapper-chat-tree.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import { EngineRegistryService } from "./engine-control/engine-registry.js";
import { EngineCapabilitySurfaceService } from "./engine-control/capability-surface.js";
import type { EngineIntegration } from "./engine-control/engine-integration.js";
import { engineIntegrations } from "./engines/index.js";
import { FileActionService } from "./file-action-service.js";
import { ErrorLogService } from "./error-log-service.js";
import { DiagnosticLogService } from "./diagnostic-log-service.js";
import { HostToolRegistry } from "./host-tools.js";
import { createReadSessionHostTool } from "./read-session-host-tool.js";
import { createSessionWorkingDirectoryResolver } from "./session-working-directory.js";
import { TurnChangeService } from "./turn-change-service.js";
import {
  resolveEngineProgramCommand,
  type EngineProgramCommand,
  type EngineProgramRule
} from "./engine-program-resolution.js";
import {
  createOpenAiSessionTitleGenerator,
  type SessionTitleGenerator
} from "./title-generation-service.js";

export type CreateWorkbenchRuntimeServiceOptions = {
  /** 装配期覆盖引擎启动命令；用户侧的程序路径仍由 workspace 注册表设置提供。 */
  engineCommands?: Record<string, { path: string; args?: string[] }>;
  /** 随包附带的 pi 扩展入口，由应用壳解析后传入。 */
  piExtensionPath?: string;
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

/** 生产装配：按引擎装配单元列表接线，其余由各 `EngineIntegration` 与能力分发完成。 */
export const createSessionRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => {
  let service: SessionRuntimeService | undefined;
  let sessionIdentity: SessionIdentityRegistry | undefined;
  const workspaceRegistry = new WorkspaceRegistryService({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const sessionIndexStore = new SessionIndexStore({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const hostTools = new HostToolRegistry();
  const diagnosticLogService = new DiagnosticLogService({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const now = options.now ?? (() => new Date().toISOString());
  const turnChangeService = new TurnChangeService();
  const writeDiagnostic = (input: Parameters<DiagnosticLogService["write"]>[0]) => {
    void diagnosticLogService.write(input).catch(() => undefined);
  };
  const resolveProgram = (engineId: string, program: EngineProgramRule): EngineProgramCommand => {
    const override = options.engineCommands?.[engineId];
    if (override) {
      return resolveEngineProgramCommand(engineId, {
        program,
        customPath: override.path,
        configuredArgs: override.args
      });
    }
    return resolveEngineProgramCommand(engineId, {
      program,
      configuredPath:
        workspaceRegistry.getState().engineProgramPathsByEngineId[engineId]
    });
  };
  const resolveSessionEngineId = (sessionId: string): string | undefined => {
    try {
      return sessionIdentity?.resolveContext(sessionId).engineId;
    } catch {
      return undefined;
    }
  };
  const integrations: EngineIntegration[] = engineIntegrations.map((factory) =>
    factory({
      persistenceBaseDir: options.persistenceBaseDir,
      piExtensionPath: options.piExtensionPath,
      workspaceRegistry,
      sessionIndexStore,
      hostTools,
      now,
      writeDiagnostic,
      resolveEngineProgram: resolveProgram,
      resolveSessionEngineId,
      resolveSessionWorkingDirectory: createSessionWorkingDirectoryResolver({
        resolveContext: (sessionId) => {
          if (!sessionIdentity) {
            throw new Error("Session identity is unavailable.");
          }
          return sessionIdentity.resolveContext(sessionId);
        },
        workspaceRegistry,
        runtimeService: () => service
      }),
      undoTurnChanges: (input) => turnChangeService.undoTurnChanges(input),
      runtimeService: () => service
    })
  );
  const engineRegistry = new EngineRegistryService({
    engines: integrations.map((integration) => integration.definition)
  });
  const engineCapabilitySurface = new EngineCapabilitySurfaceService({
    surfaces: integrations.map((integration) => integration.surface)
  });

  const runtimeService = new SessionRuntimeService({
    now: options.now,
    workspaceRegistry,
    sessionIndexStore,
    titleGenerator:
      options.titleGenerator ??
      createOpenAiSessionTitleGenerator({
        resolveAuth: async (engineId) => {
          const ordered = [
            ...integrations.filter((integration) => integration.engineId === engineId),
            ...integrations.filter((integration) => integration.engineId !== engineId)
          ];
          for (const integration of ordered) {
            const auth = await integration.resolveTitleAuth?.();
            if (auth?.apiKey?.trim()) {
              return auth;
            }
          }
          return undefined;
        },
        resolveModel: async () => {
          await workspaceRegistry.ready();
          return workspaceRegistry.getState().titleGenerationModelId;
        }
      }),
    agentBindings: integrations.map((integration) => integration.binding)
  });

  service = runtimeService;
  sessionIdentity = new SessionIdentityRegistry({
    runtimeService,
    sessionIndexStore
  });
  const capabilities = new CapabilityRegistry({
    runtimeService,
    sessionIndexStore,
    sessionIdentity,
    capabilities: integrations.map((integration) => integration.capabilities),
    now: options.now
  });
  const sessionCatalog = new SessionCatalogService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore
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
    wrapperChatTree: new WrapperChatTreeService({
      runtimeService,
      sessionIndexStore,
      reconciliation: sessionReconciliation,
      capabilities,
      logDiagnostic: ({ message, sessionId, context }) => {
        writeDiagnostic({
          kind: "runtime-pipeline",
          severity: "info",
          source: "chat-tree",
          message,
          sessionId,
          context
        });
      }
    }),
    sessionCatalog,
    capabilities,
    engineMethods: integrations.flatMap(
      (integration) => integration.engineMethods ?? []
    ),
    sessionIdentity,
    sessionReconciliation,
    engineRegistry,
    engineCapabilitySurface,
    pickWorkspaceDirectory: options.pickWorkspaceDirectory,
    resolveEngineProgram: (engineId) => {
      const integration = integrations.find((entry) => entry.engineId === engineId);
      if (!integration) {
        throw new Error(`Unknown engine: ${engineId}`);
      }
      const { args: _args, ...resolution } = resolveProgram(engineId, integration.program);
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
