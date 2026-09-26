import { useEffect, useState } from "react";
import type { EngineModelRpc } from "@vermillion/shared";
import type { RoleFile, WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { InlineNotice, OverflowMenu, PageHeader } from "./ui.js";
import { loadRoleModelOptions, roleModeLabel } from "./RoleEditor.js";

/** Display names and one-line duties, in the order roles take part in the work loop. */
const knownRoles: Array<{ roleId: string; name: string; duty: string }> = [
  { roleId: "design-partner", name: "设计伙伴", duty: "讨论需求，整理文档，发起开工" },
  { roleId: "work-preparation", name: "开工准备", duty: "整理文档、建立工单并登记交接" },
  { roleId: "worker", name: "Worker", duty: "按工单实现、自测并提交证据" },
  { roleId: "reviewer", name: "Reviewer", duty: "审阅 Worker 的候选改动" },
  { roleId: "verifier", name: "Verifier", duty: "按验收条目独立验收" },
  { roleId: "supervisor", name: "监工", duty: "检查工作进展与异常处置" },
  { roleId: "maintainer", name: "Maintainer", duty: "领域巡检、Issue 分诊与授权范围内开单" },
  { roleId: "liaison", name: "Liaison", duty: "IM 反馈收集" }
];

const roleOrder = (roleId: string): number => {
  const index = knownRoles.findIndex((role) => role.roleId === roleId);
  return index < 0 ? knownRoles.length : index;
};

/** Rows follow the known role order; roles added later keep their file title and sort after them. */
export const describeRoles = (roles: RoleFile[]) => [...roles]
  .sort((left, right) => roleOrder(left.roleId) - roleOrder(right.roleId) || left.roleId.localeCompare(right.roleId))
  .map((role) => {
    const known = knownRoles.find((entry) => entry.roleId === role.roleId);
    return { ...role, name: known?.name ?? role.title, duty: known?.duty ?? "" };
  });

/** "GPT-5.6-Sol · High"; fields the role leaves open follow the composer. */
export const roleModelLabel = (config: RoleFile["modelConfig"], models: EngineModelRpc[]): { model: string; reasoning?: string } => {
  if (!config?.modelId && config?.reasoningOptionId === undefined) return { model: "沿用输入器配置" };
  const model = models.find((entry) => entry.modelId === config?.modelId);
  const modelName = config?.modelId ? model?.displayName ?? config.modelId : "沿用输入器模型";
  const reasoningId = config?.reasoningOptionId;
  const reasoning = reasoningId === null
    ? "默认推理"
    : reasoningId ? model?.reasoningOptions.find((option) => option.optionId === reasoningId)?.displayName ?? reasoningId : undefined;
  return { model: modelName, ...(reasoning ? { reasoning } : {}) };
};

export const RolesSection = ({ client, transport, workspaceId, roles, onEdit }: {
  client: WorkbenchClient; transport: DesktopTransport; workspaceId: string; roles: RoleFile[]; onEdit: (roleId: string) => void;
}) => {
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
    <PageHeader title="角色" summary={<span className="text-caption text-muted-foreground">{roles.length} 个角色 · {customized} 个在本 workspace 有定制</span>} />
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    <ul className="vm-role-table" aria-label="角色">
      <li className="vm-role-row vm-role-row--head" aria-hidden="true"><span>角色</span><span>职责</span><span>模型</span><span>本 workspace</span></li>
      {rows.map((role) => {
        const label = roleModelLabel(role.modelConfig, models);
        return <li key={role.roleId} className="vm-role-row">
          <button type="button" className="vm-role-row__main" onClick={() => onEdit(role.roleId)} aria-label={"编辑角色：" + role.name}>
            <span className="vm-role-row__name"><b>{role.name}</b><span>{role.roleId}</span></span>
            <span className="vm-role-row__duty">{role.duty}</span>
            <span className="vm-role-row__model">{label.model}{label.reasoning && <span> · {label.reasoning}</span>}</span>
            <span className="vm-role-mode" data-mode={role.mode}>{roleModeLabel[role.mode]}</span>
          </button>
          <OverflowMenu label={"更多操作：" + role.name} items={[
            { label: "编辑", onSelect: () => onEdit(role.roleId) },
            { label: "恢复全局", disabled: role.mode === "global", onSelect: () => reset(role.roleId) }
          ]} />
        </li>;
      })}
    </ul>
    <p className="vm-role-legend">
      <span className="vm-role-mode" data-mode="global">沿用全局</span>使用全局正文
      <span className="vm-role-mode" data-mode="append">追加正文</span>全局正文后接本项目内容
      <span className="vm-role-mode" data-mode="override">覆盖正文</span>只用本项目内容
    </p>
  </div>;
};
