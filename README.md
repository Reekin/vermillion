# Vermillion

个人 agent 工作台。讨论形成文档，从讨论节点开工，在同一棵会话树中查看 Worker 的执行，在 Inbox 处理决定和查看结果。

## 运行

- `start.bat`：构建并启动桌面应用
- `dev.bat`：开发模式（Vite HMR + Electron）

需要 Node >= 22、pnpm 10、PATH 里的 `git` 和 `codex`（也可用 `VERMILLION_CODEX_BIN` 指定）。

## 使用

1. 思考页底部 Composer 的 workspace 选择器里选「新建 workspace…」，挑一个项目目录。Vermillion 会在目录里初始化 git（若尚无）并创建 `.vermillion/docs/`。
2. 直接在 Composer 输入并发送：第一条消息发出时创建会话，cwd 是 workspace 根（设计伙伴能读整个项目），角色 prompt 作为 developer instructions 注入（追加在 codex config.toml 的 `developer_instructions` 之后），只会改 `.vermillion/docs/` 下的文件。
3. 右栏 Docs 树按文件夹显示 `.vermillion/docs/`；有改动的文件带 M/U/D 标记，点击可编辑，右键可在文件管理器或默认编辑器中打开。
4. 点右侧 Docs 底部的 **开工**，或说“把 ABC 开工做掉”：本轮结束后 fork 出 Worker 分支，由它整理和提交相关文档、建单，结束准备轮后等调度续跑。查看位置留在讨论节点；ChatTree 底部列出 Worker，点击查看对应分支。单独提交文档使用 Docs 右键菜单的 **Commit**。
5. **Inbox** 汇总所有 workspace 的决策卡和已合入结果。可以选择选项或自由答复，答复送回原 Worker；已合入结果可以确认或附理由回滚。
6. 左栏 **New Chat** 回到草稿态；会话列表按最近完成的 turn 排序，可切换为按 workspace 分组，可加载更多。
7. **Workspaces → 工单** 按来源会话树分组，展示调度开关、并发上限、进度与等待原因。Worker 自行判断是否使用 worktree，完成 review 和独立验证后提交，由工作台合入并关闭工单。后台每 5 分钟回收不再使用的 worktree，目录占用不影响工单完成。
9. **Workspaces → Domain** 列出 `.vermillion/docs/domains/` 下的领域定义，可新建和编辑；Worker 建单时据此附上相关规范。**Workspaces → 角色** 编辑设计伙伴、Worker、Maintainer、Liaison 及 Reviewer、Verifier 的角色配置。全局版本在 `~/.vermillion/roles/`；workspace 可以覆盖或追加。

## CLI

```
pnpm --filter @vermillion/workbench build
node packages/workbench/bin/vermillion.mjs --help
node packages/workbench/bin/vermillion.mjs workspace.list
node packages/workbench/bin/vermillion.mjs workItem.submit '{"workspaceId":"...","workItemId":"...","evidence":{...},"review":[],"verify":{...}}'
node packages/workbench/bin/vermillion.mjs worktree.list '{"workspaceId":"..."}'
node packages/workbench/bin/vermillion.mjs worktree.cleanup '{"workspaceId":"..."}'
```

CLI 与桌面共用同一个服务和方法表；CLI 的写入会通过文件监听实时反映到桌面。

## 数据位置

- 全局：`~/.vermillion/`（workspace 注册表、会话索引、`roles/` 角色 prompt）
- 每个 workspace：`<root>/.vermillion/`：`docs/`（真相源，走 git）、`roles/`（角色 prompt 覆盖）、`work-requests/`（开工请求）、`workitems/`（每张工单的合同、执行过程和合入检查点）、`decisions/`（决策）、`runs/`（历史运行记录）、`scheduler.json`。工单和过程查询共享同一份存储记录。Worker 按需创建独立 worktree 并在工单登记位置。工作台运行记录排除在 git 之外。

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
