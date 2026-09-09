import { z } from "zod";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";

const states: Partial<Record<WorkbenchRpcMethod, string>> = {
  "worktree.list": "查询工单已登记的延迟清理候选。",
  "worktree.cleanup": "立即尝试清理无未结束工单占用的候选；忙目录保留至下次调用。只接受 workspaceId，不接受任意路径。",
  "workItem.diagnose": "任何现存工单；只读，不触发调度。",
  "decision.answer": "尚未答复的决策；只有获得用户实际答复后才能提交 key 或 note。",
  "runtime.info": "随时查询；连接桌面时返回该运行端的构建哈希，否则返回 CLI 本地运行端并标明 schedulerOnline=false。",
  "workItem.start": "无阻塞的 queued 工单，或同一会话的 running 工单；遵守并发与资源限制。",
  "workItem.submit": "当前 Worker 的 running 工单；提交真实证据、review 与逐条验收结果。",
  "workItem.update": "未结束工单；调整合同并通过 note 说明具体修改。",
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
