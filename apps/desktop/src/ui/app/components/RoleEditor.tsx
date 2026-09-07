import { useEffect, useState } from "react";
import type { EngineModelRpc } from "@vermillion/shared";
import type { RoleDocument, WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { resolveComposerExecutionSelection, resolveComposerModels } from "../../chat-shell/use-composer-controller.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice } from "./ui.js";

const inheritLabel = "沿用输入器配置";
const defaultValue = "__default__";
const selectionValue = (value: string | null | undefined) => value === null ? defaultValue : value ?? "";
const settingValue = (value: string) => value === defaultValue ? null : value || undefined;

export const RoleEditor = ({ store, transport }: { store: WorkbenchStore; transport: DesktopTransport }) => {
  const client = store((s) => s.client);
  const workspaceId = store((s) => s.browsingWorkspaceId);
  const target = store((s) => s.editor);
  const openEditor = store((s) => s.openEditor);
  if (!workspaceId || target?.kind !== "role") return null;
  return <RoleEditorForm key={workspaceId + "/" + target.roleId} client={client} transport={transport} workspaceId={workspaceId} roleId={target.roleId} onClose={() => openEditor(undefined)} />;
};

const RoleEditorForm = ({ client, transport, workspaceId, roleId, onClose }: {
  client: WorkbenchClient;
  transport: DesktopTransport;
  workspaceId: string;
  roleId: string;
  onClose: () => void;
}) => {
  const [document, setDocument] = useState<RoleDocument>();
  const [models, setModels] = useState<EngineModelRpc[]>([]);
  const [inheritedModelId, setInheritedModelId] = useState<string>();
  const [catalogError, setCatalogError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      const [settings, engines] = await Promise.all([transport.settings.get(), transport.engine.list()]);
      const engineId = settings.defaultNewSessionEngineId ?? engines[0]?.engineId;
      if (!engineId) return { models: [] };
      const catalog = await transport.engine.listModels(engineId);
      const models = resolveComposerModels({
        catalog,
        allowedModelIds: settings.allowedModelIdsByEngineId?.[engineId],
        customModelReasoningOptionIds: settings.customModelReasoningOptionIdsByEngineId?.[engineId]
      });
      const execution = resolveComposerExecutionSelection({
        models,
        currentModelId: settings.executionPreferencesByEngineId?.[engineId]?.selectedModelId
      });
      return { models, inheritedModelId: execution?.modelId };
    };
    void client.request("role.editor.read", { workspaceId, roleId })
      .then((role) => {
        if (cancelled) return;
        setDocument({ ...role.document, mode: role.source === "global" ? "override" : role.document.mode });
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    void loadModels()
      .then((options) => {
        if (cancelled) return;
        setModels(options.models);
        setInheritedModelId(options.inheritedModelId);
      })
      .catch((cause) => { if (!cancelled) setCatalogError("模型选项加载失败：" + (cause instanceof Error ? cause.message : String(cause))); });
    return () => { cancelled = true; };
  }, [client, transport, workspaceId, roleId]);

  const update = (changes: Partial<RoleDocument>) => {
    setDocument((current) => current && { ...current, ...changes });
    setDirty(true);
  };
  const save = async () => {
    if (!document || !dirty || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.request("role.editor.write", { workspaceId, roleId, document });
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const selectedModel = models.find((model) => model.modelId === (document?.model ?? inheritedModelId));
  const reasoningOptions = selectedModel?.reasoningOptions ?? [];
  const serviceTiers = selectedModel?.serviceTiers ?? [];
  const defaultReasoning = reasoningOptions.find((option) => option.optionId === selectedModel?.defaultReasoningOptionId)?.displayName;

  return (
    <Modal title={"角色 · " + roleId} onClose={onClose} width={860} height="78vh">
      <div className="flex h-full flex-col" onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save(); }
      }}>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {document ? (
            <div className="space-y-4">
              <Field kind="select" label="本 workspace 覆盖方式" value={document.mode} disabled={saving} onChange={(event) => update({ mode: event.target.value as RoleDocument["mode"] })}>
                <option value="override">override</option>
                <option value="append">append</option>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field kind="select" label="模型" value={document.model ?? ""} disabled={saving} onChange={(event) => update({ model: event.target.value || undefined })}>
                  <option value="">{inheritLabel}</option>
                  {document.model && !models.some((model) => model.modelId === document.model) && <option value={document.model}>{document.model}（当前文件）</option>}
                  {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}
                </Field>
                <Field kind="select" label="推理档位" value={selectionValue(document.reasoningOptionId)} disabled={saving} onChange={(event) => update({ reasoningOptionId: settingValue(event.target.value) })}>
                  <option value="">{inheritLabel}</option>
                  <option value={defaultValue}>{defaultReasoning ? `Default (${defaultReasoning})` : "Default"}</option>
                  {document.reasoningOptionId && !reasoningOptions.some((option) => option.optionId === document.reasoningOptionId) && <option value={document.reasoningOptionId}>{document.reasoningOptionId}（当前文件）</option>}
                  {reasoningOptions.map((option) => <option key={option.optionId} value={option.optionId}>{option.displayName}</option>)}
                </Field>
                <Field kind="select" label="速度" value={selectionValue(document.serviceTierId)} disabled={saving} onChange={(event) => update({ serviceTierId: settingValue(event.target.value) })}>
                  <option value="">{inheritLabel}</option>
                  <option value={defaultValue}>Standard</option>
                  {document.serviceTierId && !serviceTiers.some((tier) => tier.tierId === document.serviceTierId) && <option value={document.serviceTierId}>{document.serviceTierId}（当前文件）</option>}
                  {serviceTiers.map((tier) => <option key={tier.tierId} value={tier.tierId} title={tier.description}>{tier.displayName}</option>)}
                </Field>
              </div>
              {catalogError && <InlineNotice tone="error">{catalogError}</InlineNotice>}
              <Field kind="textarea" label="Prompt 正文" rows={14} value={document.body} disabled={saving} onChange={(event) => update({ body: event.target.value })} />
            </div>
          ) : !error && <InlineNotice>加载中…</InlineNotice>}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
        </div>
        <footer className="flex h-10 shrink-0 items-center gap-3 border-t border-border px-4">
          <span className="text-caption text-muted-foreground">保存到本 workspace · {dirty ? "未保存 · Ctrl+S" : "已保存"}</span>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!document || !dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
        </footer>
      </div>
    </Modal>
  );
};
