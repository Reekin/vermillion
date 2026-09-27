import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SESSION_TITLE_MODEL_ID } from "@vermillion/shared";
import type {
  EngineDefinitionRpc,
  EngineModelCatalogRpc,
  SessionSettingsRpc,
  SessionSettingsUpdateRpc
} from "@vermillion/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { RendererStore } from "../../../store/store.js";
import { useEngineConfigWarningsSignal } from "../use-engine-config-warnings-signal.js";
import { useSettingsSignal } from "../use-locale-sync.js";
import { resolveComposerModels } from "../../chat-shell/use-composer-controller.js";
import { Alert, Button, CollapsibleDetails, Field, InlineNotice, Select } from "./ui.js";
import { engineWarningDetails, engineWarningReason } from "../output-log.js";
import { setLocale, type Locale } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";

type SettingsPageProps = {
  transport: DesktopTransport;
  sessionStore: RendererStore;
};

export const SettingsPage = ({ transport, sessionStore }: SettingsPageProps) => {
  const t = useT();
  const configWarningsSignal = useEngineConfigWarningsSignal(sessionStore);
  const settingsSignal = useSettingsSignal(sessionStore);
  const [settings, setSettings] = useState<SessionSettingsRpc | undefined>(undefined);
  const [engines, setEngines] = useState<EngineDefinitionRpc[]>([]);
  const [modelCatalog, setModelCatalog] = useState<EngineModelCatalogRpc | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [modelCatalogError, setModelCatalogError] = useState<string | undefined>(undefined);
  const [openWarning, setOpenWarning] = useState<string | undefined>(undefined);

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

  useEffect(() => {
    if (!configWarningsSignal && !settingsSignal) return;
    void transport.settings.get().then(setSettings, () => undefined);
  }, [configWarningsSignal, settingsSignal, transport]);

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
        setLocale(updated.locale);
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
      <Select
        label={t("app.settingsPage.language")}
        className="max-w-md"
        value={settings?.locale ?? ""}
        disabled={!settings}
        onChange={(value) => { if (value) void save({ locale: value as Locale }); }}
        options={[{ value: "zh", label: t("app.settingsPage.languageZh") }, { value: "en", label: t("app.settingsPage.languageEn") }]}
      />
      <Select
        label={t("app.settingsPage.engine")}
        className="max-w-md"
        value={settings?.defaultNewSessionEngineId ?? engines[0]?.engineId ?? ""}
        disabled={!settings}
        hint={t("app.settingsPage.engineHint")}
        onChange={(value) => { if (value) void save({ defaultNewSessionEngineId: value }); }}
        options={engines.map((engine) => ({ value: engine.engineId, label: engine.displayName }))}
      />
      <Select
        label={t("app.settingsPage.titleModel")}
        className="max-w-md"
        value={titleGenerationModelId ?? ""}
        disabled={!settings}
        hint={t("app.settingsPage.titleModelHint")}
        onChange={(value) => void save({ titleGenerationModelId: value || null })}
        options={[
          { value: "", label: t("app.settingsPage.titleModelDefault", { model: DEFAULT_SESSION_TITLE_MODEL_ID }) },
          ...(titleGenerationModelId && !titleModels.some((model) => model.modelId === titleGenerationModelId)
            ? [{ value: titleGenerationModelId, label: t("app.settingsPage.titleModelMissing", { model: titleGenerationModelId }) }] : []),
          ...titleModels.map((model) => ({ value: model.modelId, label: model.displayName }))
        ]}
      />
      {modelCatalogError && (
        <InlineNotice tone="error">{t("app.settingsPage.modelsFailed", { error: modelCatalogError })}</InlineNotice>
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
              <span className="eyebrow">{t("app.settingsPage.programPath", { engine: engine.displayName })}</span>
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
                  {t("app.settingsPage.choose")}
                </Button>
                {customPath && (
                  <Button
                    variant="ghost"
                    size="sm"
                    outlined
                    onClick={() => void clearProgramPath(engine.engineId)}
                  >
                    {t("app.settingsPage.restoreDefault")}
                  </Button>
                )}
              </div>
              {resolution && !resolution.found && (
                <InlineNotice tone="error" className="px-0 pb-0">
                  {t("app.settingsPage.programMissing", { path: resolution.path })}
                </InlineNotice>
              )}
              {(settings?.engineConfigWarningsByEngineId?.[engine.engineId] ?? []).map((warning, index) => {
                const key = `${engine.engineId}:${index}`;
                const details = engineWarningDetails(warning);
                const reason = engineWarningReason(engine.displayName);
                return (
                  <Alert key={key} title={reason.title} next={reason.next}>
                    {details && (
                      <CollapsibleDetails
                        title={t("app.technicalDetails")}
                        open={openWarning === key}
                        onToggle={() => setOpenWarning((current) => (current === key ? undefined : key))}
                      >
                        {details}
                      </CollapsibleDetails>
                    )}
                  </Alert>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};
