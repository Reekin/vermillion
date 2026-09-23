import { createCodexAdapter } from "@vermillion/adapters";
import type { SkillDescriptorRpc } from "@vermillion/shared";
import type {
  EngineIntegration,
  EngineIntegrationHost
} from "../../engine-control/engine-integration.js";
import type { EngineSurfaceDefinition } from "../../engine-control/capability-surface.js";
import { CodexCheckpointProvider } from "./checkpoint-provider.js";
import { CodexDelegationProvider } from "./delegation-provider.js";
import { CodexDiagnosticsProvider } from "./diagnostics-provider.js";
import { CodexHookActivityService } from "./extensions/hook-activity-service.js";
import { CodexTurnChangesService } from "./extensions/turn-changes-service.js";
import { CodexTurnChangesStore } from "./extensions/turn-changes-store.js";
import { CodexHistoryProjection } from "./history-projection.js";
import { CodexHistorySource } from "./history-source.js";
import { codexProgram } from "./program.js";
import { createCodexAppServerRuntimePort } from "./runtime-port.js";
import { CodexSessionActionsProvider } from "./session-actions-provider.js";
import { CodexSessionDiscoveryProvider } from "./session-discovery.js";
import { CodexWorktreeProvider } from "./worktree-provider.js";

export const codexEngineId = "codex";

const codexSurface: EngineSurfaceDefinition = {
  engineId: codexEngineId,
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
      engineId: codexEngineId,
      key: "changed-files",
      displayName: "Changed Files",
      description: "Codex turn-level file changes and local undo actions.",
      available: true
    },
    {
      engineId: codexEngineId,
      key: "hook-activity",
      displayName: "Hook Activity",
      description: "Codex hook runs, statuses, and hook output entries.",
      available: true
    }
  ]
};

export const createCodexEngineIntegration = (
  host: EngineIntegrationHost
): EngineIntegration => {
  const now = host.now;
  const turnChangesStore = new CodexTurnChangesStore({ now });
  const resolveConversationIdBySessionId = (sessionId: string) =>
    host.runtimeService()?.resolveConversationIdForSession(sessionId);
  const resolveRuntimeCommand = async () => {
    await host.workspaceRegistry.ready();
    const command = host.resolveEngineProgram(codexEngineId, codexProgram);
    return { commandPath: command.path, commandArgs: command.args };
  };
  const runtimePort = createCodexAppServerRuntimePort({
    engineId: codexEngineId,
    resolveCommand: resolveRuntimeCommand,
    resolveConversationIdBySessionId,
    recordTurnChanges: (input) => turnChangesStore.record(input),
    recordRoleContextRebuilt: (sessionId: string, developerInstructions: string) => {
      void host
        .runtimeService()
        ?.updateSessionMetadata(sessionId, { developerInstructions })
        .catch(() => undefined);
    },
    hostTools: host.hostTools,
    now,
    writeDiagnostic: host.writeDiagnostic
  });
  const sessionActions = new CodexSessionActionsProvider({
    codexRuntimePort: runtimePort
  });
  const turnChangesService = new CodexTurnChangesService({
    resolveSessionEngineId: host.resolveSessionEngineId,
    resolveWorkingDirectory: host.resolveSessionWorkingDirectory,
    undoTurnChanges: host.undoTurnChanges
  });
  const hookActivityService = new CodexHookActivityService({
    resolveSessionEngineId: host.resolveSessionEngineId
  });
  const historyProjection = new CodexHistoryProjection({
    resolveSqliteHome: () => runtimePort.getCodexSqliteHome(),
    onWarning: (message, details) => {
      host.writeDiagnostic({
        kind: "runtime-pipeline",
        severity: "warning",
        source: "codex-history-projection",
        message,
        context: details
      });
    }
  });
  const clearSessionHistory = async (sessionId: string, signal?: AbortSignal): Promise<boolean> => {
    await host.sessionIndexStore.ready();
    signal?.throwIfAborted();
    const entry = host.sessionIndexStore.getEntry(sessionId);
    const threadId =
      runtimePort.getThreadIdForSession(sessionId) ?? entry?.providerSessionId;
    if (!threadId) {
      return false;
    }
    const result = await historyProjection.clearThread(threadId, signal);
    return result.status !== "failed" && result.status !== "unavailable";
  };
  const historySource = new CodexHistorySource({
    resolvePath: async (entry, signal) => {
      if (typeof entry.metadata?.rolloutPath === "string" && entry.metadata.rolloutPath) {
        return entry.metadata.rolloutPath;
      }
      if (!entry.providerSessionId) return undefined;
      return (await runtimePort.readThread(entry.providerSessionId, false, { signal })).path ?? undefined;
    },
    isActive: (sessionId) => Boolean(runtimePort.getActiveTurnId(sessionId)),
    rebuild: async (sessionId, signal) => {
      signal?.throwIfAborted();
      const entry = host.sessionIndexStore.getEntry(sessionId);
      const threadId = runtimePort.getThreadIdForSession(sessionId) ?? entry?.providerSessionId;
      if (!threadId) throw new Error(`No Codex thread for ${sessionId}.`);
      await runtimePort.releaseThreadForHistoryRefresh(threadId, signal);
      signal?.throwIfAborted();
      if (!await clearSessionHistory(sessionId, signal)) {
        throw new Error(`Could not rebuild Codex history for ${sessionId}.`);
      }
    }
  });

  return {
    engineId: codexEngineId,
    definition: {
      engineId: codexEngineId,
      displayName: "Codex",
      integrationTier: "native",
      transportKind: "codex"
    },
    surface: codexSurface,
    program: codexProgram,
    binding: {
      descriptor: {
        engineId: codexEngineId,
        displayName: "Codex",
        capabilities: ["chat", "tool", "terminal", "approval"]
      },
      integrationTier: "native",
      transportKind: "codex",
      adapter: createCodexAdapter(runtimePort, {
        id: codexEngineId,
        fallbackAgentId: codexEngineId,
        resolveConversationIdBySessionId
      }),
      providerKind: "codex-thread",
      sharedCapabilities: [...(codexSurface.sharedCapabilities ?? [])],
      extensions: [...(codexSurface.extensions ?? [])],
      modelCatalog: () => runtimePort.listModelCatalog(),
      resolveProviderSessionId: (sessionId: string) =>
        runtimePort.getThreadIdForSession(sessionId)
    },
    capabilities: {
      engineId: codexEngineId,
      sessionActions,
      delegation: new CodexDelegationProvider(),
      worktree: new CodexWorktreeProvider({ codexRuntimePort: runtimePort, now }),
      checkpoint: new CodexCheckpointProvider({ codexRuntimePort: runtimePort, now }),
      diagnostics: new CodexDiagnosticsProvider({ codexRuntimePort: runtimePort, now }),
      sessionDiscovery: new CodexSessionDiscoveryProvider({
        historySource,
        codexRuntimePort: runtimePort,
        turnChangesStore,
        resolveHistoryCwd: (workspaceId: string) =>
          host.workspaceRegistry.getWorkspace(workspaceId)?.absolutePath,
        resolveRoleInstructions: (workspaceId: string, metadata: Record<string, unknown>) =>
          host.runtimeService()?.resolveRoleInstructions(workspaceId, metadata) ??
          Promise.resolve(undefined)
      }),
      sessionRuntime: {
        historySource: {
          isCurrent: async (sessionId, signal) => {
            await host.sessionIndexStore.ready();
            const entry = host.sessionIndexStore.getEntry(sessionId);
            return entry ? historySource.isCurrent(entry, signal) : false;
          }
        },
        releaseSessionExecution: (sessionId: string) =>
          runtimePort.releaseSessionExecutionAndWait(sessionId),
        clearSessionHistory,
        getActiveTurnId: (sessionId: string) => runtimePort.getActiveTurnId(sessionId),
        listSkills: async (input) => {
          const result = await runtimePort.listSkills({
            cwds: input?.cwds,
            forceReload: input?.forceReload
          });
          return result.data.flatMap((entry): SkillDescriptorRpc[] =>
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
      }
    },
    engineMethods: [
      {
        method: "codex.hookActivity.get",
        handle: (params) => hookActivityService.getHookActivity(params)
      },
      {
        method: "codex.turnChanges.get",
        handle: (params) => turnChangesService.getTurnChanges(params)
      },
      {
        method: "codex.turnChanges.undo",
        handle: (params) => turnChangesService.undoTurnChanges(params)
      }
    ],
    resolveTitleAuth: () => runtimePort.readOpenAiCompatibleAuth()
  };
};
