# Vermillion

## 运行与验证
- 开发：`pnpm dev`（Vite 4193 + Electron）。验收用 `VERMILLION_REMOTE_DEBUGGING_PORT=9333` 启动后走 CDP；隔离数据用 `VERMILLION_PERSISTENCE_BASE_DIR` + `VERMILLION_USER_DATA_DIR`（后者绕开 single-instance lock，允许与用户正在运行的实例并存）。
- `start.bat` 会在源码比 `dist-web`/`dist-electron` 新时自动重新 build（`scripts/needs-build.mjs`）。交付前必须用 `start.bat` 而不是 dev 模式做最终验收。
- 提交前：`pnpm -r --workspace-concurrency=1 typecheck` 与 `pnpm -r --workspace-concurrency=1 test` 全绿，并做一次真实冷启动跑通 New Chat → 发消息 → docs 树变化 → 创建任务。
- CLI：`node packages/workbench/bin/vermillion.mjs <method> [json]`（需先 `pnpm --filter @vermillion/workbench build`）。桌面与 CLI 共用同一个 `WorkbenchService` 和同一张方法表。

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
- 全局 `~/.vermillion/`：workspace 注册表（引擎的 `workspace-registry.json` 是唯一注册表）、会话索引。
- 每个 workspace `<root>/.vermillion/`：`AGENTS.md`（设计伙伴规则）、`docs/`（真相源，走 git）、`missions/` `workitems/` `decisions/`（一条一 JSON）。
- 思考会话 cwd = `<root>/.vermillion`。Doc 只允许在 `.vermillion/docs/` 下。查询 git 状态只读（`status -z`），不碰 index。

## 工单
- Mission 是 Doc revision 的序列；commit 只能通过 `mission.create` / `mission.addRevision` 产生，支持部分路径提交。一个会话可以产出多个任务或给已有任务补 revision。
- 状态：queued → running → review → closed，decision 为挂起。写操作有业务含义：create / start / heartbeat / submit(evidence+review+verify) / approve / reject(reason) / cancel，不暴露裸 status 修改。
- submit 时 verify 通过且 autoClose（R0/R1 默认）直接 closed；rework 回 queued；否则进 review。

## UI 规范
- 所有控件复用 chat-shell 的 CSS 变量与 `Button`：3-5px 圆角、hairline、单色、等宽大写区块标题。token 在 `ui/app/app.css`。
- 思考是主页；Inbox / Workspaces 先以 `Modal` 打开，"展开为页面"后占据主区域。切换面板不卸载思考页。
- 不用红色或高饱和色。
