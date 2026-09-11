import { z } from "zod";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";

const states: Partial<Record<WorkbenchRpcMethod, string>> = {
  "docs.discardPreview": "只读预览：paths 可选 .vermillion/docs 内的文件或目录，返回当前变更文件。",
  "docs.discard": "丢弃已确认文件的暂存和未暂存改动，恢复到 HEAD；新增文件删除。paths 必须传 discardPreview 返回的具体文件路径，不展开目录。返回实际处理的变更。",
  "worktree.list": "查询工单已登记的延迟清理候选。",
  "worktree.cleanup": "立即尝试清理无未结束工单占用的候选；忙目录保留至下次调用。只接受 workspaceId，不接受任意路径。",
  "workItem.diagnose": "任何现存工单；只读，不触发调度。",
  "work.cancel": "准备中的开工请求；通过 requestId 或准备分支 sessionId 取消本次开工及尚未执行的关联工单。",
  "decision.answer": "尚未答复的决策；只有获得用户实际答复后才能提交 key 或 note。",
  "runtime.info": "随时查询；连接桌面时返回该运行端的构建哈希，否则返回 CLI 本地运行端并标明 schedulerOnline=false。",
  "workItem.start": "无阻塞的 queued 工单，或同一会话的 running 工单；遵守并发与资源限制。",
  "workItem.submit": "当前 Worker 的 running 工单；提交真实证据、review 与逐条验收结果。",
  "workItem.update": "未结束工单；调整合同并通过 note 说明具体修改。",
  "workItem.cancel": "未结束工单；取消当前工作。",
  "workItem.pause": "正在运行的 Worker 会话；登记用户暂停，配合会话 Stop 使用。",
  "workItem.resume": "用户已暂停的工单；清除暂停并从原会话继续。",
  "workItem.integration.retry": "合入失败且尚未交给 Agent 的工单；立即重试当前合入，不等待自动重试时间。",
  "workItem.integration.takeover": "合入失败且尚未交给 Agent 的工单；停止自动合入重试，附说明交给原 Worker 处理。",
  "workItem.integration.complete": "已接管合入的原 Worker；处理 worktree/rebase 后请求工作台在串行边界执行最终合入。",
  "workItem.rollback": "已合入且有可回滚提交的工单；提供用户要求回滚的 reason。",
  "search.query": "只读查询；搜索已登记的 workspace 工单和 Vermillion rollout 文件，返回命中上下文。"
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
    "sessionBrowser.open": { params: "sessionId: string; forceProviderHydration?: boolean", state: "桌面在线；进入会话并按当前 rollout 刷新 Codex 历史。", example: { sessionId: "<sessionId>" } },
    "chatTree.get": { params: "sessionId: string", state: "桌面在线；读取完整会话树，节点包含所属 sessionId 与 canArchive。", example: { sessionId: "<sessionId>" } },
    "chatTree.nodeAction": { params: "sessionId: string, nodeId: string, action: copy_session_id | copy_awb_session_id | archive", state: "桌面在线；复制返回 copiedText，archive 仅归档末端 fork 分支。", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", action: "copy_session_id" } },
    "chatTree.markRead": { params: "sessionId: string, nodeId: string", state: "Desktop online; marks completed turns on the displayed node's ancestor path read. Returns readNodeIds.", example: { sessionId: "<sessionId>", nodeId: "<nodeId>" } },
    "chatTree.submit": { params: "sessionId: string, nodeId: string, content: string; attachments?: Attachment[], execution?: TurnExecutionOptions", state: "桌面在线，sessionId 与 nodeId 指向现存会话节点。", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", content: "继续" } },
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
