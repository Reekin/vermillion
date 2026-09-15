import { useCallback, useEffect, useState } from "react";
import type { EngineDefinitionRpc, SessionSettingsRpc } from "@vermillion/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
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
  const [error, setError] = useState<string | undefined>(undefined);
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

  const save = useCallback(
    async (input: {
      defaultNewSessionEngineId?: string;
      engineProgramPathsByEngineId?: Record<string, string>;
    }) => {
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
        value={settings?.defaultNewSessionEngineId ?? ""}
        disabled={!settings}
        hint="之后新建的会话使用该引擎；已有会话树保持创建时的引擎。"
        onChange={(event) => {
          if (event.target.value) void save({ defaultNewSessionEngineId: event.target.value });
        }}
      >
        <option value="">按注册顺序的第一个引擎</option>
        {engines.map((engine) => (
          <option key={engine.engineId} value={engine.engineId}>
            {engine.displayName}
          </option>
        ))}
      </Field>
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
            </div>
          );
        })}
      </div>
    </div>
  );
};
