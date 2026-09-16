import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SESSION_TITLE_MODEL_ID } from "@vermillion/shared";
import type {
  EngineDefinitionRpc,
  EngineModelCatalogRpc,
  SessionSettingsRpc,
  SessionSettingsUpdateRpc
} from "@vermillion/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { resolveComposerModels } from "../../chat-shell/use-composer-controller.js";
import { Button, Field, InlineNotice } from "./ui.js";

type SettingsPageProps = {
  transport: DesktopTransport;
};

export const SettingsPage = ({ transport }: SettingsPageProps) => {
  const [settings, setSettings] = useState<SessionSettingsRpc | undefined>(undefined);
  const [engines, setEngines] = useState<EngineDefinitionRpc[]>([]);
  const [modelCatalog, setModelCatalog] = useState<EngineModelCatalogRpc | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [modelCatalogError, setModelCatalogError] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    const [nextSettings, nextEngines] = await Promise.all([
      transport.settings.get(),
      transport.engine.list()
    ]);
    setSettings(nextSettings);
    setEngines(nextEngines);
  }, [transport]);

  useEffect(() => {
    let disposed = false;
    void reload().catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
    };
  }, [reload]);

  // 标题模型的可选值与输入器一致，取当前新会话引擎的模型目录。
  const titleEngineId =
    settings?.defaultNewSessionEngineId ?? engines[0]?.engineId ?? "";
  useEffect(() => {
    if (!titleEngineId) {
      setModelCatalog(undefined);
      return;
    }
    let disposed = false;
    void transport.engine
      .listModels(titleEngineId)
      .then((catalog) => {
        if (disposed) return;
        setModelCatalog(catalog);
        setModelCatalogError(undefined);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setModelCatalog(undefined);
        setModelCatalogError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [transport, titleEngineId]);

  const titleModels = resolveComposerModels({
    catalog: modelCatalog,
    allowedModelIds: settings?.allowedModelIdsByEngineId?.[titleEngineId],
    customModelReasoningOptionIds:
      settings?.customModelReasoningOptionIdsByEngineId?.[titleEngineId]
  });
  const titleGenerationModelId = settings?.titleGenerationModelId;

  const save = useCallback(
    async (input: SessionSettingsUpdateRpc) => {
      setError(undefined);
      try {
        const updated = await transport.settings.update(input);
        setSettings(updated);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [transport]
  );

  const pickProgramPath = useCallback(
    async (engineId: string) => {
      const picked = await window.sessionDesktop?.pickEngineProgramPath(engineId);
      if (!picked || picked.canceled || !picked.path) {
        return;
      }
      await save({
        engineProgramPathsByEngineId: {
          ...(settings?.engineProgramPathsByEngineId ?? {}),
          [engineId]: picked.path
        }
      });
    },
    [save, settings]
  );

  const clearProgramPath = useCallback(
    async (engineId: string) => {
      const next = { ...(settings?.engineProgramPathsByEngineId ?? {}) };
      delete next[engineId];
      await save({ engineProgramPathsByEngineId: next });
    },
    [save, settings]
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <Field
        kind="select"
        label="新会话引擎"
        className="max-w-md"
        value={settings?.defaultNewSessionEngineId ?? engines[0]?.engineId ?? ""}
        disabled={!settings}
        hint="之后新建的会话使用该引擎；已有会话树保持创建时的引擎。"
        onChange={(event) => {
          if (event.target.value) void save({ defaultNewSessionEngineId: event.target.value });
        }}
      >
        {engines.map((engine) => (
          <option key={engine.engineId} value={engine.engineId}>
            {engine.displayName}
          </option>
        ))}
      </Field>
      <Field
        kind="select"
        label="标题模型"
        className="max-w-md"
        value={titleGenerationModelId ?? ""}
        disabled={!settings}
        hint="会话首条消息用它生成标题；选项来自新会话引擎，留空用内置默认模型。"
        onChange={(event) =>
          void save({ titleGenerationModelId: event.target.value || null })
        }
      >
        <option value="">{`默认（${DEFAULT_SESSION_TITLE_MODEL_ID}）`}</option>
        {titleGenerationModelId &&
          !titleModels.some((model) => model.modelId === titleGenerationModelId) && (
            <option value={titleGenerationModelId}>{`${titleGenerationModelId}（不在模型列表中）`}</option>
          )}
        {titleModels.map((model) => (
          <option key={model.modelId} value={model.modelId}>
            {model.displayName}
          </option>
        ))}
      </Field>
      {modelCatalogError && (
        <InlineNotice tone="error">{`模型选项加载失败：${modelCatalogError}`}</InlineNotice>
      )}
      <div className="flex max-w-2xl flex-col gap-3">
        {engines.map((engine) => {
          const resolution = settings?.engineProgramResolutionsByEngineId?.[engine.engineId];
          const customPath = settings?.engineProgramPathsByEngineId[engine.engineId];
          const programPath = resolution
            ? (resolution.found && resolution.resolvedPath) || resolution.path
            : "";
          return (
            <div key={engine.engineId} className="flex flex-col gap-2">
              <span className="eyebrow">{`${engine.displayName} 程序路径`}</span>
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-body text-foreground"
                  title={programPath}
                >
                  {programPath}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  outlined
                  disabled={!settings}
                  onClick={() => void pickProgramPath(engine.engineId)}
                >
                  选择
                </Button>
                {customPath && (
                  <Button
                    variant="ghost"
                    size="sm"
                    outlined
                    onClick={() => void clearProgramPath(engine.engineId)}
                  >
                    恢复默认
                  </Button>
                )}
              </div>
              {resolution && !resolution.found && (
                <InlineNotice tone="error" className="px-0 pb-0">
                  {`未找到 ${resolution.path}，新建会话时该引擎无法启动。`}
                </InlineNotice>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
