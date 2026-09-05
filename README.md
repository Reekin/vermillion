# Vermillion

个人 agent 工作台。你只在两处出现：和设计伙伴聊出 Spec，以及在 Inbox 里朱批决策卡和验收工单。

## 运行

- `start.bat`：构建并启动桌面应用
- `dev.bat`：开发模式（Vite HMR + Electron）

需要 Node >= 22、pnpm 10、PATH 里的 `git` 和 `codex`（也可用 `VERMILLION_CODEX_BIN` 指定）。

## 使用

1. 思考页底部 Composer 的 workspace 选择器里选「新建 workspace…」，挑一个项目目录。Vermillion 会在目录里初始化 git（若尚无）并创建 `.vermillion/docs/`。
2. 直接在 Composer 输入并发送：第一条消息发出时创建会话，cwd 是 `<root>/.vermillion`，设计伙伴的角色 prompt 作为 developer instructions 注入（追加在 codex config.toml 的 `developer_instructions` 之后），只会改 `docs/` 下的文件。
3. 右栏 Docs 树按文件夹显示 `.vermillion/docs/`；有改动的文件带 M/U/D 标记，点击可编辑，右键可在文件管理器或默认编辑器中打开。
4. 点 **提交变更**：选「新任务」或「补充到现有任务」，勾选本次要提交的文件；每次提交是任务的一个 revision，管家据此判断拆单、调整还是重发。
5. **Inbox** 汇总所有 workspace 的决策卡（选一个选项即回答）和待验收工单（通过 / 打回并写原因 / 不做），并展示证据包与验收结果。
6. 左栏 **New Chat** 回到草稿态；会话列表按最近完成的 turn 排序，可切换为按 workspace 分组，可加载更多。
7. **Workspaces → 任务** 顶部打开调度后，提交的 revision 会自动触发管家拆单、Worker 在 worktree 里实现并自验、Supervisor 每 turn 盯方向；每个任务和工单下面列出跑过它的 agent 运行记录，都能点「会话」看现场。Inbox 里「通过」会把 Worker 的分支合进 workspace。
8. 在思考里提"打包""跑测试"这类不改设计的操作请求，设计伙伴会直接建一张独立工单进入队列，不写文档、不经管家；任务页底部有「独立工单」分组。
9. **Workspaces → Domain** 列出所有角色 prompt（设计伙伴、管家、Worker、Supervisor、Maintainer、Liaison、Reviewer、Verifier）及其来源。全局版本在 `~/.vermillion/roles/` 直接改文件；点「覆盖」在本 workspace 的 `.vermillion/roles/` 写一份覆盖版本，「恢复全局」删除覆盖。

## CLI

```
pnpm --filter @vermillion/workbench build
node packages/workbench/bin/vermillion.mjs --help
node packages/workbench/bin/vermillion.mjs workspace.list
node packages/workbench/bin/vermillion.mjs workItem.submit '{"workspaceId":"...","workItemId":"...","evidence":{...},"review":[],"verify":{...}}'
```

CLI 与桌面共用同一个服务和方法表；CLI 的写入会通过文件监听实时反映到桌面。

## 数据位置

- 全局：`~/.vermillion/`（workspace 注册表、会话索引、`roles/` 角色 prompt）
- 每个 workspace：`<root>/.vermillion/`：`docs/`（真相源，走 git）、`roles/`（角色 prompt 覆盖）、`missions/` `workitems/` `decisions/` `runs/`（一条一 JSON）、`scheduler.json`、`worktrees/`（Worker 分支）。除 docs 外都通过 `.git/info/exclude` 排除在 git 之外。

## 结构

```
packages/shared        会话引擎契约（zod）
packages/core          会话领域存储与投影
packages/adapters      运行时适配（codex app-server）
packages/workbench     工作台领域 + typed RPC + CLI
apps/desktop-server    会话引擎宿主（Electron main 进程内）
apps/desktop           Electron 壳：SessionPane（会话）+ 应用壳（侧栏 / Docs / Inbox / Workspaces）
```

## 打包

```
pnpm package
```

产物在 `release/vermillion-<version>-<时间戳>/`：`Vermillion.exe`、`vermillion-cli.cmd`、`resources/app/`（main/preload 与 renderer 构建、单文件 CLI）。目录可整体拷走运行，不需要 node_modules；CLI 需要 PATH 里有 node。
