# Vermillion

个人 agent 工作台。你只在两处出现：和设计伙伴聊出 Spec，以及在 Inbox 里朱批决策卡和验收工单。

## 运行

- `start.bat`：构建并启动桌面应用
- `dev.bat`：开发模式（Vite HMR + Electron）

需要 Node >= 22、pnpm 10、以及 PATH 里能找到 `codex`（也可通过 `VERMILLION_CODEX_BIN` 指定）。

## 使用

1. 左侧 rail 点 **Workspaces**，用 + 添加一个项目目录。Vermillion 会在目录里初始化 git（若尚无）并写入 `.vermillion/AGENTS.md`（设计伙伴的工作规则）。
2. 回到 **思考**，左上角选 workspace，在 SESSIONS 里按 + 新建会话，和设计伙伴聊需求。它的 cwd 是 `<root>/.vermillion`，只会改 `docs/` 下的文件。
3. 右栏 **待确认变更** 会列出 `.vermillion/docs/` 的改动；点文件名可直接编辑并保存。
4. 点 **创建任务**：docs/ 改动被提交为一个 commit，任务绑定该 commit 与当前会话。
5. **Inbox** 汇总所有 workspace 的决策卡（选一个选项即回答）和待验收工单（通过 / 打回）。

## 数据位置

- 全局：`~/.vermillion/`（workspace 注册表、会话索引）
- 每个 workspace：`<root>/.Vermillion/`（missions / workitems / decisions / issues，一条一个 JSON），`<root>/.vermillion/docs/`（真相源文档，走 git）

## 结构

```
packages/shared        会话引擎契约（zod）
packages/core          会话领域存储与投影
packages/adapters      运行时适配（codex app-server）
packages/workbench     工作台领域：Workspace / Doc / Mission / WorkItem / DecisionCard / Inbox，文件持久化，typed RPC
apps/desktop-server    会话引擎宿主（Electron main 进程内）
apps/desktop           Electron 壳 + renderer（思考页内嵌会话工作台，Inbox / Workspaces 面板）
```

## 命令

```
pnpm typecheck      # 全部包类型检查
pnpm test           # 全部包单测
pnpm dev            # 开发模式
```
