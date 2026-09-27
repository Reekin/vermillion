import { useEffect, useState } from "react";
import type { EngineModelRpc } from "@vermillion/shared";
import type { RoleFile, WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { InlineNotice, OverflowMenu, PageHeader } from "./ui.js";
import { loadRoleModelOptions, roleModeLabel } from "./RoleEditor.js";
import { t } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";

/** Known roles in the order they take part in the work loop. */
const knownRoleIds = ["design-partner", "work-preparation", "worker", "reviewer", "verifier", "supervisor", "maintainer", "liaison"];

/** Display name and one-line duty of a known role, in the current interface language. */
const knownRole = (roleId: string): { name: string; duty: string } | undefined => {
  switch (roleId) {
    case "design-partner": return { name: t("docs.roles.designPartner"), duty: t("docs.roles.duty.designPartner") };
    case "work-preparation": return { name: t("docs.roles.workPreparation"), duty: t("docs.roles.duty.workPreparation") };
    case "worker": return { name: "Worker", duty: t("docs.roles.duty.worker") };
    case "reviewer": return { name: "Reviewer", duty: t("docs.roles.duty.reviewer") };
    case "verifier": return { name: "Verifier", duty: t("docs.roles.duty.verifier") };
    case "supervisor": return { name: t("docs.roles.supervisor"), duty: t("docs.roles.duty.supervisor") };
    case "maintainer": return { name: "Maintainer", duty: t("docs.roles.duty.maintainer") };
    case "liaison": return { name: "Liaison", duty: t("docs.roles.duty.liaison") };
    default: return undefined;
  }
};

const roleOrder = (roleId: string): number => {
  const index = knownRoleIds.indexOf(roleId);
  return index < 0 ? knownRoleIds.length : index;
};

/** Rows follow the known role order; roles added later keep their file title and sort after them. */
export const describeRoles = (roles: RoleFile[]) => [...roles]
  .sort((left, right) => roleOrder(left.roleId) - roleOrder(right.roleId) || left.roleId.localeCompare(right.roleId))
  .map((role) => {
    const known = knownRole(role.roleId);
    return { ...role, name: known?.name ?? role.title, duty: known?.duty ?? "" };
  });

/** "GPT-5.6-Sol · High"; fields the role leaves open follow the composer. */
export const roleModelLabel = (config: RoleFile["modelConfig"], models: EngineModelRpc[]): { model: string; reasoning?: string } => {
  if (!config?.modelId && config?.reasoningOptionId === undefined) return { model: t("docs.roles.inheritComposer") };
  const model = models.find((entry) => entry.modelId === config?.modelId);
  const modelName = config?.modelId ? model?.displayName ?? config.modelId : t("docs.roles.inheritComposerModel");
  const reasoningId = config?.reasoningOptionId;
  const reasoning = reasoningId === null
    ? t("docs.roles.defaultReasoning")
    : reasoningId ? model?.reasoningOptions.find((option) => option.optionId === reasoningId)?.displayName ?? reasoningId : undefined;
  return { model: modelName, ...(reasoning ? { reasoning } : {}) };
};

export const RolesSection = ({ client, transport, workspaceId, roles, onEdit }: {
  client: WorkbenchClient; transport: DesktopTransport; workspaceId: string; roles: RoleFile[]; onEdit: (roleId: string) => void;
}) => {
  const t = useT();
  const [models, setModels] = useState<EngineModelRpc[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void loadRoleModelOptions(transport).then((options) => { if (active) setModels(options.models); }).catch(() => undefined);
    return () => { active = false; };
  }, [transport]);
  const rows = describeRoles(roles);
  const customized = roles.filter((role) => role.mode !== "global").length;
  const reset = (roleId: string) => {
    setError(undefined);
    void client.request("role.reset", { workspaceId, roleId }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <div className="vm-page">
    <PageHeader title={t("docs.roles.title")} summary={<span className="text-caption text-muted-foreground">{t("docs.roles.summary", { count: roles.length, customized })}</span>} />
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    <ul className="vm-role-table" aria-label={t("docs.roles.title")}>
      <li className="vm-role-row vm-role-row--head" aria-hidden="true"><span>{t("docs.roles.title")}</span><span>{t("docs.roles.duty")}</span><span>{t("docs.roles.model")}</span><span>{t("docs.roles.thisWorkspace")}</span></li>
      {rows.map((role) => {
        const label = roleModelLabel(role.modelConfig, models);
        return <li key={role.roleId} className="vm-role-row">
          <button type="button" className="vm-role-row__main" onClick={() => onEdit(role.roleId)} aria-label={t("docs.roles.edit", { name: role.name })}>
            <span className="vm-role-row__name"><b>{role.name}</b><span>{role.roleId}</span></span>
            <span className="vm-role-row__duty">{role.duty}</span>
            <span className="vm-role-row__model" data-inherited={role.modelConfig?.modelId ? undefined : true}>{label.model}{label.reasoning && <span> · {label.reasoning}</span>}</span>
            <span className="vm-role-mode" data-mode={role.mode}>{roleModeLabel(role.mode)}</span>
          </button>
          <OverflowMenu label={t("docs.moreActions", { name: role.name })} items={[
            { label: t("docs.roles.editAction"), onSelect: () => onEdit(role.roleId) },
            { label: t("docs.roles.reset"), disabled: role.mode === "global", onSelect: () => reset(role.roleId) }
          ]} />
        </li>;
      })}
    </ul>
    <p className="vm-role-legend">
      <span className="vm-role-mode" data-mode="global">{roleModeLabel("global")}</span>{t("docs.roles.legend.global")}
      <span className="vm-role-mode" data-mode="append">{roleModeLabel("append")}</span>{t("docs.roles.legend.append")}
      <span className="vm-role-mode" data-mode="override">{roleModeLabel("override")}</span>{t("docs.roles.legend.override")}
    </p>
  </div>;
};
