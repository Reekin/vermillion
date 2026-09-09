# 工作台架构

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `packages/shared`、`core`、`adapters`、`apps/desktop-server` | 会话引擎契约、会话与 turn 投影、Codex app-server 适配、会话浏览 |
| `packages/workbench` | Workspace、Doc、开工请求、工单、决策和 Inbox 的领域操作与持久化 |
| `apps/desktop/src/ui/chat-shell` | `SessionPane` 的消息阅读、输入、会话切换和审批 |
| `apps/desktop/src/ui/app` | 导航、Docs、工作区面板、工单与 Worker 分支的展示和查询 |

Renderer 只通过 `@vermillion/workbench/client` 访问工作台契约。应用壳向会话区提供展示数据、渲染插槽和回调；会话区不引用应用壳 Context 或工作台业务类型，不自行查询工单。

`AgentRunner`（`apps/desktop/src/electron/agent-runner.ts`）是工作台编排层与会话引擎之间的接口，提供 fork、打开、恢复、发送、steer、中断、释放执行环境及 turn 完成通知。Worker 会话 metadata 保存角色、工单和来源信息。

## Workspace 与界面状态

`draftWorkspaceId` 决定 New Chat 创建位置；已创建会话的 workspaceId 来自会话引擎；`browsingWorkspaceId` 决定 Docs 等工作台查询范围，随当前会话切换，草稿态跟随 draft。

查询结果携带 workspaceId，界面 store 丢弃与当前 browsing 不匹配的响应。领域写入发布 `WorkbenchEvent`；`.vermillion/` 文件监听把外部修改纳入同一事件更新链路。界面订阅事件刷新，不以轮询推进状态。

## 持久化与事务

全局 `~/.vermillion/` 保存 workspace 注册表、会话索引和全局角色文件。引擎的 `workspace-registry.json` 是唯一 workspace 注册表。

每个 workspace 的 `.vermillion/` 保存 `docs/`、`roles/`、`work-requests/`、`workitems/`、`decisions/`、`runs/` 和 `scheduler.json`。文档在 `.vermillion/docs/` 内，以 Git commit 作为工单引用依据；工作台运行记录通过领域服务写入。

每张工单持久化为一份 `WorkItemRecord`，包含合同与业务进度 `item`、当前执行过程 `execution`、合入检查点 `integrations` 和回收候选 `cleanup`。执行过程保存当前会话、消息投递、失败和重试状态，是恢复执行的唯一依据。工单查询中的 `run` 由 execution 投影，不单独持久化；`runs/` 中的历史记录只用于追溯。

`WorkspaceStore` 只负责记录查询和按工单串行的读改写事务；`WorkbenchService` 在事务内完成状态转换。持久化成功后统一发布工单和动作事件。取消事件先于通用更新事件送达，使本次取消触发的中断先于后续调度入队。查询投影不提供写入入口。

## 会话与执行环境

渲染订阅按可见 turn 路径限定，树成员关系不作为正文的订阅范围。后台内容仍由会话引擎保存，事件按批次接收；后台文本、终端输出和工具进度不触发当前 transcript 或 Composer 更新。运行、完成、失败、中断、审批和交互请求保持状态通知。切换路径时从最新投影读取内容，再订阅该路径的后续变化。输入草稿由输入器本地管理，与内容流的更新边界分开。

会话 cwd 保持 workspace 根目录。使用 worktree 时，Worker 在具体工具调用中显式指定 workdir、`git -C` 或文件绝对路径；工单流转与目录回收见[工单](../Workbench/Missions/PRD.md)。

会话历史与执行环境的生命周期分开。读取历史先检查引擎是否已加载会话；未加载时在 workspace 根恢复，读完退订临时加载的执行环境，不发送模型消息。已有活动执行保持运行。历史阅读不依赖工单 worktree 是否存在；已加载会话树内的节点跳转只保存查看位置，树模型见[思考](../Workbench/Think/PRD.md#会话树)。

`Orchestrator` 由工作台事件和 turn 完成通知驱动。合同更新通过 `runner.steer` 送达；若送达时存在活动 turn，其 id 写入 execution 的 `staleTurnId`，该 turn 结束后清除。标记未清时的提交按旧合同作废。Worker 不自行维护合同版本号。业务上的等待、重试和提交规则见[执行循环规范](../Workbench/Missions/Standards.md)。

## 桌面与 CLI

桌面与 CLI 使用同一工作台服务。桌面在 `<baseDir>/endpoint.json` 发布 loopback 端口，CLI 优先调用桌面服务；桌面未运行时在进程内运行同一个服务。

桌面启动时将 `vermillion` CLI 放入 `<baseDir>/bin` 并加入本进程 PATH，Codex 子进程继承该路径。角色文件解析与 developer 指令注入见[角色](../Workbench/Roles/PRD.md)。
