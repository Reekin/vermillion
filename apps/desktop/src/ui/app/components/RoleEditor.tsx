import { useEffect, useState } from "react";
import type { EngineModelRpc } from "@vermillion/shared";
import type { RoleDocument, WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { resolveComposerExecutionSelection, resolveComposerModels } from "../../chat-shell/use-composer-controller.js";
import type { WorkbenchStore } from "../workbench-store.js";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice, Select } from "./ui.js";
import { t } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";

const inheritGlobalValue = "__inherit_global__";
const defaultValue = "__default__";
const selectionValue = (value: string | null | undefined) => value === null ? defaultValue : value ?? "";
const appendSelectionValue = (value: string | null | undefined) => value === null ? defaultValue : value ?? inheritGlobalValue;
const settingValue = (value: string) => value === defaultValue ? null : value === inheritGlobalValue ? undefined : value || undefined;

/** Models of the new-session engine as the composer offers them, plus the composer's current model for inherited fields. */
export const loadRoleModelOptions = async (transport: DesktopTransport): Promise<{ models: EngineModelRpc[]; inheritedModelId?: string }> => {
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
  return { models, ...(execution?.modelId ? { inheritedModelId: execution.modelId } : {}) };
};

/** Mode names shown to users; the stored values stay global / override / append. */
export const roleModeLabel = (mode: RoleDocument["mode"]): string =>
  mode === "global" ? t("docs.roles.mode.global") : mode === "override" ? t("docs.roles.mode.override") : t("docs.roles.mode.append");

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
  const t = useT();
  const inheritInputLabel = t("docs.roles.inheritComposer");
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
    void client.request("role.editor.read", { workspaceId, roleId })
      .then((role) => {
        if (cancelled) return;
        const base = role.globalDocument ?? (role.source === "global" ? { ...role.document, mode: "global" as const } : undefined);
        setGlobalDocument(base);
        setDocument(role.document);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    void loadRoleModelOptions(transport)
      .then((options) => {
        if (cancelled) return;
        setModels(options.models);
        setInheritedModelId(options.inheritedModelId);
      })
      .catch((cause) => { if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : String(cause)); });
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
          ? { ...current, mode, body: "", model: undefined, reasoningOptionId: undefined, serviceTierId: undefined, checkIntervalMinutes: undefined }
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
          serviceTierId: current.serviceTierId !== undefined ? current.serviceTierId : globalDocument?.serviceTierId,
          checkIntervalMinutes: current.checkIntervalMinutes ?? globalDocument?.checkIntervalMinutes
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
    <Modal title={t("docs.roleEditor.title", { roleId })} onClose={onClose} width={860} height="78vh">
      <div className="flex h-full flex-col" onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save(); }
      }}>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {document ? (
            <div className="space-y-4">
              <Select label={t("docs.roleEditor.mode")} value={document.mode} disabled={saving} onChange={(value) => changeMode(value as RoleDocument["mode"])}
                options={(["global", "override", "append"] as const).map((mode) => ({ value: mode, label: roleModeLabel(mode) }))} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Select label={t("docs.roles.model")} value={isAppend ? document.model ?? inheritGlobalValue : document.model ?? ""} disabled={fieldDisabled}
                  onChange={(value) => update({ model: value === inheritGlobalValue ? undefined : value || undefined })}
                  options={[
                    { value: isAppend ? inheritGlobalValue : "", label: isAppend ? t("docs.roleEditor.inheritGlobal", { value: globalModelLabel }) : inheritInputLabel },
                    ...(document.model && !models.some((model) => model.modelId === document.model) ? [{ value: document.model, label: t("docs.roleEditor.currentFile", { value: document.model }) }] : []),
                    ...models.map((model) => ({ value: model.modelId, label: model.displayName }))
                  ]} />
                <Select label={t("docs.roleEditor.reasoning")} value={isAppend ? appendSelectionValue(document.reasoningOptionId) : selectionValue(document.reasoningOptionId)} disabled={fieldDisabled}
                  onChange={(value) => update({ reasoningOptionId: settingValue(value) })}
                  options={[
                    { value: isAppend ? inheritGlobalValue : "", label: isAppend ? t("docs.roleEditor.inheritGlobal", { value: globalReasoningLabel }) : inheritInputLabel },
                    { value: defaultValue, label: defaultReasoning ? `Default (${defaultReasoning})` : "Default" },
                    ...(document.reasoningOptionId && !reasoningOptions.some((option) => option.optionId === document.reasoningOptionId) ? [{ value: document.reasoningOptionId, label: t("docs.roleEditor.currentFile", { value: document.reasoningOptionId }) }] : []),
                    ...reasoningOptions.map((option) => ({ value: option.optionId, label: option.displayName }))
                  ]} />
                <Select label={t("docs.roleEditor.speed")} value={isAppend ? appendSelectionValue(document.serviceTierId) : selectionValue(document.serviceTierId)} disabled={fieldDisabled}
                  onChange={(value) => update({ serviceTierId: settingValue(value) })}
                  options={[
                    { value: isAppend ? inheritGlobalValue : "", label: isAppend ? t("docs.roleEditor.inheritGlobal", { value: globalServiceTierLabel }) : inheritInputLabel },
                    { value: defaultValue, label: "Standard" },
                    ...(document.serviceTierId && !serviceTiers.some((tier) => tier.tierId === document.serviceTierId) ? [{ value: document.serviceTierId, label: t("docs.roleEditor.currentFile", { value: document.serviceTierId }) }] : []),
                    ...serviceTiers.map((tier) => ({ value: tier.tierId, label: tier.displayName, hint: tier.description }))
                  ]} />
              </div>
              {roleId === "supervisor" && <Field kind="input" type="number" label={t("docs.roleEditor.interval")} min={1} step={1}
                value={document.checkIntervalMinutes ?? (isGlobal ? 5 : "")} disabled={fieldDisabled}
                placeholder={isAppend ? t("docs.roleEditor.inheritGlobal", { value: t("common.durationMinutes", { minutes: globalDocument?.checkIntervalMinutes ?? 5 }) }) : t("docs.roleEditor.defaultInterval", { minutes: 5 })}
                onChange={(event) => update({ checkIntervalMinutes: event.target.value === "" ? undefined : Number(event.target.value) })} />}
              {catalogError && <InlineNotice tone="error">{t("docs.roleEditor.catalogFailed", { error: catalogError })}</InlineNotice>}
              <Field kind="textarea" label={t("docs.roleEditor.body")} rows={14} value={document.body} disabled={fieldDisabled} onChange={(event) => update({ body: event.target.value })} />
            </div>
          ) : !error && <InlineNotice>{t("common.loading")}</InlineNotice>}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
        </div>
        <footer className="flex h-10 shrink-0 items-center gap-3 border-t border-border px-4">
          <span className="text-caption text-muted-foreground">{t("docs.roleEditor.footer", { status: dirty ? t("docs.unsavedHint") : t("docs.saved") })}</span>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!document || !dirty || saving} onClick={() => void save()}>{saving ? t("docs.saving") : t("common.save")}</Button>
        </footer>
      </div>
    </Modal>
  );
};
