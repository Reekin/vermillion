# Vermillion

## 运行与验证
- 开发：`pnpm dev`（Vite 4193 + Electron）。验收用 `VERMILLION_REMOTE_DEBUGGING_PORT=9333` 启动后走 CDP；隔离数据用 `VERMILLION_PERSISTENCE_BASE_DIR` + `VERMILLION_USER_DATA_DIR`（后者绕开 single-instance lock，允许与用户正在运行的实例并存）。
- `start.bat` 会在源码比 `dist-web`/`dist-electron` 新时自动重新 build（`scripts/needs-build.mjs`）。交付前必须用 `start.bat` 而不是 dev 模式做最终验收。
- 提交前：`pnpm -r --workspace-concurrency=1 typecheck` 与 `pnpm -r --workspace-concurrency=1 test` 全绿，并做一次真实冷启动跑通 New Chat → 发消息 → docs 树变化 → 开工 → Worker 建单续跑。
- CLI：`node packages/workbench/bin/vermillion.mjs <method> [json]`（需先 `pnpm --filter @vermillion/workbench build`）。桌面运行时在 `<baseDir>/endpoint.json` 发布 loopback 端口，CLI 优先经它调用桌面内的服务；桌面未运行时 CLI 在进程内跑同一个服务。
- 打包：`pnpm package` 生成 `release/vermillion-<version>-<stamp>/`（Vermillion.exe + resources/app + vermillion-cli.cmd），不含 node_modules。

## 分层
- `packages/shared` / `core` / `adapters` / `apps/desktop-server`：会话引擎（codex app-server 适配、会话/turn 投影、会话浏览查询）。标识符前缀 `Session*`。
- `packages/workbench`：工作台领域（Workspace / Doc / 开工 / WorkItem / DecisionCard / Inbox）。标识符前缀 `Workbench*`。renderer 只能引用 `@vermillion/workbench/client`。
- `apps/desktop/src/ui/chat-shell`：`SessionPane` 负责 transcript、composer、会话打开/切换/审批。应用壳通过展示数据、渲染插槽和回调接入业务；会话区不引用应用壳的 Context 或工作台业务类型，不自行查询工单。
- `apps/desktop/src/ui/app`：应用壳。侧栏、Docs 树、Inbox、Workspaces、workspace 选择都在这里。思考页列用户的会话树；从讨论 fork 出的 Worker 在树底部列表进入，选中后显示对应分支。冷启动的 Worker 在 Workspaces → 会话 阅读。工单和 Inbox 的会话入口按来源导航到相应位置。
- 界面开发从 `apps/desktop/src/ui/app/components/ui.tsx`（组件入口）和 `app.css` 的 `@theme`（变量）开始，规则见 `.vermillion/docs/Foundation/UIUX/Standards.md`。`pnpm --filter @vermillion/desktop lint:ui` 拦硬编码颜色/任意字号/`awb-*`/裸表单控件；会话区 `ui/chat-shell` 保留 `awb-*`，turn 扩展块用 `app.css` 的 `vm-*`。

## 状态与事件
- workspace 有三种含义，分开存：`draftWorkspaceId`（New Chat 用，composer 里选）、会话自带的 workspaceId（来自引擎）、`browsingWorkspaceId`（Docs 面板用，跟随打开的会话，草稿态跟随 draft）。
- 领域层每次写操作 emit `WorkbenchEvent`；`.vermillion/` 目录有 fs 监听，CLI/agent 的外部写入产生同样的事件。UI 只订阅事件，禁止轮询。
- 工单状态由 `WorkbenchService` 在整份 `WorkItemRecord` 事务内转换，提交后统一发布工单和动作事件。`WorkspaceStore` 只负责记录查询与串行事务，查询投影不提供写入口。
- 查询结果带 workspaceId，store 丢弃与当前 browsing 不匹配的响应。

## 持久化
- 全局 `~/.vermillion/`：workspace 注册表（引擎的 `workspace-registry.json` 是唯一注册表）、会话索引、`roles/<role>.md`（角色 prompt 的全局版本）。
- 每个 workspace `<root>/.vermillion/` 保存 `docs/`（真相源，走 git）、`roles/`（角色 prompt 的 workspace 覆盖）、开工、工单、决策和运行记录。运行记录通过服务与 CLI/RPC 更新，不直接编辑文件。
- 所有 agent 会话 cwd = workspace 根；Worker 使用 worktree 时在工具调用中显式指定 workdir、git -C 或文件绝对路径。`allowedPaths` 限定修改范围，是否使用 worktree 由 Worker 判断并登记。Doc 只允许在 `.vermillion/docs/` 下。查询 git 状态只读（`status -z`），不碰 index。
- 单张工单的合同、执行过程与合入检查点保存在统一记录中，执行过程是当前运行状态的唯一来源。工单查询里的 `run` 由执行过程投影，不单独持久化；历史运行记录只用于追溯。

## 角色 prompt
- 默认版本是 `packages/workbench/roles/<role>.md`（打包后在 `resources/app/roles/`）。启动时 `RoleService.ensureGlobal` 把缺失的角色补到 `~/.vermillion/roles/`；已存在的不覆盖。开发期间以 `~/.vermillion/roles/` 为准（用户直接改那里），提交前 `cp ~/.vermillion/roles/*.md packages/workbench/roles/` 反向同步。
- 解析顺序：`<root>/.vermillion/roles/<role>.md` → `~/.vermillion/roles/<role>.md`。RPC：`role.list / read / write / reset`；Workspaces → 角色 页编辑的是 workspace 覆盖。
- 注入方式：会话 metadata 带 `developerInstructions`，runtime port 在 `thread/start` 时读 codex `config/read` 的 `developer_instructions` 并追加角色文本，不覆盖用户 config.toml 里的配置。思考会话注入 `design-partner`。

## 调度（packages/workbench/src/orchestrator.ts）
- `Orchestrator` 由 `WorkbenchEvent` 和 `turn.completed` 驱动，状态持久化在工作台。开工先登记请求，来源 turn 结束后从那个节点 fork Worker，保留讨论上下文，不主动 compact。
- Worker 准备轮先提交相关文档、建单、按需自行创建并登记 worktree，结束后才进入执行队列。调度器排到它时在 workspace 根恢复原会话，发送工单合同续跑。多单的其他执行者从准备轮末端 fork。
- 取单遵守 `scheduler.maxWorkers`、全部已关闭的 `dependsOn` 和 `needs` 中的具体共享资源。独立浏览器、桌面不按工具类别互斥。等待用户不占执行并发；前置取消时说明原因交用户决定。
- `workItem.update` 对进行中的工单发 `workItem.updated`，编排层用 `runner.steer`（有活跃 turn 就 `turn/steer`，否则作为下一条消息）立即通知 worker，idle 计数归零。若送达时正有一轮在跑，那轮的 id 记在 `run.staleTurnId`，该轮结束时清掉；`staleTurnId` 未清时到达的 `workItem.submit` 视为依据旧合同，作废（工单回 queued、丢弃 evidence，保留 worktree）。worker 不维护任何版本号。`workItem.cancel` 对进行中的工单发 `workItem.cancelled`，编排层 interrupt 该会话。
- 决策答复直接送回原 Worker，普通文字答复同样有效。review 或验证两轮不过就等待用户，不无限返工。运行失败保留原会话和成果，按 1、5、30、300 分钟重试四次，再失败发决策卡；`maxIdleTurns` 限制无进展续轮。
- 调度开关和运行记录在 Workspaces → 工单 页；Automation 页用于用户自定义定时或触发任务。
- `AgentRunner`（apps/desktop/src/electron/agent-runner.ts）是编排层对会话引擎的边界，提供 fork、打开、恢复、发送、steer、中断与 turn 完成通知。Worker metadata 保存角色、工单与来源信息。
- 启动时把 `vermillion` CLI 放到 `<baseDir>/bin` 并加进本进程 PATH，codex 子进程继承，agent 直接 `vermillion <method> [json]`。

## 验收实例
- `app.start` / `app.stop`（RPC 和 CLI）通过 `AppLauncher` 起一个独立数据目录、独立 userData、指定 CDP 端口的 Vermillion 实例。Windows 上经 `packages/workbench/scripts/start-on-hidden-desktop.ps1` 用 `CreateDesktop` + `CreateProcess(lpDesktop)` 放到桌面 `vermillion-qa`，窗口、弹窗、焦点都不会出现在用户屏幕；CDP 和截图照常。`port` 要避开 Windows 保留端口区间（`netsh interface ipv4 show excludedportrange protocol=tcp`，9323–9422 等常被占，含 9333），否则 Electron 开不了调试端口、app.start 等 30 秒后报错。发布包里脚本在 `resources/app/scripts/`，可执行文件取 `Vermillion.exe`，仓库里取 electron + `dist-electron/main.js`。
- Worker / Verifier 做界面验收只能用这条路径，不用 start.bat。

## Domain
- 领域定义是普通文档：`.vermillion/docs/domains/<id>.md`，正文自然语言说明覆盖范围和触发条件，frontmatter `standards:` 列规范文档路径。Worker 建单时读全部定义，语义判断工单涉及哪些领域，把相应 standards 作为 refs 附上。Workspaces → Domain 页列出并编辑这个目录。

## 工单
- 发单模式的执行入口是 `work.start`；Worker 通过 `workItem.create` 建单并登记执行会话，文档使用 `docs.commit` 按相关路径提交，refs 保存文档路径、段落和 commit。现做模式直接完成实现，不为同一件事再开工。
- 工单记录准备、排队、执行、等待合入、等待用户和结束状态；只有已关闭满足依赖。submit 接收 evidence、review 和 verify，验证通过后由工作台串行合入并关闭；Inbox 展示结果并支持附理由回滚。
- 引用文档出现新提交时通知 Worker 并更新引用；变更送达那一轮的旧提交作废，保留成果后按新合同续跑。
- 合入成功即关闭工单；Worker turn 结束后退订执行环境，后台每 5 分钟回收已登记且不再使用的 worktree。占用或删除失败保留候选等待下次，不阻塞工单完成。登记、复用和回收共享工作区串行边界。

## UI 规范
- 所有控件复用 chat-shell 的 CSS 变量与 `Button`：3-5px 圆角、hairline、单色、等宽大写区块标题。token 在 `ui/app/app.css`。
- 思考是主页；Inbox / Workspaces 先以 `Modal` 打开，"展开为页面"后占据主区域。切换面板不卸载思考页。
- 不用红色或高饱和色。

## 经验积累

- 值夜守工单时，approve 前先在主仓 `git merge-tree --write-tree master <branch>` 探一次冲突（worktree 有未提交内容就先用临时 index 做一个 commit-tree 再探）；有冲突直接 reject 让原 Worker rebase，比事后合并失败再收拾干净得多。Worker 提交的 evidence 也要对照分支实际内容核一遍，曾出现改动留在 stash 而分支上没有的情况。
- Worker 的运行失败达到自动重试上限后会挂到 attempts 决策卡；额度恢复后回答 retry，让它从原会话与工作目录续做。
