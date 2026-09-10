import { useEffect, useState } from "react";
import type { EngineModelRpc } from "@vermillion/shared";
import type { RoleDocument, WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { resolveComposerExecutionSelection, resolveComposerModels } from "../../chat-shell/use-composer-controller.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice } from "./ui.js";

const inheritInputLabel = "沿用输入器配置";
const inheritGlobalValue = "__inherit_global__";
const defaultValue = "__default__";
const selectionValue = (value: string | null | undefined) => value === null ? defaultValue : value ?? "";
const appendSelectionValue = (value: string | null | undefined) => value === null ? defaultValue : value ?? inheritGlobalValue;
const settingValue = (value: string) => value === defaultValue ? null : value === inheritGlobalValue ? undefined : value || undefined;

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
  const [globalDocument, setGlobalDocument] = useState<RoleDocument>();
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
        const base = role.globalDocument ?? (role.source === "global" ? { ...role.document, mode: "global" as const } : undefined);
        setGlobalDocument(base);
        setDocument(role.document);
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
  const changeMode = (mode: RoleDocument["mode"]) => {
    setDocument((current) => {
      if (!current || current.mode === mode) return current;
      if (mode === "global") return globalDocument ? { ...globalDocument, mode: "global" } : { ...current, mode };
      if (mode === "append") {
        return current.mode === "global"
          ? { ...current, mode, body: "", model: undefined, reasoningOptionId: undefined, serviceTierId: undefined }
          : { ...current, mode, body: "" };
      }
      if (current.mode === "global") return globalDocument ? { ...globalDocument, mode: "override" } : { ...current, mode };
      if (current.mode === "append") {
        return {
          ...current,
          mode,
          body: globalDocument?.body ?? current.body,
          model: current.model ?? globalDocument?.model,
          reasoningOptionId: current.reasoningOptionId !== undefined ? current.reasoningOptionId : globalDocument?.reasoningOptionId,
          serviceTierId: current.serviceTierId !== undefined ? current.serviceTierId : globalDocument?.serviceTierId
        };
      }
      return { ...current, mode };
    });
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

  const isGlobal = document?.mode === "global";
  const isAppend = document?.mode === "append";
  const effectiveModelId = document?.model ?? (isAppend ? globalDocument?.model : undefined) ?? inheritedModelId;
  const selectedModel = models.find((model) => model.modelId === effectiveModelId);
  const globalModel = models.find((model) => model.modelId === globalDocument?.model);
  const reasoningOptions = selectedModel?.reasoningOptions ?? [];
  const serviceTiers = selectedModel?.serviceTiers ?? [];
  const globalReasoningOptions = globalModel?.reasoningOptions ?? [];
  const globalServiceTiers = globalModel?.serviceTiers ?? [];
  const defaultReasoning = reasoningOptions.find((option) => option.optionId === selectedModel?.defaultReasoningOptionId)?.displayName;
  const globalModelLabel = globalDocument?.model
    ? models.find((model) => model.modelId === globalDocument.model)?.displayName ?? globalDocument.model
    : inheritInputLabel;
  const globalReasoningLabel = globalDocument?.reasoningOptionId === null
    ? "Default"
    : globalDocument?.reasoningOptionId
      ? globalReasoningOptions.find((option) => option.optionId === globalDocument.reasoningOptionId)?.displayName ?? globalDocument.reasoningOptionId
      : inheritInputLabel;
  const globalServiceTierLabel = globalDocument?.serviceTierId === null
    ? "Standard"
    : globalDocument?.serviceTierId
      ? globalServiceTiers.find((tier) => tier.tierId === globalDocument.serviceTierId)?.displayName ?? globalDocument.serviceTierId
      : inheritInputLabel;
  const fieldDisabled = Boolean(isGlobal || saving);

  return (
    <Modal title={"角色 · " + roleId} onClose={onClose} width={860} height="78vh">
      <div className="flex h-full flex-col" onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save(); }
      }}>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {document ? (
            <div className="space-y-4">
              <Field kind="select" label="本 workspace 定制方式" value={document.mode} disabled={saving} onChange={(event) => changeMode(event.target.value as RoleDocument["mode"])}>
                <option value="global">global</option>
                <option value="override">override</option>
                <option value="append">append</option>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field kind="select" label="模型" value={isAppend ? document.model ?? inheritGlobalValue : document.model ?? ""} disabled={fieldDisabled} onChange={(event) => update({ model: event.target.value === inheritGlobalValue ? undefined : event.target.value || undefined })}>
                  <option value={isAppend ? inheritGlobalValue : ""}>{isAppend ? `沿用全局（${globalModelLabel}）` : inheritInputLabel}</option>
                  {document.model && !models.some((model) => model.modelId === document.model) && <option value={document.model}>{document.model}（当前文件）</option>}
                  {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}
                </Field>
                <Field kind="select" label="推理档位" value={isAppend ? appendSelectionValue(document.reasoningOptionId) : selectionValue(document.reasoningOptionId)} disabled={fieldDisabled} onChange={(event) => update({ reasoningOptionId: settingValue(event.target.value) })}>
                  <option value={isAppend ? inheritGlobalValue : ""}>{isAppend ? `沿用全局（${globalReasoningLabel}）` : inheritInputLabel}</option>
                  <option value={defaultValue}>{defaultReasoning ? `Default (${defaultReasoning})` : "Default"}</option>
                  {document.reasoningOptionId && !reasoningOptions.some((option) => option.optionId === document.reasoningOptionId) && <option value={document.reasoningOptionId}>{document.reasoningOptionId}（当前文件）</option>}
                  {reasoningOptions.map((option) => <option key={option.optionId} value={option.optionId}>{option.displayName}</option>)}
                </Field>
                <Field kind="select" label="速度" value={isAppend ? appendSelectionValue(document.serviceTierId) : selectionValue(document.serviceTierId)} disabled={fieldDisabled} onChange={(event) => update({ serviceTierId: settingValue(event.target.value) })}>
                  <option value={isAppend ? inheritGlobalValue : ""}>{isAppend ? `沿用全局（${globalServiceTierLabel}）` : inheritInputLabel}</option>
                  <option value={defaultValue}>Standard</option>
                  {document.serviceTierId && !serviceTiers.some((tier) => tier.tierId === document.serviceTierId) && <option value={document.serviceTierId}>{document.serviceTierId}（当前文件）</option>}
                  {serviceTiers.map((tier) => <option key={tier.tierId} value={tier.tierId} title={tier.description}>{tier.displayName}</option>)}
                </Field>
              </div>
              {catalogError && <InlineNotice tone="error">{catalogError}</InlineNotice>}
              <Field kind="textarea" label="Prompt 正文" rows={14} value={document.body} disabled={fieldDisabled} onChange={(event) => update({ body: event.target.value })} />
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
