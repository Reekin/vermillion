import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RuntimePortError,
  createRuntimeLifecycleController,
  type AdapterRuntimePort,
  type AgentAdapterRuntimeConfig,
  type PiRuntimeEvent,
  type PiRuntimeEventMethod,
  type PiRuntimeRequest,
  type PiRuntimeResponse,
  type RuntimeEventListener,
  type RuntimeLifecycleState,
  type RuntimeOperationOptions,
  type RuntimeStartOptions,
  type RuntimeStateListener,
  type RuntimeStopOptions
} from "@vermillion/adapters";
import {
  fileUriToPath,
  isImageAttachment,
  type Attachment,
  type DiagnosticsWriteInputRpc
} from "@vermillion/shared";
import { resolveEngineSpawnCommand } from "../../engine-program-resolution.js";
import { sessionItemId } from "../../session-item-id.js";
import { spawnPiJsonlProcess, type PiJsonlProcess } from "./jsonl-process.js";
import { PiModelCatalog, type PiModelChoice } from "./model-catalog.js";
import type { PiHostBridge } from "./host-bridge.js";
import { listPiSkills } from "./skills.js";
import { piTurnEntryType } from "./session-identity.js";

const turnStartTimeoutMs = 30_000;
const commandTimeoutMs = 120_000;
const dataUriPattern = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/isu;

export type PiRuntimePortOptions = {
  engineId: string;
  resolveCommand: () => Promise<{
    commandPath: string;
    commandArgs: string[];
    found: boolean;
  }>;
  /** 每个工作台会话一个 pi 会话目录；会话文件与本次运行的辅助文件都在其下。 */
  resolveSessionDirectory: (sessionId: string) => string;
  resolvePiSessionId: (sessionId: string) => string;
  resolveSessionCwd: (sessionId: string) => Promise<string>;
  resolveExtensionPath: () => string | undefined;
  /** 首次需要宿主工具时启动回环入口；端口负责在停止时关闭它。 */
  startHostBridge?: () => Promise<PiHostBridge | undefined>;
  now?: () => string;
  writeDiagnostic?: (input: DiagnosticsWriteInputRpc) => void;
};

export type PiHostBridgeHandle = PiHostBridge;

type PendingCommand = {
  resolve: (message: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
};

type TurnExecution = {
  modelId?: string;
  reasoningOptionId?: string;
  serviceTierId?: string | null;
};

type PiSessionRuntime = {
  sessionId: string;
  piSessionId: string;
  sessionDir: string;
  cwd: string;
  process?: PiJsonlProcess;
  teardown: Array<() => void>;
  pending: Map<string, PendingCommand>;
  streaming: boolean;
  currentTurnId?: string;
  assistantCount: number;
  awaitingTurn?: {
    resolve: (turnId: string) => void;
    timer: NodeJS.Timeout;
  };
  execution?: TurnExecution;
  appliedModel?: { provider: string; modelId: string };
  appliedThinking?: string;
  lastStopReason?: string;
  toolText: Map<string, string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const summarize = (value: unknown, limit = 400): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const messageText = (message: Record<string, unknown>): string => {
  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => (isRecord(block) ? asString(block.text) ?? "" : ""))
    .join("");
};

const toolResultText = (value: unknown): string => {
  if (!isRecord(value)) {
    return "";
  }
  if (isRecord(value.partialResult)) {
    return messageText(value.partialResult);
  }
  if (isRecord(value.result)) {
    return messageText(value.result);
  }
  return "";
};

const base64Of = (bytes: Uint8Array): string =>
  (bytes as unknown as { toString(encoding: string): string }).toString("base64");

export class PiRuntimePort
  implements
    AdapterRuntimePort<PiRuntimeRequest, PiRuntimeResponse, PiRuntimeEvent>
{
  public readonly engineId: string;

  private readonly options: PiRuntimePortOptions;
  private readonly lifecycle = createRuntimeLifecycleController();
  private readonly listeners = new Set<RuntimeEventListener<PiRuntimeEvent>>();
  private readonly sessions = new Map<string, PiSessionRuntime>();
  private readonly catalog: PiModelCatalog;
  private bridge?: PiHostBridgeHandle;
  private bridgePromise?: Promise<PiHostBridgeHandle | undefined>;
  private sequence = 0;
  private readonly now: () => string;

  public constructor(options: PiRuntimePortOptions) {
    this.options = options;
    this.engineId = options.engineId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.catalog = new PiModelCatalog({
      resolveCommand: options.resolveCommand,
      writeDiagnostic: options.writeDiagnostic
    });
  }

  public getState(): RuntimeLifecycleState {
    return this.lifecycle.getState();
  }

  public async start(
    _config: AgentAdapterRuntimeConfig = {},
    _options: RuntimeStartOptions = {}
  ): Promise<void> {
    if (this.lifecycle.getState() !== "ready") {
      this.lifecycle.setState("starting");
      this.lifecycle.setState("ready");
    }
  }

  public async stop(_options: RuntimeStopOptions = {}): Promise<void> {
    if (this.lifecycle.getState() === "stopped") {
      return;
    }
    this.lifecycle.setState("stopping");
    const runtimes = [...this.sessions.values()];
    this.sessions.clear();
    for (const runtime of runtimes) {
      this.teardownRuntime(runtime);
      await runtime.process?.stop();
    }
    const bridge = this.bridge;
    this.bridge = undefined;
    this.bridgePromise = undefined;
    await bridge?.close();
    this.lifecycle.setState("stopped");
  }

  public subscribe(listener: RuntimeEventListener<PiRuntimeEvent>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeState(listener: RuntimeStateListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  public async request(
    payload: PiRuntimeRequest,
    _options: RuntimeOperationOptions = {}
  ): Promise<PiRuntimeResponse> {
    try {
      switch (payload.method) {
        case "initialize":
          return { id: payload.id, ok: true, result: {} };
        case "sendUserMessage":
          return await this.sendUserMessage(payload);
        case "steerTurn":
          return await this.steerTurn(payload);
        case "interruptTurn":
          return await this.interruptTurn(payload);
        default:
          return {
            id: payload.id,
            ok: false,
            error: {
              code: "pi_command_unsupported",
              message: `pi does not implement ${payload.method}.`
            }
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.writeDiagnostic?.({
        kind: "runtime-pipeline",
        severity: "warning",
        source: "pi-runtime-port",
        message,
        context: { method: payload.method }
      });
      return {
        id: payload.id,
        ok: false,
        error: {
          code: error instanceof RuntimePortError ? error.code : "pi_runtime_error",
          message
        }
      };
    }
  }

  public async listModelCatalog(): Promise<PiModelCatalogChoiceList> {
    return this.catalog.list(this.engineId);
  }

  public async resolveModelChoice(
    modelId: string,
    preferredProvider?: string
  ): Promise<PiModelChoice | undefined> {
    return this.catalog.resolveModel(modelId, preferredProvider);
  }

  public async listSkills(input?: {
    cwds?: string[];
    forceReload?: boolean;
  }): Promise<Awaited<ReturnType<typeof listPiSkills>>> {
    return listPiSkills({ cwds: input?.cwds });
  }

  /** 会话执行结束或归档时释放该会话的 pi 进程。 */
  public async releaseSession(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    this.sessions.delete(sessionId);
    this.teardownRuntime(runtime);
    await runtime.process?.stop();
  }

  public isSessionRunning(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    return Boolean(runtime?.process?.running);
  }

  public sessionDirectory(sessionId: string): string {
    return this.options.resolveSessionDirectory(sessionId);
  }

  public sessionWorkingDirectory(sessionId: string): Promise<string> {
    return this.options.resolveSessionCwd(sessionId);
  }

  public getActiveTurnId(sessionId: string): string | undefined {
    const runtime = this.sessions.get(sessionId);
    return runtime?.streaming ? runtime.currentTurnId : undefined;
  }

  public async readAuthStatus(): Promise<{
    authenticated: boolean;
    authMethod?: string;
    summaryText?: string;
  }> {
    const command = await this.options.resolveCommand();
    return {
      authenticated: command.found,
      authMethod: "pi models.json",
      summaryText: command.found
        ? `pi ${command.commandPath}`
        : `pi not found: ${command.commandPath}`
    };
  }

  private async sendUserMessage(
    payload: PiRuntimeRequest
  ): Promise<PiRuntimeResponse> {
    const sessionId = asString(payload.params.sessionId);
    if (!sessionId) {
      return {
        id: payload.id,
        ok: false,
        error: { code: "pi_command_invalid", message: "sessionId is required." }
      };
    }
    const runtime = await this.ensureRuntime(sessionId, payload.params);
    const execution = this.readExecution(payload.params);
    runtime.execution = execution;
    const developerInstructions = await this.syncRoleInstructions(
      runtime,
      payload.params
    );
    await this.applyExecution(runtime, execution);
    const images = await this.buildImages(payload.params.attachments);
    const turnPromise = this.armTurn(runtime);
    await this.writePendingTurn(runtime, {
      messageId: asString(payload.params.messageId) ?? "",
      steer: false
    });
    const response = await this.sendCommand(runtime, payload.id, {
      type: "prompt",
      message: asString(payload.params.content) ?? "",
      ...(images.length > 0 ? { images } : {})
    });
    if (response.success !== true) {
      this.disarmTurn(runtime);
      return {
        id: payload.id,
        ok: false,
        error: {
          code: "pi_prompt_rejected",
          message: String(response.error ?? "pi rejected the prompt.")
        }
      };
    }
    const turnId = await turnPromise;
    return {
      id: payload.id,
      ok: true,
      result: {
        sessionId,
        turnId,
        providerSessionId: runtime.piSessionId,
        ...(developerInstructions !== undefined ? { developerInstructions } : {})
      }
    };
  }

  private async steerTurn(payload: PiRuntimeRequest): Promise<PiRuntimeResponse> {
    const sessionId = asString(payload.params.sessionId);
    if (!sessionId) {
      return {
        id: payload.id,
        ok: false,
        error: { code: "pi_command_invalid", message: "sessionId is required." }
      };
    }
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.process?.running || !runtime.streaming) {
      return this.sendUserMessage(payload);
    }
    const images = await this.buildImages(payload.params.attachments);
    await this.syncRoleInstructions(runtime, payload.params);
    await this.writePendingTurn(runtime, {
      messageId: asString(payload.params.messageId) ?? "",
      steer: true
    });
    const response = await this.sendCommand(runtime, payload.id, {
      type: "steer",
      message: asString(payload.params.content) ?? "",
      ...(images.length > 0 ? { images } : {})
    });
    if (response.success !== true) {
      return {
        id: payload.id,
        ok: false,
        error: {
          code: "pi_steer_rejected",
          message: String(response.error ?? "pi rejected the steering message.")
        }
      };
    }
    return {
      id: payload.id,
      ok: true,
      result: {
        sessionId,
        turnId: runtime.currentTurnId ?? asString(payload.params.turnId) ?? "",
        delivery: "steered"
      }
    };
  }

  private async interruptTurn(payload: PiRuntimeRequest): Promise<PiRuntimeResponse> {
    const sessionId = asString(payload.params.sessionId);
    const runtime = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!runtime?.process?.running) {
      return { id: payload.id, ok: true, result: {} };
    }
    const response = await this.sendCommand(runtime, payload.id, { type: "abort" });
    return response.success === true
      ? { id: payload.id, ok: true, result: {} }
      : {
          id: payload.id,
          ok: false,
          error: {
            code: "pi_abort_rejected",
            message: String(response.error ?? "pi rejected the abort.")
          }
        };
  }

  private async ensureRuntime(
    sessionId: string,
    params: Record<string, unknown>
  ): Promise<PiSessionRuntime> {
    const existing = this.sessions.get(sessionId);
    if (existing?.process?.running) {
      return existing;
    }
    if (existing) {
      this.teardownRuntime(existing);
      await existing.process?.stop();
      this.sessions.delete(sessionId);
    }
    const sessionDir = this.options.resolveSessionDirectory(sessionId);
    const sessionsDir = join(sessionDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const piSessionId =
      asString(params.providerSessionId) ?? this.options.resolvePiSessionId(sessionId);
    const cwd = await this.resolveCwd(sessionId, params);
    const extensionPath = this.options.resolveExtensionPath();
    if (!extensionPath) {
      throw new RuntimePortError({
        code: "runtime_start_failed",
        message:
          "The Vermillion pi extension is missing, so pi sessions cannot receive role instructions or host tools."
      });
    }
    const command = await this.options.resolveCommand();
    const spawnCommand = resolveEngineSpawnCommand(command.commandPath, [
      ...command.commandArgs,
      "--mode",
      "rpc",
      "--session-dir",
      sessionsDir,
      "--session-id",
      piSessionId,
      "-e",
      extensionPath
    ]);
    const hostBridge = await this.ensureHostBridge();
    const process = spawnPiJsonlProcess({
      command: spawnCommand.command,
      args: spawnCommand.args,
      cwd,
      env: {
        ...globalThis.process.env,
        VERMILLION_PI_SESSION_DIR: sessionDir,
        VERMILLION_PI_SESSION_ID: piSessionId,
        VERMILLION_SESSION_ID: sessionId,
        ...(hostBridge
          ? {
              VERMILLION_PI_HOST_URL: hostBridge.url,
              VERMILLION_PI_HOST_TOKEN: hostBridge.token
            }
          : {})
      }
    });
    const runtime: PiSessionRuntime = {
      sessionId,
      piSessionId,
      sessionDir,
      cwd,
      process,
      teardown: [],
      pending: new Map(),
      streaming: false,
      assistantCount: 0,
      toolText: new Map()
    };
    runtime.teardown.push(
      process.subscribe((message) => this.handleMessage(runtime, message))
    );
    runtime.teardown.push(
      process.subscribeExit((code) => this.handleExit(runtime, code))
    );
    this.sessions.set(sessionId, runtime);
    this.emit("session.created", {
      conversationId: asString(params.conversationId) ?? sessionId,
      sessionId,
      engineId: this.engineId,
      status: "idle"
    });
    return runtime;
  }

  private async resolveCwd(
    sessionId: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const explicit = asString(params.cwd);
    if (explicit) {
      return explicit;
    }
    return this.options.resolveSessionCwd(sessionId);
  }

  private readExecution(params: Record<string, unknown>): TurnExecution | undefined {
    const execution = params.execution;
    if (!isRecord(execution)) {
      return undefined;
    }
    return {
      ...(asString(execution.modelId) ? { modelId: asString(execution.modelId) } : {}),
      ...(asString(execution.reasoningOptionId)
        ? { reasoningOptionId: asString(execution.reasoningOptionId) }
        : {}),
      ...(execution.serviceTierId !== undefined
        ? { serviceTierId: execution.serviceTierId as string | null }
        : {})
    };
  }

  /** 模型与推理档位按引擎无关的标识传入，这里解析成唯一的 pi provider/id 与档位。 */
  private async applyExecution(
    runtime: PiSessionRuntime,
    execution: TurnExecution | undefined
  ): Promise<void> {
    const modelId = execution?.modelId;
    if (modelId) {
      const choice = await this.catalog.resolveModel(
        modelId,
        runtime.appliedModel?.provider
      );
      if (!choice) {
        throw new Error(
          `pi has no available model named ${modelId}. Add it to ~/.pi/agent/models.json.`
        );
      }
      if (
        !runtime.appliedModel ||
        runtime.appliedModel.provider !== choice.provider ||
        runtime.appliedModel.modelId !== choice.modelId
      ) {
        const response = await this.sendCommand(runtime, createId("model"), {
          type: "set_model",
          provider: choice.provider,
          modelId: choice.modelId
        });
        if (response.success !== true) {
          throw new Error(
            String(response.error ?? `pi rejected model ${modelId}.`)
          );
        }
        runtime.appliedModel = { provider: choice.provider, modelId: choice.modelId };
      }
      const reasoning = execution?.reasoningOptionId;
      if (reasoning && choice.reasoningOptionIds.length > 0) {
        if (!choice.reasoningOptionIds.includes(reasoning)) {
          throw new Error(
            `pi model ${modelId} does not support reasoning level ${reasoning}.`
          );
        }
        if (runtime.appliedThinking !== reasoning) {
          const response = await this.sendCommand(runtime, createId("thinking"), {
            type: "set_thinking_level",
            level: reasoning
          });
          if (response.success !== true) {
            throw new Error(
              String(response.error ?? `pi rejected reasoning level ${reasoning}.`)
            );
          }
          runtime.appliedThinking = reasoning;
        }
      }
    }
    if (execution?.serviceTierId) {
      this.options.writeDiagnostic?.({
        kind: "runtime-pipeline",
        severity: "info",
        source: "pi-runtime-port",
        message: "pi does not support service tiers; the requested tier was not applied.",
        sessionId: runtime.sessionId,
        context: { serviceTierId: execution.serviceTierId }
      });
    }
  }

  /** 角色指令写在会话目录里，由随包扩展在每轮开始时读入系统提示。 */
  private async syncRoleInstructions(
    runtime: PiSessionRuntime,
    params: Record<string, unknown>
  ): Promise<string | undefined> {
    const developerInstructions = asString(params.developerInstructions);
    if (developerInstructions === undefined) {
      return undefined;
    }
    const delivered = asString(params.deliveredDeveloperInstructions);
    if (delivered === developerInstructions) {
      const existing = await readFile(this.roleInstructionsPath(runtime), "utf8").catch(
        () => undefined
      );
      if (existing === developerInstructions) {
        return developerInstructions;
      }
    }
    await mkdir(runtime.sessionDir, { recursive: true });
    await writeFile(
      this.roleInstructionsPath(runtime),
      developerInstructions,
      "utf8"
    );
    return developerInstructions;
  }

  private roleInstructionsPath(runtime: PiSessionRuntime): string {
    return join(runtime.sessionDir, "role-instructions.md");
  }

  private pendingTurnPath(runtime: PiSessionRuntime): string {
    return join(runtime.sessionDir, "pending-turn.json");
  }

  private async writePendingTurn(
    runtime: PiSessionRuntime,
    input: { messageId: string; steer: boolean }
  ): Promise<void> {
    await mkdir(runtime.sessionDir, { recursive: true });
    await writeFile(
      this.pendingTurnPath(runtime),
      `${JSON.stringify({ ...input, at: this.now() })}\n`,
      "utf8"
    );
  }

  private async buildImages(
    value: unknown
  ): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
    if (!Array.isArray(value)) {
      return [];
    }
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const attachment of value as Attachment[]) {
      if (!isImageAttachment(attachment)) {
        continue;
      }
      const dataUri = dataUriPattern.exec(attachment.uri);
      if (dataUri?.[2] && dataUri[3] !== undefined) {
        images.push({
          type: "image",
          data: dataUri[3],
          mimeType: dataUri[1]?.trim() || attachment.mimeType || "image/png"
        });
        continue;
      }
      const path = fileUriToPath(attachment.uri);
      if (!path) {
        continue;
      }
      const bytes = await readFile(path).catch(() => undefined);
      if (!bytes) {
        continue;
      }
      images.push({
        type: "image",
        data: base64Of(bytes),
        mimeType: attachment.mimeType || "image/png"
      });
    }
    return images;
  }

  private armTurn(runtime: PiSessionRuntime): Promise<string> {
    this.disarmTurn(runtime);
    runtime.currentTurnId = undefined;
    runtime.assistantCount = 0;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.awaitingTurn = undefined;
        reject(
          new RuntimePortError({
            code: "runtime_request_timeout",
            message:
              "pi did not start a Vermillion turn; the pi extension may not be loaded."
          })
        );
      }, turnStartTimeoutMs);
      timer.unref?.();
      runtime.awaitingTurn = { resolve, timer };
    });
  }

  private disarmTurn(runtime: PiSessionRuntime): void {
    if (runtime.awaitingTurn) {
      clearTimeout(runtime.awaitingTurn.timer);
      runtime.awaitingTurn = undefined;
    }
  }

  private sendCommand(
    runtime: PiSessionRuntime,
    id: string,
    command: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const process = runtime.process;
    if (!process) {
      return Promise.reject(new Error("The pi process is not running."));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(id);
        reject(
          new RuntimePortError({
            code: "runtime_request_timeout",
            message: `pi did not answer ${String(command.type)} in time.`
          })
        );
      }, commandTimeoutMs);
      timer.unref?.();
      runtime.pending.set(id, { resolve, timer });
      try {
        process.send({ id, ...command });
      } catch (error) {
        clearTimeout(timer);
        runtime.pending.delete(id);
        reject(error);
      }
    });
  }

  private handleExit(runtime: PiSessionRuntime, code: number | null): void {
    for (const [, pending] of runtime.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ type: "response", success: false, error: `pi exited (${code})` });
    }
    runtime.pending.clear();
    const wasStreaming = runtime.streaming;
    runtime.streaming = false;
    this.disarmTurn(runtime);
    if (wasStreaming && runtime.currentTurnId) {
      this.emit("turn.completed", {
        sessionId: runtime.sessionId,
        turnId: runtime.currentTurnId,
        finishReason: "failed"
      });
    }
    if (code !== 0) {
      const stderr = runtime.process?.stderrText() ?? "";
      this.emit("runtime.error", {
        sessionId: runtime.sessionId,
        code: "pi_process_exited",
        message: `pi exited ${code === null ? "before starting" : `with code ${code}`}.${stderr ? ` ${stderr}` : ""}`,
        recoverable: true
      });
    }
  }

  private teardownRuntime(runtime: PiSessionRuntime): void {
    for (const teardown of runtime.teardown) {
      teardown();
    }
    runtime.teardown = [];
  }

  private ensureHostBridge(): Promise<PiHostBridgeHandle | undefined> {
    if (this.bridge) {
      return Promise.resolve(this.bridge);
    }
    if (!this.options.startHostBridge) {
      return Promise.resolve(undefined);
    }
    this.bridgePromise ??= this.options
      .startHostBridge()
      .then((bridge) => {
        this.bridge = bridge;
        return bridge;
      })
      .catch((error) => {
        this.options.writeDiagnostic?.({
          kind: "runtime-pipeline",
          severity: "warning",
          source: "pi-runtime-port",
          message: `Could not start the Vermillion host tool endpoint: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
        return undefined;
      });
    return this.bridgePromise;
  }

  private handleMessage(
    runtime: PiSessionRuntime,
    message: Record<string, unknown>
  ): void {
    const type = asString(message.type);
    if (!type) {
      return;
    }
    if (type === "response") {
      const id = asString(message.id);
      const pending = id ? runtime.pending.get(id) : undefined;
      if (id && pending) {
        clearTimeout(pending.timer);
        runtime.pending.delete(id);
        pending.resolve(message);
      }
      return;
    }
    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(runtime, message);
      return;
    }
    switch (type) {
      case "entry_appended": {
        const entry = isRecord(message.entry) ? message.entry : undefined;
        if (!entry || entry.customType !== piTurnEntryType) {
          return;
        }
        const entryId = asString(entry.id);
        if (!entryId) {
          return;
        }
        this.beginTurn(runtime, entryId, entry);
        return;
      }
      case "agent_start":
        runtime.streaming = true;
        return;
      case "message_start":
      case "message_update":
      case "message_end":
        this.handleMessageEvent(runtime, type, message);
        return;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.handleToolEvent(runtime, type, message);
        return;
      case "agent_settled":
      case "agent_end":
        this.handleRunSettled(runtime, type);
        return;
      case "extension_error":
        this.emit("runtime.error", {
          sessionId: runtime.sessionId,
          code: "pi_extension_error",
          message: `pi extension error: ${summarize(message.error) ?? "unknown"}`,
          recoverable: true
        });
        return;
      default:
        return;
    }
  }

  private handleExtensionUiRequest(
    runtime: PiSessionRuntime,
    message: Record<string, unknown>
  ): void {
    const id = asString(message.id);
    const method = asString(message.method);
    if (!id || !method || !runtime.process?.running) {
      return;
    }
    const fireAndForget = new Set([
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text"
    ]);
    if (fireAndForget.has(method)) {
      return;
    }
    // 无人值守时拒绝需要用户确认的对话框，只把事实写进诊断。
    this.options.writeDiagnostic?.({
      kind: "runtime-pipeline",
      severity: "warning",
      source: "pi-runtime-port",
      message: `pi extension asked for ${method}; unattended sessions answer with the declining default.`,
      sessionId: runtime.sessionId,
      context: { method, title: message.title }
    });
    if (method === "confirm") {
      runtime.process.send({
        type: "extension_ui_response",
        id,
        confirmed: false
      });
      return;
    }
    runtime.process.send({ type: "extension_ui_response", id, cancelled: true });
  }

  private beginTurn(
    runtime: PiSessionRuntime,
    turnId: string,
    entry: Record<string, unknown>
  ): void {
    runtime.currentTurnId = turnId;
    runtime.assistantCount = 0;
    runtime.lastStopReason = undefined;
    this.emit("turn.started", {
      sessionId: runtime.sessionId,
      turnId,
      ...(runtime.execution && (runtime.execution.modelId || runtime.execution.reasoningOptionId)
        ? {
            executionProfile: {
              ...(runtime.execution.modelId ? { modelId: runtime.execution.modelId } : {}),
              ...(runtime.execution.reasoningOptionId
                ? { reasoningOptionId: runtime.execution.reasoningOptionId }
                : {}),
              ...(runtime.execution.serviceTierId !== undefined
                ? { serviceTierId: runtime.execution.serviceTierId }
                : {})
            }
          }
        : {})
    });
    void entry;
    if (runtime.awaitingTurn) {
      const awaiting = runtime.awaitingTurn;
      runtime.awaitingTurn = undefined;
      clearTimeout(awaiting.timer);
      awaiting.resolve(turnId);
    }
  }

  private handleMessageEvent(
    runtime: PiSessionRuntime,
    type: string,
    message: Record<string, unknown>
  ): void {
    // `message_update` 只带增量块，没有 message 字段；其余两种事件带完整消息。
    if (type === "message_update") {
      const turnId = runtime.currentTurnId;
      const event = isRecord(message.assistantMessageEvent)
        ? message.assistantMessageEvent
        : undefined;
      const delta = event?.type === "text_delta" ? asString(event.delta) : undefined;
      if (!turnId || !delta) {
        return;
      }
      this.emit("message.delta", {
        sessionId: runtime.sessionId,
        turnId,
        messageId: sessionItemId(
          runtime.sessionId,
          `${turnId}:a${Math.max(runtime.assistantCount - 1, 0)}`
        ),
        delta,
        engineId: this.engineId
      });
      return;
    }
    const payload = isRecord(message.message) ? message.message : undefined;
    const role = payload ? asString(payload.role) : undefined;
    if (role !== "assistant") {
      return;
    }
    const turnId = runtime.currentTurnId;
    if (!turnId) {
      return;
    }
    if (type === "message_start") {
      const messageId = sessionItemId(
        runtime.sessionId,
        `${turnId}:a${runtime.assistantCount}`
      );
      runtime.assistantCount += 1;
      this.emit("message.started", {
        sessionId: runtime.sessionId,
        turnId,
        messageId,
        role: "assistant",
        engineId: this.engineId
      });
      return;
    }
    if (type === "message_end") {
      if (payload?.stopReason) {
        runtime.lastStopReason = asString(payload.stopReason);
      }
      const text = payload ? messageText(payload) : "";
      this.emit("message.completed", {
        sessionId: runtime.sessionId,
        turnId,
        messageId: sessionItemId(
          runtime.sessionId,
          `${turnId}:a${Math.max(runtime.assistantCount - 1, 0)}`
        ),
        role: "assistant",
        finalText: text,
        engineId: this.engineId
      });
      if (runtime.lastStopReason === "error") {
        this.emit("runtime.error", {
          sessionId: runtime.sessionId,
          turnId,
          code: "pi_turn_error",
          message: summarize(payload?.errorMessage) ?? "pi reported a failed turn.",
          recoverable: true
        });
      }
    }
  }

  private handleToolEvent(
    runtime: PiSessionRuntime,
    type: string,
    message: Record<string, unknown>
  ): void {
    const rawToolCallId = asString(message.toolCallId);
    const turnId = runtime.currentTurnId;
    if (!rawToolCallId || !turnId) {
      return;
    }
    const toolCallId = sessionItemId(runtime.sessionId, rawToolCallId);
    const toolName = asString(message.toolName) ?? "tool";
    const isTerminal = toolName === "bash";
    if (type === "tool_execution_start") {
      this.emit("tool.started", {
        sessionId: runtime.sessionId,
        turnId,
        toolCallId,
        toolName,
        inputSummary: summarize(message.args),
        engineId: this.engineId
      });
      if (isTerminal) {
        this.emit("terminal.started", {
          sessionId: runtime.sessionId,
          turnId,
          terminalId: toolCallId,
          toolCallId,
          engineId: this.engineId
        });
      }
      return;
    }
    if (type === "tool_execution_update") {
      const text = toolResultText(message);
      const previous = runtime.toolText.get(rawToolCallId) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      runtime.toolText.set(rawToolCallId, text);
      if (delta) {
        this.emit("tool.delta", {
          sessionId: runtime.sessionId,
          turnId,
          toolCallId,
          delta,
          engineId: this.engineId
        });
        if (isTerminal) {
          this.emit("terminal.output", {
            sessionId: runtime.sessionId,
            turnId,
            terminalId: toolCallId,
            chunk: delta,
            engineId: this.engineId
          });
        }
      }
      return;
    }
    const isError = message.isError === true;
    const text = toolResultText(message);
    this.emit("tool.completed", {
      sessionId: runtime.sessionId,
      turnId,
      toolCallId,
      status: isError ? "failed" : "completed",
      outputSummary: summarize(text),
      engineId: this.engineId
    });
    if (isTerminal) {
      this.emit("terminal.completed", {
        sessionId: runtime.sessionId,
        turnId,
        terminalId: toolCallId,
        ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}),
        engineId: this.engineId
      });
    }
    runtime.toolText.delete(rawToolCallId);
  }

  private handleRunSettled(runtime: PiSessionRuntime, type: string): void {
    if (type === "agent_end") {
      return;
    }
    const turnId = runtime.currentTurnId;
    runtime.streaming = false;
    if (!turnId) {
      return;
    }
    const finishReason =
      runtime.lastStopReason === "error"
        ? "failed"
        : runtime.lastStopReason === "aborted" || runtime.lastStopReason === "interrupted"
          ? "interrupted"
          : "completed";
    this.emit("turn.completed", {
      sessionId: runtime.sessionId,
      turnId,
      finishReason,
      ...(runtime.execution && (runtime.execution.modelId || runtime.execution.reasoningOptionId)
        ? {
            executionProfile: {
              ...(runtime.execution.modelId ? { modelId: runtime.execution.modelId } : {}),
              ...(runtime.execution.reasoningOptionId
                ? { reasoningOptionId: runtime.execution.reasoningOptionId }
                : {}),
              ...(runtime.execution.serviceTierId !== undefined
                ? { serviceTierId: runtime.execution.serviceTierId }
                : {})
            }
          }
        : {})
    });
    runtime.currentTurnId = undefined;
  }

  private emit(
    method: PiRuntimeEventMethod,
    params: Record<string, unknown>
  ): void {
    this.sequence += 1;
    const event: PiRuntimeEvent = {
      method,
      params,
      eventId: `pi-runtime-${this.sequence}`,
      occurredAt: this.now()
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export type PiModelCatalogChoiceList = Awaited<
  ReturnType<PiModelCatalog["list"]>
>;

const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
