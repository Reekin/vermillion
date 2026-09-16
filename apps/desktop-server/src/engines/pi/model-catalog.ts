import type {
  EngineModelCatalogRpc,
  EngineModelRpc,
  EngineReasoningOptionRpc,
  DiagnosticsWriteInputRpc
} from "@vermillion/shared";
import { resolveEngineSpawnCommand } from "../../engine-program-resolution.js";
import { spawnPiJsonlProcess } from "./jsonl-process.js";

export type PiModelChoice = {
  provider: string;
  modelId: string;
  displayName: string;
  reasoningOptionIds: string[];
};

type PiRawModel = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
  contextWindow?: unknown;
};

const probeTimeoutMs = 20_000;
const cacheTtlMs = 60_000;

const thinkingOptionsFor = (model: PiRawModel): string[] => {
  const map = model.thinkingLevelMap;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    return Object.entries(map as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([level]) => level);
  }
  return model.reasoning === true
    ? ["low", "medium", "high", "xhigh", "max"]
    : [];
};

const displayNameFor = (level: string): string =>
  level.length === 0 ? level : level[0]!.toUpperCase() + level.slice(1);

/** `get_available_models` 是唯一准确的目录来源，用一次性 rpc 进程查询后短期缓存。 */
export class PiModelCatalog {
  private readonly resolveCommand: () => Promise<{
    commandPath: string;
    commandArgs: string[];
  }>;
  private readonly writeDiagnostic:
    | ((input: DiagnosticsWriteInputRpc) => void)
    | undefined;
  private cached?: { at: number; models: PiRawModel[] };
  private inFlight?: Promise<PiRawModel[]>;

  public constructor(options: {
    resolveCommand: () => Promise<{ commandPath: string; commandArgs: string[] }>;
    writeDiagnostic?: (input: DiagnosticsWriteInputRpc) => void;
  }) {
    this.resolveCommand = options.resolveCommand;
    this.writeDiagnostic = options.writeDiagnostic;
  }

  public async list(engineId: string): Promise<EngineModelCatalogRpc> {
    const models = await this.readModels();
    const seen = new Set<string>();
    const entries: EngineModelRpc[] = [];
    for (const model of models) {
      const modelId = typeof model.id === "string" ? model.id : undefined;
      if (!modelId || seen.has(modelId)) {
        continue;
      }
      seen.add(modelId);
      const reasoningOptions: EngineReasoningOptionRpc[] = thinkingOptionsFor(model).map(
        (optionId) => ({ optionId, displayName: displayNameFor(optionId) })
      );
      entries.push({
        modelId,
        displayName:
          typeof model.name === "string" && model.name.trim() ? model.name : modelId,
        reasoningOptions,
        serviceTiers: [],
        isDefault: entries.length === 0
      });
    }
    return { engineId, models: entries };
  }

  /** 执行配置只给模型名；在可用目录里解析出唯一的 provider/id 与可用推理档位。 */
  public async resolveModel(
    modelId: string,
    preferredProvider?: string
  ): Promise<PiModelChoice | undefined> {
    const models = await this.readModels();
    const matches = models.filter(
      (model) => typeof model.id === "string" && model.id === modelId
    );
    if (matches.length === 0) {
      return undefined;
    }
    const preferred =
      matches.find((model) => model.provider === preferredProvider) ?? matches[0]!;
    const provider = typeof preferred.provider === "string" ? preferred.provider : "";
    if (!provider) {
      return undefined;
    }
    return {
      provider,
      modelId,
      displayName:
        typeof preferred.name === "string" && preferred.name.trim()
          ? preferred.name
          : modelId,
      reasoningOptionIds: thinkingOptionsFor(preferred)
    };
  }

  private async readModels(): Promise<PiRawModel[]> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < cacheTtlMs) {
      return this.cached.models;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probe(): Promise<PiRawModel[]> {
    const command = await this.resolveCommand();
    const spawnCommand = resolveEngineSpawnCommand(
      command.commandPath,
      [...command.commandArgs, "--mode", "rpc", "--no-session", "--no-extensions"]
    );
    const process = spawnPiJsonlProcess({
      command: spawnCommand.command,
      args: spawnCommand.args
    });
    try {
      const response = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("pi did not answer get_available_models in time."));
          }, probeTimeoutMs);
          process.subscribe((message) => {
            if (message.type === "response" && message.command === "get_available_models") {
              clearTimeout(timer);
              resolve(message);
            }
          });
          process.subscribeExit(() => {
            clearTimeout(timer);
            reject(new Error(`pi exited before answering: ${process.stderrText()}`));
          });
          process.send({ id: "vermillion-model-catalog", type: "get_available_models" });
        }
      );
      if (response.success !== true) {
        throw new Error(String(response.error ?? "get_available_models failed"));
      }
      const data = response.data as { models?: unknown } | undefined;
      const models = Array.isArray(data?.models) ? (data!.models as PiRawModel[]) : [];
      this.cached = { at: Date.now(), models };
      return models;
    } catch (error) {
      this.writeDiagnostic?.({
        kind: "runtime-pipeline",
        severity: "warning",
        source: "pi-model-catalog",
        message: error instanceof Error ? error.message : String(error)
      });
      return this.cached?.models ?? [];
    } finally {
      await process.stop();
    }
  }
}
