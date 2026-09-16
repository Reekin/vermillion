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
import { Button, Field, InlineNotice, PanelHeader } from "./ui.js";

type SettingsPageProps = {
  transport: DesktopTransport;
};

const programSourceLabel = (source: string): string =>
  source === "custom"
    ? "自定义路径"
    : source === "configured"
      ? "设置中的路径"
      : source === "environment"
        ? "环境变量"
        : "默认命令";

export const SettingsPage = ({ transport }: SettingsPageProps) => {
  const [settings, setSettings] = useState<SessionSettingsRpc | undefined>(undefined);
  const [engines, setEngines] = useState<EngineDefinitionRpc[]>([]);
  const [modelCatalog, setModelCatalog] = useState<EngineModelCatalogRpc | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [modelCatalogError, setModelCatalogError] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const [nextSettings, nextEngines] = await Promise.all([
      transport.settings.get(),
      transport.engine.list()
    ]);
    setSettings(nextSettings);
    setEngines(nextEngines);
    setDrafts({ ...nextSettings.engineProgramPathsByEngineId });
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
        setDrafts({ ...updated.engineProgramPathsByEngineId });
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
      setDrafts((current) => ({ ...current, [engineId]: picked.path as string }));
    },
    []
  );

  const saveProgramPath = useCallback(
    async (engineId: string) => {
      const next = { ...(settings?.engineProgramPathsByEngineId ?? {}) };
      const path = (drafts[engineId] ?? "").trim();
      if (path) {
        next[engineId] = path;
      } else {
        delete next[engineId];
      }
      await save({ engineProgramPathsByEngineId: next });
    },
    [drafts, save, settings]
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <PanelHeader title="设置" align="start" />
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
          return (
            <div key={engine.engineId} className="flex flex-col gap-1">
              <Field
                label={`${engine.displayName} 程序路径`}
                value={drafts[engine.engineId] ?? ""}
                placeholder={resolution?.path ?? engine.engineId}
                hint={
                  resolution
                    ? `当前解析：${resolution.path}（${programSourceLabel(resolution.source)}）`
                    : undefined
                }
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [engine.engineId]: event.target.value
                  }))
                }
              />
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void pickProgramPath(engine.engineId)}
                >
                  选择文件
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    (drafts[engine.engineId] ?? "").trim() ===
                    (settings?.engineProgramPathsByEngineId[engine.engineId] ?? "")
                  }
                  onClick={() => void saveProgramPath(engine.engineId)}
                >
                  保存
                </Button>
              </div>
              {resolution && resolution.found && resolution.resolvedPath && (
                <span className="text-caption text-muted-foreground">
                  {`已找到：${resolution.resolvedPath}`}
                </span>
              )}
              {resolution && !resolution.found && (
                <InlineNotice tone="error">
                  {`未找到 ${resolution.path}（${programSourceLabel(resolution.source)}），新建会话时该引擎无法启动。`}
                </InlineNotice>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
