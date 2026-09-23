import { homedir } from "node:os";
import { join } from "node:path";
import { createPiAdapter } from "@vermillion/adapters";
import type {
  EngineIntegration,
  EngineIntegrationHost
} from "../../engine-control/engine-integration.js";
import type { EngineSurfaceDefinition } from "../../engine-control/capability-surface.js";
import { PiDiagnosticsProvider } from "./diagnostics-provider.js";
import { startPiHostBridge } from "./host-bridge.js";
import { piProgram } from "./program.js";
import { PiRuntimePort } from "./runtime-port.js";
import { PiSessionActionsProvider } from "./session-actions-provider.js";
import { PiSessionDiscoveryProvider } from "./session-discovery.js";
import {
  piEngineId,
  piProviderKind,
  piSessionIdForSession
} from "./session-identity.js";

const piSurface: EngineSurfaceDefinition = {
  engineId: piEngineId,
  sharedCapabilities: [
    "chat",
    "turnConfiguration",
    "steer",
    "tool",
    "terminal",
    "attachments",
    "conversationGraph",
    "diagnostics"
  ]
};

export const createPiEngineIntegration = (
  host: EngineIntegrationHost
): EngineIntegration => {
  const now = host.now;
  const piSessionsRoot = join(
    host.persistenceBaseDir ?? join(homedir(), ".vermillion"),
    "pi-sessions"
  );
  const resolveSessionDirectory = (sessionId: string): string =>
    join(piSessionsRoot, piSessionIdForSession(sessionId));
  const resolveRuntimeCommand = async () => {
    await host.workspaceRegistry.ready();
    const command = host.resolveEngineProgram(piEngineId, piProgram);
    // pi 由 npm 安装，Windows 上入口是 pi.cmd；用解析结果启动才能命中 .cmd 包装。
    return {
      commandPath: command.resolvedPath ?? command.path,
      commandArgs: command.args,
      found: command.found
    };
  };
  const runtimePort = new PiRuntimePort({
    engineId: piEngineId,
    resolveCommand: resolveRuntimeCommand,
    resolveSessionDirectory,
    resolvePiSessionId: piSessionIdForSession,
    resolveSessionCwd: (sessionId) => host.resolveSessionWorkingDirectory(sessionId),
    resolveExtensionPath: () => host.piExtensionPath,
    startHostBridge: () =>
      startPiHostBridge({ engineId: piEngineId, hostTools: host.hostTools }),
    now,
    writeDiagnostic: host.writeDiagnostic
  });

  return {
    engineId: piEngineId,
    definition: {
      engineId: piEngineId,
      displayName: "pi",
      integrationTier: "native",
      transportKind: "pi-rpc"
    },
    surface: piSurface,
    program: piProgram,
    binding: {
      descriptor: {
        engineId: piEngineId,
        displayName: "pi",
        capabilities: ["chat", "tool", "terminal"]
      },
      integrationTier: "native",
      transportKind: "pi-rpc",
      adapter: createPiAdapter(runtimePort, {
        id: piEngineId,
        fallbackAgentId: piEngineId
      }),
      providerKind: piProviderKind,
      sharedCapabilities: [...(piSurface.sharedCapabilities ?? [])],
      extensions: [],
      modelCatalog: () => runtimePort.listModelCatalog(),
      resolveProviderSessionId: (sessionId: string) =>
        piSessionIdForSession(sessionId)
    },
    capabilities: {
      engineId: piEngineId,
      sessionActions: new PiSessionActionsProvider({ runtimePort, now }),
      diagnostics: new PiDiagnosticsProvider({ runtimePort, now }),
      sessionDiscovery: new PiSessionDiscoveryProvider({ runtimePort, now }),
      sessionRuntime: {
        releaseSessionExecution: (sessionId: string) =>
          runtimePort.releaseSession(sessionId),
        getActiveTurnId: (sessionId: string) => runtimePort.getActiveTurnId(sessionId),
        isSessionLive: (sessionId: string) => runtimePort.isSessionRunning(sessionId),
        listSkills: (input) => runtimePort.listSkills(input)
      }
    }
  };
};
