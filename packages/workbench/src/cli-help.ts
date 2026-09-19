import { z } from "zod";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";

const states: Partial<Record<WorkbenchRpcMethod, string>> = {
  "docs.discardPreview": "只读预览：paths 可选 .vermillion/docs 内的文件或目录，返回当前变更文件。",
  "docs.discard": "丢弃已确认文件的暂存和未暂存改动，恢复到 HEAD；新增文件删除。paths 必须传 discardPreview 返回的具体文件路径，不展开目录。返回实际处理的变更。",
  "docs.rebase": "在一棵会话树里提交文档时与主分支冲突后使用；把该树的草稿同步到主分支，冲突文件留在草稿里带冲突标记，用 docs.write 解决后再 docs.commit。files 为空表示已同步。",
  "worktree.list": "查询工单已登记的延迟清理候选。",
  "worktree.cleanup": "立即尝试清理无未结束工单占用的候选和已合入的文档草稿；忙目录与有未合入修改的草稿保留至下次调用。只接受 workspaceId，不接受任意路径。",
  "workItem.diagnose": "任何现存工单；只读，不触发调度。",
  "work.cancel": "准备中的开工请求；通过 requestId 或准备分支 sessionId 取消本次开工及尚未执行的关联工单。",
  "decision.answer": "尚未答复的决策；只有获得用户实际答复后才能提交 key 或 note。",
  "runtime.info": "随时查询；连接桌面时返回该运行端的构建哈希，否则返回 CLI 本地运行端并标明 schedulerOnline=false。",
  "workItem.start": "无阻塞的 queued 工单，或同一会话的 running 工单；遵守并发与资源限制。",
  "workItem.submit": "当前 Worker 的 running 工单；提交真实证据、review 与逐条验收结果。",
  "workItem.update": "未结束工单；调整合同并通过 note 说明具体修改。调整自己执行的工单时传当前 sessionId，工作台不会把调整回送给该会话。",
  "docs.commit": "workspaceId 与提交说明；paths 限定本次提交的文档。传 sessionId 时先在会话树自己的草稿里提交再合入主分支，冲突会列出文件并提示用 docs.rebase 解决；在自己执行的工单里提交文档时传当前 sessionId，工作台不会把这次提交回送给该会话。",
  "docs.write": "写入 .vermillion/docs 内的文档。传 sessionId 时写入该会话树的草稿，草稿在首次写入时自动建立，不影响主分支与其他会话树。",
  "docs.read": "读取 .vermillion/docs 内的文档。传 sessionId 时读该会话树的草稿；传 commit 时读取该提交的版本，与草稿无关。",
  "docs.list": "列出 .vermillion/docs 下的文件。传 sessionId 时列该会话树的草稿，草稿不存在时列主分支。",
  "docs.pending": "列出当前未提交的文档变更。传 sessionId 时以该会话树的草稿为准。",
  "docs.diff": "查看一个文档相对当前提交的差异。传 sessionId 时以该会话树的草稿为准。",
  "workItem.cancel": "未结束工单；取消当前工作。",
  "workItem.pause": "正在运行的 Worker 会话；登记用户暂停，配合会话 Stop 使用。",
  "workItem.resume": "用户已暂停的工单；清除暂停并从原会话继续。",
  "workItem.integration.retry": "合入失败且尚未交给 Agent 的工单；立即重试当前合入，不等待自动重试时间。",
  "workItem.integration.takeover": "合入失败且尚未交给 Agent 的工单；停止自动合入重试，附说明交给原 Worker 处理。",
  "workItem.integration.complete": "已接管合入的原 Worker；处理 worktree/rebase 后请求工作台在串行边界执行最终合入。",
  "app.start": "本地启动隔离验收实例；可用 fixture=session-tree 或 real-session，返回 pid、CDP、隔离路径和 fixture 身份。",
  "app.stop": "停止 app.start 返回的验收实例。",
  "app.window": "本地控制 app.start 返回实例的窗口；status 查询，minimize 最小化，restore 恢复并激活。",
  "asksource": "当前执行中工单的 Worker；从工单记录的开单位置临时询问来源设计伙伴并等待答复。",
  "steer": "桌面在线；向任意可访问会话追加当前轮或启动该会话的新轮。sessionId 接受工作台会话 ID 或引擎会话标识（如子代理返回的 id）。",
  "workItem.rollback": "已合入且有可回滚提交的工单；提供用户要求回滚的 reason。",
  "search.query": "只读查询；搜索已登记的 workspace 工单和 Vermillion rollout 文件，返回命中上下文。",
  "search.start": "只读查询；开始一次流式搜索，命中通过 search.hits 事件推送，结束时推送 search.completed。发起新的流式搜索会终止上一次。",
  "search.cancel": "停止指定 queryId 的流式搜索及其扫描进程。",
  "issue.discuss": "桌面在线；为 Issue 创建或返回已有设计伙伴讨论会话。",
  "issue.update": "更新 Issue 分诊、证据或处理结果；关闭和重复需要处理原因。",
  "domain.config.set": "用户管理领域巡检与自动开单授权；按领域独立保存。",
  "domain.instruction.write": "编辑领域专属 Maintainer developer instruction；保存到当前 workspace。",
  "domain.remove": "删除领域定义、领域巡检指令与巡检配置；历史 Issue 和巡检记录保留。",
  "workspace.directories": "只读查询；返回 workspace 中 Git 已跟踪文件所在的目录，供触发目录勾选。",
  "domain.patrol.run": "手动排入一次真实领域巡检；桌面调度在线时启动 Maintainer 会话。",
  "domain.patrol.scan": "扫描目录变更和定时到期条件；无事可查时记录跳过，不启动模型。",
  "domain.patrol.complete": "当前 Maintainer 巡检会话登记结果和关联 Issue。",
  "domain.issue.workItem.create": "当前 Maintainer 巡检会话；仅在领域授权、固定要求引用和证据均有效时自动创建关联修复工单。"
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
    "sessionBrowser.list": { params: "workspaceId: string; kind?: user | agent", state: "桌面在线；一次返回该 workspace 会话列表的全部行与当前 revision。", example: { workspaceId: "<workspaceId>" } },
    "sessionBrowser.changes": { params: "workspaceId: string; revision: string; kind?: user | agent", state: "桌面在线；返回自该 revision 以来变化的行与被移除的行标识；revision 不可用时返回 full-required。", example: { workspaceId: "<workspaceId>", revision: "<revision>" } },
    "sessionBrowser.open": { params: "sessionId: string; forceProviderHydration?: boolean", state: "桌面在线；进入会话并按当前 rollout 刷新 Codex 历史。", example: { sessionId: "<sessionId>" } },
    "sessionBrowser.rename": { params: "sessionId: string, title: 非空 string", state: "桌面在线；改会话标题，返回保存后的标题。列表中的会话都可用，未加载的历史会话改其索引记录。", example: { sessionId: "<sessionId>", title: "新标题" } },
    "chatTree.get": { params: "sessionId: string; scope?: \"tree\" | \"path\"", state: "桌面在线；默认读取完整会话树结构，节点包含所属 sessionId 与 canHide；scope=path 只加载当前查看路径并返回该路径成员的正文窗口。", example: { sessionId: "<sessionId>" } },
    "chatTree.nodeAction": { params: "sessionId: string, nodeId: string, action: copy_session_id | copy_awb_session_id | open_rollout | hide_branch", state: "桌面在线；复制返回 copiedText，open_rollout 返回节点所属会话的文件，hide_branch 只对末端 fork 分支记录隐藏标记，不归档引擎会话。", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", action: "copy_session_id" } },
    "clipboard.writeImage": { params: "source: 非空 data:、file:、http: 或 https: 图片 URL", state: "桌面在线；将图片写入系统剪贴板并返回实际尺寸。", example: { source: "file:///C:/path/image.png" } },
    "chatTree.markRead": { params: "sessionId: string, nodeId: string", state: "Desktop online; marks completed turns on the displayed node's ancestor path read. Returns readNodeIds.", example: { sessionId: "<sessionId>", nodeId: "<nodeId>" } },
    "chatTree.submit": { params: "sessionId: string, nodeId: string, content: string; attachments?: Attachment[], execution?: TurnExecutionOptions", state: "桌面在线，sessionId 与 nodeId 指向现存会话节点。", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", content: "继续" } },
    "chatTree.retry": { params: "operationId: 非空 string", state: "桌面在线，operationId 指向失败的发送操作。", example: { operationId: "<operationId>" } },
    "chatTree.cancel": { params: "operationId: 非空 string", state: "桌面在线，operationId 指向正在创建或发送的虚态操作。", example: { operationId: "<operationId>" } },
    "chatTree.remove": { params: "operationId: 非空 string", state: "桌面在线，operationId 指向失败或清理待重试的虚态操作。", example: { operationId: "<operationId>" } },
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
