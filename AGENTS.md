# Vermillion

## 工作入口

- 产品行为从[产品总览](.vermillion/docs/Overview/PRD.md)进入；改实现前读取对应 PRD 与领域规范。
- 模块边界、状态所有权与持久化见[架构](.vermillion/docs/Foundation/Architecture.md)；执行约束见[执行循环规范](.vermillion/docs/Workbench/Missions/Standards.md)。
- 界面改动先读[UI/UX 规范](.vermillion/docs/Foundation/UIUX/Standards.md)，复用 `apps/desktop/src/ui/app/components/ui.tsx` 和 `app.css` 的主题变量。
- 领域定义位于 `.vermillion/docs/domains/`；按[Domain 规则](.vermillion/docs/Workbench/Domains/PRD.md)选取规范。

## 运行与验证

- 开发：`pnpm dev`；正常启动及最终冷启动验收：`start.bat`。
- 提交代码前运行 `pnpm -r --workspace-concurrency=1 typecheck` 与 `pnpm -r --workspace-concurrency=1 test`；界面改动另跑 `pnpm --filter @vermillion/desktop lint:ui`。
- 执行链路改动须真实跑通 New Chat → 发消息 → Docs 树变化 → 开工 → Worker 建单续跑；其他改动按受影响路径验收，纯文档改动检查内容、引用和链接。
- 验收使用隔离实例。Worker / Verifier 只能通过 `app.start / app.stop` 启停；开发者最终冷启动用 `start.bat`。端口与隐藏桌面操作见[开发与验收](docs/development.md)。
- CLI：先 `pnpm --filter @vermillion/workbench build`，再 `node packages/workbench/bin/vermillion.mjs <method> [json]`；参数使用 `<method> --help` 查询。
- 打包：`pnpm package`，产物位于 `release/vermillion-<version>-<stamp>/`。

## 修改约束

- 工作台运行记录通过服务与 CLI/RPC 更新，不直接编辑文件。
- 查询 Git 状态使用只读 `status -z`，不修改 index。
- 角色 prompt 开发以 `~/.vermillion/roles/` 为准；修改角色时先改对应全局文件，提交前同步到 `packages/workbench/roles/`。配置与覆盖规则见[角色](.vermillion/docs/Workbench/Roles/PRD.md)。
- 修改 UI 不在页面重复定义组件样式；会话区不反向引用应用壳业务，具体边界见架构和 UI 规范。

## 经验积累

- 核对工单 evidence 时同时核对实际分支成果，不能把留在 stash 或未提交工作区的内容当作已交付。
