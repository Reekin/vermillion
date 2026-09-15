import type { DiagnosticsWriteInputRpc } from "@vermillion/shared";
import type { AgentWorkbenchCapabilities } from "../capability-registry.js";
import type {
  EngineProgramCommand,
  EngineProgramRule
} from "../engine-program-resolution.js";
import type { HostToolRegistry } from "../host-tools.js";
import type { SessionRuntimeService } from "../runtime-service.js";
import type { SessionIndexStore } from "../session-index.js";
import type { SessionAgentBinding } from "../runtime-types.js";
import type { OpenAiSessionTitleAuth } from "../title-generation-service.js";
import type { TurnChangeUndoResult } from "../turn-change-service.js";
import type { WorkspaceRegistryService } from "../workspace-registry.js";
import type { EngineSurfaceDefinition } from "./capability-surface.js";
import type { EngineDefinition } from "./engine-definition.js";

/** 引擎扩展提供的额外 RPC 入口，按方法名分发；参数在 shell 层已校验。 */
export type EngineMethodHandler = {
  method: string;
  handle: (params: never) => Promise<unknown>;
};

/**
 * 宿主向引擎装配单元提供的共享设施。这里只放与具体引擎无关的能力；
 * `runtimeService` 由 shell 装配完成后回填，引擎在收到请求前不读取它。
 */
export type EngineIntegrationHost = {
  workspaceRegistry: WorkspaceRegistryService;
  sessionIndexStore: SessionIndexStore;
  hostTools: HostToolRegistry;
  now: () => string;
  writeDiagnostic: (input: DiagnosticsWriteInputRpc) => void;
  /** 按引擎规则、自定义路径与装配期覆盖解析启动命令；调用前 workspace 注册表已就绪。 */
  resolveEngineProgram: (
    engineId: string,
    program: EngineProgramRule
  ) => EngineProgramCommand;
  resolveSessionWorkingDirectory: (sessionId: string) => Promise<string>;
  resolveSessionEngineId: (sessionId: string) => string | undefined;
  undoTurnChanges: (input: {
    cwd: string;
    diff: string;
  }) => Promise<TurnChangeUndoResult>;
  runtimeService: () => SessionRuntimeService | undefined;
};

/**
 * 一个引擎的完整装配单元。新增引擎只需要实现这一个模块，
 * 不需要修改 shell、能力分发或入口代码。
 */
export type EngineIntegration = {
  engineId: string;
  definition: EngineDefinition;
  surface: EngineSurfaceDefinition;
  program: EngineProgramRule;
  binding: SessionAgentBinding;
  capabilities: AgentWorkbenchCapabilities;
  engineMethods?: readonly EngineMethodHandler[];
  /** 标题生成可用的 OpenAI 兼容凭据；不可用时返回 undefined。 */
  resolveTitleAuth?: () => Promise<OpenAiSessionTitleAuth | undefined>;
};

export type EngineIntegrationFactory = (
  host: EngineIntegrationHost
) => EngineIntegration;
