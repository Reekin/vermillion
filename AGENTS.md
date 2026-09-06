# Vermillion

## 运行与验证
- 开发：`pnpm dev`（Vite 4193 + Electron）。验收用 `VERMILLION_REMOTE_DEBUGGING_PORT=9333` 启动后走 CDP；隔离数据用 `VERMILLION_PERSISTENCE_BASE_DIR` + `VERMILLION_USER_DATA_DIR`（后者绕开 single-instance lock，允许与用户正在运行的实例并存）。
- `start.bat` 会在源码比 `dist-web`/`dist-electron` 新时自动重新 build（`scripts/needs-build.mjs`）。交付前必须用 `start.bat` 而不是 dev 模式做最终验收。
- 提交前：`pnpm -r --workspace-concurrency=1 typecheck` 与 `pnpm -r --workspace-concurrency=1 test` 全绿，并做一次真实冷启动跑通 New Chat → 发消息 → docs 树变化 → 创建任务。
- CLI：`node packages/workbench/bin/vermillion.mjs <method> [json]`（需先 `pnpm --filter @vermillion/workbench build`）。桌面运行时在 `<baseDir>/endpoint.json` 发布 loopback 端口，CLI 优先经它调用桌面内的服务；桌面未运行时 CLI 在进程内跑同一个服务。
- 打包：`pnpm package` 生成 `release/vermillion-<version>-<stamp>/`（Vermillion.exe + resources/app + vermillion-cli.cmd），不含 node_modules。

## 分层
- `packages/shared` / `core` / `adapters` / `apps/desktop-server`：会话引擎（codex app-server 适配、会话/turn 投影、会话浏览查询）。标识符前缀 `Session*`。
- `packages/workbench`：工作台领域（Workspace / Doc / Mission / WorkItem / DecisionCard / Inbox）。标识符前缀 `Workbench*`。renderer 只能引用 `@vermillion/workbench/client`。
- `apps/desktop/src/ui/chat-shell`：`SessionPane`（transcript + composer + 会话打开/切换/审批），props 只有 `store / transport / sessionId / createSession / composerExtras`。它不拥有侧栏和右栏。
- `apps/desktop/src/ui/app`：应用壳。侧栏（会话分页查询）、Docs 树、Inbox、Workspaces、workspace 选择都在这里。

## 状态与事件
- workspace 有三种含义，分开存：`draftWorkspaceId`（New Chat 用，composer 里选）、会话自带的 workspaceId（来自引擎）、`browsingWorkspaceId`（Docs 面板用，跟随打开的会话，草稿态跟随 draft）。
- 领域层每次写操作 emit `WorkbenchEvent`；`.vermillion/` 目录有 fs 监听，CLI/agent 的外部写入产生同样的事件。UI 只订阅事件，禁止轮询。
- 查询结果带 workspaceId，store 丢弃与当前 browsing 不匹配的响应。

## 持久化
- 全局 `~/.vermillion/`：workspace 注册表（引擎的 `workspace-registry.json` 是唯一注册表）、会话索引、`roles/<role>.md`（角色 prompt 的全局版本）。
- 每个 workspace `<root>/.vermillion/`：`docs/`（真相源，走 git）、`roles/`（角色 prompt 的 workspace 覆盖）、`missions/` `workitems/` `decisions/`（一条一 JSON）。
- 所有 agent 会话 cwd = workspace 根（Worker 在 worktree 时是 worktree 根）；写边界靠角色 prompt、`allowedPaths` 和 Supervisor，不靠 cwd。Doc 只允许在 `.vermillion/docs/` 下。查询 git 状态只读（`status -z`），不碰 index。

## 角色 prompt
- 默认版本是 `packages/workbench/roles/<role>.md`（打包后在 `resources/app/roles/`）。启动时 `RoleService.ensureGlobal` 把缺失的角色补到 `~/.vermillion/roles/`；已存在的不覆盖。开发期间以 `~/.vermillion/roles/` 为准（用户直接改那里），提交前 `cp ~/.vermillion/roles/*.md packages/workbench/roles/` 反向同步。
- 解析顺序：`<root>/.vermillion/roles/<role>.md` → `~/.vermillion/roles/<role>.md`。RPC：`role.list / read / write / reset`；Workspaces → Domain 页编辑的是 workspace 覆盖。
- 注入方式：会话 metadata 带 `developerInstructions`，runtime port 在 `thread/start` 时读 codex `config/read` 的 `developer_instructions` 并追加角色文本，不覆盖用户 config.toml 里的配置。思考会话注入 `design-partner`。

## 调度（packages/workbench/src/orchestrator.ts）
- 三个循环都在 `Orchestrator` 里，靠 `WorkbenchEvent` 和 `turn.completed` 驱动，状态只在 `.vermillion/` 文件里（`scheduler.json`、`runs/`、工单的 `run` 段）；进程重启后 `reconcile` 从文件恢复，未完成的 run 标 failed、工单退回队列。
- 管家：`missions.changed` 后找最新 revision 没有 steward run 的任务，开一个 cwd = workspace 根的会话，首条消息带 revision diff 与现有工单。同一任务已有管家会话在跑时，新消息 steer 进那个会话（run 的 revision 前移），不另开。工单被取消且有排队工单 `dependsOn` 它时，也用同样方式叫醒该任务的管家，附上受影响工单，由它决定去掉依赖、换依赖或一并取消。
- 调度器：`workItems.changed` / `decisions.changed` / worker turn 结束后取单；上限 `scheduler.maxWorkers`；attempts ≥ 3 不再取。取单还要求 `dependsOn`（同任务内的工单 id，创建时校验）全部 closed，且 `needs`（执行资源名，如 browser）没有被 running 的工单占用（每种资源一个槽位）。挂在决策卡上的工单是 `decision` 状态，不占并发，也不会被取。有 missionId 且有 allowedPaths 的工单在 `.vermillion/worktrees/<id>` + 分支 `vermillion/<id>` 里跑，其余在 workspace 根。approve 时 merge 分支并删 worktree，cancel 直接删。
- 工单有 `contractVersion`，每次 `workItem.update` 加一；`workItem.submit` 必须带 worker 依据的版本，不等于当前版本就作废（工单回 queued、丢弃 evidence，保留 worktree）。update 对进行中的工单发 `workItem.updated`，编排层用 `runner.steer`（有活跃 turn 就 `turn/steer`，否则作为下一条消息）立即通知 worker，idle 计数归零。`workItem.cancel` 对进行中的工单发 `workItem.cancelled`，编排层 interrupt 该会话。
- `decision.create` 只把 running 的工单转为 decision；`decision.answer` 只把 decision 的转回 queued，其他状态不动。
- Supervisor：每个 worker turn 结束且工单仍 running 时调用，一个任务一个会话；回复 `none | remind: … | interrupt: …`。超过 `maxIdleTurns` 未提交则 requeue。
- 调度开关和运行记录在 Workspaces → 任务 页；Automation 页留给用户自定义的定时/触发任务，与这套循环无关。
- `AgentRunner`（apps/desktop/src/electron/agent-runner.ts）是编排层对会话引擎的唯一依赖：open / send / interrupt / lastReply / onTurnCompleted。agent 会话 metadata 带 `role`、`workItemId`、`missionId`。
- 启动时把 `vermillion` CLI 放到 `<baseDir>/bin` 并加进本进程 PATH，codex 子进程继承，agent 直接 `vermillion <method> [json]`。

## 工单
- 独立工单：无 missionId、无 refs，用于打包、跑测试这类不改文档的操作；设计伙伴在聊天里直接 `workItem.create`，不经管家。
- Mission 是 Doc revision 的序列；commit 只能通过 `mission.create` / `mission.addRevision` 产生，支持部分路径提交。一个会话可以产出多个任务或给已有任务补 revision。
- 状态：queued → running → review → closed，decision 为挂起，cancelled 是另一个终态（`cancelWorkItem`）。只有 closed 满足 `dependsOn`；前置 cancelled 的工单留在队列并在任务页标出。写操作有业务含义：create / start / heartbeat / submit(evidence+review+verify) / approve / reject(reason) / cancel，不暴露裸 status 修改。
- submit 时 verify 通过且 autoClose（R0/R1 默认）直接 closed；rework 回 queued；否则进 review。

## UI 规范
- 所有控件复用 chat-shell 的 CSS 变量与 `Button`：3-5px 圆角、hairline、单色、等宽大写区块标题。token 在 `ui/app/app.css`。
- 思考是主页；Inbox / Workspaces 先以 `Modal` 打开，"展开为页面"后占据主区域。切换面板不卸载思考页。
- 不用红色或高饱和色。
