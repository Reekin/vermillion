# Vermillion

个人 agent 工作台。你只在两处出现：和设计伙伴聊出 Spec，以及在 Inbox 里朱批决策卡和验收工单。

## 运行

- `start.bat`：构建并启动桌面应用
- `dev.bat`：开发模式（Vite HMR + Electron）

需要 Node >= 22、pnpm 10、PATH 里的 `git` 和 `codex`（也可用 `VERMILLION_CODEX_BIN` 指定）。

## 使用

1. 思考页底部 Composer 的 workspace 选择器里选「新建 workspace…」，挑一个项目目录。Vermillion 会在目录里初始化 git（若尚无）并写入 `.vermillion/AGENTS.md`。
2. 直接在 Composer 输入并发送：第一条消息发出时创建会话，cwd 是 `<root>/.vermillion`，设计伙伴只会改 `docs/` 下的文件。
3. 右栏 Docs 树按文件夹显示 `.vermillion/docs/`；有改动的文件带 M/U/D 标记，点击可编辑，右键可在文件管理器或默认编辑器中打开。
4. 点 **提交变更**：选「新任务」或「补充到现有任务」，勾选本次要提交的文件；每次提交是任务的一个 revision，管家据此判断拆单、调整还是重发。
5. **Inbox** 汇总所有 workspace 的决策卡（选一个选项即回答）和待验收工单（通过 / 打回并写原因 / 不做），并展示证据包与验收结果。
6. 左栏 **New Chat** 回到草稿态；会话列表按最近完成的 turn 排序，可切换为按 workspace 分组，可加载更多。

## CLI

```
pnpm --filter @vermillion/workbench build
node packages/workbench/bin/vermillion.mjs --help
node packages/workbench/bin/vermillion.mjs workspace.list
node packages/workbench/bin/vermillion.mjs workItem.submit '{"workspaceId":"...","workItemId":"...","evidence":{...},"review":[],"verify":{...}}'
```

CLI 与桌面共用同一个服务和方法表；CLI 的写入会通过文件监听实时反映到桌面。

## 数据位置

- 全局：`~/.vermillion/`（workspace 注册表、会话索引）
- 每个 workspace：`<root>/.vermillion/`：`AGENTS.md`、`docs/`（真相源，走 git）、`missions/` `workitems/` `decisions/`（一条一 JSON）

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
