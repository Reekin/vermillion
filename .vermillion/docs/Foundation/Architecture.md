# 工作台架构

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `packages/shared`、`core`、`adapters`、`apps/desktop-server` | 会话引擎契约、会话与 turn 投影、引擎适配（Codex app-server、pi RPC）、会话浏览 |
| `packages/workbench` | Workspace、Doc、开工请求、工单、决策和 Inbox 的领域操作与持久化 |
| `apps/desktop/src/ui/chat-shell` | `SessionPane` 的消息阅读、输入、会话切换和审批 |
| `apps/desktop/src/ui/app` | 导航、文档、工作区面板、工单与 Worker 分支的展示和查询 |

Renderer 只通过 `@vermillion/workbench/client` 访问工作台契约。应用壳向会话区提供展示数据、渲染插槽和回调；会话区不引用应用壳 Context 或工作台业务类型，不自行查询工单。

`AgentRunner`（`apps/desktop/src/electron/agent-runner.ts`）是工作台编排层与会话引擎之间的接口，提供 fork、打开、恢复、发送、steer、中断、释放执行环境及 turn 完成通知。Worker 会话 metadata 保存角色、工单和来源信息。

## Workspace 与界面状态

`draftWorkspaceId` 决定新建会话创建位置；已创建会话的 workspaceId 来自会话引擎；`browsingWorkspaceId` 决定文档等工作台查询范围，随当前会话切换，草稿态跟随 draft。

查询结果携带 workspaceId，界面 store 丢弃与当前 browsing 不匹配的响应。领域写入发布 `WorkbenchEvent`；`.vermillion/` 文件监听把外部修改纳入同一事件更新链路。界面订阅事件刷新，不以轮询推进状态。

## 持久化与事务

全局 `~/.vermillion/` 保存 workspace 注册表、会话索引和全局角色文件。引擎的 `workspace-registry.json` 是唯一 workspace 注册表。

每个 workspace 的 `.vermillion/` 保存 `docs/`、`roles/`、`work-requests/`、`workitems/`、`decisions/`、`runs/` 和 `scheduler.json`。文档在 `.vermillion/docs/` 内，以 Git commit 作为工单引用依据；工作台运行记录通过领域服务写入。

文档草稿是每棵会话树一个只签出 `.vermillion/docs` 的 sparse worktree，分支与目录以 treeId 命名，由 `DocsService` 在首次写入时创建。`docs.*` RPC 按调用方 sessionId 解析 treeId 并路由到对应草稿；treeId 由会话索引提供，工作台服务通过它已有的运行时接入点获取。草稿合入主干走与 Worker 成果合入相同的 `integrate` 串行边界和冲突处理，回收复用 `cleanup` 候选机制。

每张工单持久化为一份 `WorkItemRecord`，包含合同与业务进度 `item`、当前执行过程 `execution`、合入检查点 `integrations` 和回收候选 `cleanup`。执行过程保存当前会话、消息投递、失败和重试状态，是恢复执行的唯一依据。工单查询中的 `run` 由 execution 投影，不单独持久化；`runs/` 中的历史记录只用于追溯。

`WorkspaceStore` 只负责记录查询和按工单串行的读改写事务；`WorkbenchService` 在事务内完成状态转换。持久化成功后统一发布工单和动作事件。取消事件先于通用更新事件送达，使本次取消触发的中断先于后续调度入队。查询投影不提供写入入口。

## 会话引擎接入

引擎产品行为见[会话引擎](Engines/PRD.md)。每个引擎是一个装配单元 `EngineIntegration`（`apps/desktop-server/src/engines/<engineId>/`），包含引擎定义、能力面声明、`AgentAdapter` 与 runtime port、`AgentWorkbenchCapabilities`、程序解析规则和可选的 turn 扩展；`prod-service` 只持有装配单元列表，不直接引用任何引擎实现。会话级操作（释放执行、清理历史、活动 turn、技能列表、fork、凭据）都属于 `AgentWorkbenchCapabilities`，由 `CapabilityRegistry` 按会话 `engineId` 分发；shell 层不接收面向单一引擎的函数。入口（新建会话、AgentRunner、asksource）从设置读取新会话引擎，不写死引擎 ID。

pi 的 runtime port 每会话启动一个 `pi --mode rpc` 进程，使用只按 `
` 切分的 JSONL 客户端；宿主工具与角色指令注入由随包附带的 pi extension 提供。

## 会话与执行环境

### 节点执行配置

节点执行配置的产品行为见[工作台 · 输入器](../Workbench/Think/PRD.md#输入器)。Codex 适配层接收 `thread/settings/updated` 的 `model`、`effort`、`serviceTier`，按所属 thread 的轮次生命周期关联 `turnId`；`model/rerouted` 按其携带的 `turnId` 更新该轮模型。配置关联和引擎字段映射留在适配层，不能把发送请求参数冒充引擎已确认的生效配置。

Vermillion 将逐轮生效配置作为节点执行记录持久化，并通过已有会话、turn 和 ChatTree 查询链路提供给界面及 CLI。历史重新加载与投影重建保留这些记录；共享节点通过原 turn 身份读取同一份配置，不复制当前分支配置覆盖它。输入器的可编辑发送配置与历史执行记录分开，提交时固定本次发送配置，异步 fork 与节点身份转换继续使用该配置。此链路只消费引擎协议和应用自己的记录，不读取 Codex rollout。

### 会话生命周期

渲染订阅按可见 turn 路径限定，树成员关系不作为正文的订阅范围。后台内容仍由会话引擎保存，事件按批次接收；后台文本、终端输出和工具进度不触发当前 transcript 或 Composer 更新。运行、完成、失败、中断、审批和交互请求保持状态通知。切换路径时从最新投影读取内容，再订阅该路径的后续变化。输入草稿由输入器本地管理，与内容流的更新边界分开。

会话 cwd 保持 workspace 根目录。使用 worktree 时，Worker 在具体工具调用中显式指定 workdir、`git -C` 或文件绝对路径；工单流转与目录回收见[工单](../Workbench/Missions/PRD.md)。

会话历史与执行环境的生命周期分开。读取历史先检查引擎是否已加载会话；未加载时在 workspace 根恢复，读完退订临时加载的执行环境，不发送模型消息。已有活动执行保持运行。历史阅读不依赖工单 worktree 是否存在；已加载会话树内的节点跳转只保存查看位置，树模型见[思考](../Workbench/Think/PRD.md#会话树)。

会话树成员的轮次归属在引擎适配层判定一次：fork 会话读取历史时，按引擎给出的 fork 来源与轮次时间识别继承前缀，只输出自有轮次，并把 fork 点 turn id 作为 hydration 结果交给索引持久化。对账层不依据其他成员当时是否已加载推断归属，也不为提交某个成员而预加载整条祖先链；继承轮次的时间始终来自其所在 rollout，共享 turn 在祖先与子会话中读取到同一时间。

会话内消息、工具调用和终端流的实体标识只有一种：由会话 id 与引擎 item id 组合得到，实时事件与历史读取对同一个 item 生成同一个 id；用户消息以发送时分配、引擎随 item 回带的客户端消息 id 作为 item id，本地回显与历史读取落到同一实体。同一 item 无论先经流式事件进入投影、还是随后由 hydration 再次写入，都落到同一实体上；投影合并只按 id 对齐，不做按文本匹配的替换或去重。

加载取消只用 `AbortSignal` 表达：打开会话、历史读取、`thread/resume` 与会话树加载各持有本次的 controller，失效即中止旧 controller 并从头发起新一次加载；不并行维护回调式取消判断或按会话计数的代次。

`WrapperChatTreeService` 以每次加载为独立实例：一次加载持有自己的 signal、成员读取任务和构建结果，完成后整体成为已发布投影。已发布投影是不可变值，查看位置变更产生新投影而不是就地改写；查询、跳转和发送准备只读取当前已发布投影，读取路径不重新构建树或等待成员加载。

`Orchestrator` 由工作台事件和 turn 完成通知驱动。合同更新送达原执行会话；提交依据是否有效由当前合同决定，与消息送达所在轮次无关。业务上的等待、重试和提交规则见[执行循环规范](../Workbench/Missions/Standards.md)。

## 桌面与 CLI

桌面与 CLI 使用同一工作台服务。桌面在 `<baseDir>/endpoint.json` 发布 loopback 端口，CLI 优先调用桌面服务；桌面未运行时在进程内运行同一个服务。

桌面启动时将 `vermillion` CLI 放入 `<baseDir>/bin` 并加入本进程 PATH，引擎子进程继承该路径。角色文件解析与 developer 指令注入见[角色](../Workbench/Roles/PRD.md)。
