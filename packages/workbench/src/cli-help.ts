import { z } from "zod";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";

const states: Partial<Record<WorkbenchRpcMethod, string>> = {
  "workItem.diagnose": "任何现存工单；只读，不触发调度。",
  "workItem.escalate": "未结束工单。默认交管家；kind=workspace 只适用于已有合入、回滚或清理动作的主工作区故障。evidence 记录证据，requiredChanges 指定需落实的合同字段。",
  "workItem.recover": "未结束工单。重新核对并续接统一恢复流程；活动处理者不重复启动，合同、依赖、决策等待不会被跳过。",
  "workspace.repair.submit": "未结束的 repair 动作，sessionId 必须是当前修复会话；不存在未答复的关联决策。工作台检查真实 Git 状态后返回 pass。",
  "decision.withdraw": "尚未答复、尚未撤回的决策；sessionId 必须是发起会话，reason 必须说明澄清或过时原因。",
  "decision.answer": "尚未答复的决策；只有获得用户实际答复后才能提交 key 或 note。",
  "runtime.info": "随时查询；连接桌面时返回该运行端的构建哈希，否则返回 CLI 本地运行端并标明 schedulerOnline=false。",
  "workItem.start": "无阻塞的 queued 工单，或同一会话的 running 工单；遵守并发与资源限制。",
  "workItem.submit": "当前 Worker 的 running 工单；提交真实证据、review 与逐条验收结果。",
  "workItem.defer": "执行中的工单；前置必须存在且不得形成依赖环。",
  "workItem.update": "未结束工单；管家落实合同变更，解决合同问题时提供 resolution 与实际变更。",
  "workItem.cancel": "未结束工单；取消当前工作。",
  "workItem.rollback": "已合入且有可回滚提交的工单；提供用户要求回滚的 reason。"
};

/** Parameters and examples come from the RPC schema rather than a second parameter registry. */
function describe(schema: z.ZodTypeAny, sample = false, key = "value"): unknown {
  if (schema instanceof z.ZodOptional) return sample ? undefined : { optional: describe(schema.unwrap()) };
  if (schema instanceof z.ZodDefault) return sample ? schema._def.defaultValue() : { default: schema._def.defaultValue(), type: describe(schema.removeDefault()) };
  if (schema instanceof z.ZodNullable) return sample ? null : { nullable: describe(schema.unwrap()) };
  if (schema instanceof z.ZodEffects) return describe(schema.innerType(), sample, key);
  if (schema instanceof z.ZodObject) return Object.fromEntries(Object.entries(schema.shape).map(([name, value]) => [name, describe(value as z.ZodTypeAny, sample, name)]).filter(([, value]) => value !== undefined));
  if (schema instanceof z.ZodArray) return sample ? Array.from({ length: Math.max(1, schema._def.minLength?.value ?? 0) }, () => describe(schema.element, true, key)) : { array: describe(schema.element), minLength: schema._def.minLength?.value };
  if (schema instanceof z.ZodEnum) return sample ? schema.options[0] : { enum: schema.options };
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) return sample ? describe([...schema.options][0], true, key) : { oneOf: [...schema.options].map((s) => describe(s)) };
  if (schema instanceof z.ZodBoolean) return sample ? true : "boolean";
  if (schema instanceof z.ZodNumber) return sample ? schema.minValue ?? 1 : { type: "number", checks: schema._def.checks };
  if (schema instanceof z.ZodString) return sample ? `<${key}>` : { type: "string", checks: schema._def.checks };
  if (schema instanceof z.ZodRecord) return sample ? {} : { values: describe(schema.valueSchema) };
  return sample ? null : schema._def.typeName;
}

export function methodHelp(method: string): string | undefined {
  const desktopHelp: Record<string, { params: string; state: string; example: object }> = {
    "chatTree.submit": { params: "sessionId: string, nodeId: string, content: string; attachments?: Attachment[], execution?: TurnExecutionOptions, thinkMode?: ThinkMode", state: "桌面在线，sessionId 与 nodeId 指向现存会话节点。", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", content: "继续" } },
    "chatTree.retry": { params: "operationId: 非空 string", state: "桌面在线，operationId 指向失败的发送操作。", example: { operationId: "<operationId>" } },
    "chatTree.operations": { params: "sessionId: 非空 string", state: "桌面在线；只读查询指定会话的发送操作。", example: { sessionId: "<sessionId>" } }
  };
  const desktop = desktopHelp[method];
  if (desktop) return `${method}\n适用状态：${desktop.state}\n参数：${desktop.params}\n示例：\nvermillion ${method} '${JSON.stringify(desktop.example)}'\n`;
  if (!Object.hasOwn(workbenchRpc, method)) return undefined;
  const spec = workbenchRpc[method as WorkbenchRpcMethod];
  const state = states[method as WorkbenchRpcMethod] ?? (/(?:\.get|\.list|\.read|\.diff|\.pending|\.resolve)$/.test(method)
    ? "只读查询；workspaceId 及所引用对象必须存在。"
    : "参数需满足下列 RPC 约束；引用的对象必须存在，业务状态由运行端校验，拒绝时按返回原因处理后再调用。");
  return `${method}\n适用状态：${state}\n参数（optional 可省略；<...> 替换为实际值）：\n${JSON.stringify(describe(spec.params), null, 2)}\n示例：\nvermillion ${method} '${JSON.stringify(describe(spec.params, true))}'\n`;
}
