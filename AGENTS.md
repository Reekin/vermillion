# Vermillion

## 工作入口

- 产品行为从[产品总览](.vermillion/docs/Overview/PRD.md)进入；改实现前读取对应 PRD 与领域规范。
- 模块边界、状态所有权与持久化见[架构](.vermillion/docs/Foundation/Architecture.md)；执行约束见[执行循环规范](.vermillion/docs/Workbench/Missions/Standards.md)。
- 主导航为工作台、Inbox 与底部同级设置；工作台左侧会话列表常驻，右侧按会话、工单、Docs、Domain、角色、Issues、Automation 分页。会话筛选与 workspace 编辑范围分别管理；会话页切换时保留挂载和草稿。
- 界面改动先读[UI/UX 规范](.vermillion/docs/Foundation/UIUX/Standards.md)，复用 `apps/desktop/src/ui/app/components/ui.tsx` 和 `app.css` 的主题变量。
- 领域定义位于 `.vermillion/docs/domains/`；按[Domain 规则](.vermillion/docs/Workbench/Domains/PRD.md)选取规范。

## 运行与验证

- 开发：`pnpm dev`；正常启动及最终冷启动验收：`start.bat`。
- 主工作区开发者提交代码前运行 `pnpm -r --workspace-concurrency=1 typecheck` 与 `pnpm -r --workspace-concurrency=1 test`；界面改动另跑 `pnpm --filter @vermillion/desktop lint:ui`。Worker 按工单实际影响运行相关检查，复用未受影响的有效证据，跨包影响时才扩大检查范围；产品验收和真实用户路径仍按工单要求执行。
- 执行链路改动须真实跑通 工作台 → 会话 → New Chat → 发消息 → Docs 树变化 → 开工 → Worker 建单续跑；其他改动按受影响路径验收，纯文档改动检查内容、引用和链接。
- 验收使用隔离实例。Worker / Verifier 的所有验收（包括 rebase 后验证和最终冷启动）只能通过 `app.start / app.stop` 启停；开发者最终冷启动用 `start.bat`。端口与隐藏桌面操作见[开发与验收](docs/development.md)。
- CLI：先 `pnpm --filter @vermillion/workbench build`，再 `node packages/workbench/bin/vermillion.mjs <method> [json]`；参数使用 `<method> --help` 查询。
- 打包：`pnpm package`，产物位于 `release/vermillion-<version>-<stamp>/`。

## 修改约束

- 工作台运行记录通过服务与 CLI/RPC 更新，不直接编辑文件。
- 查询 Git 状态使用只读 `status -z`，不修改 index。
- 角色 prompt 开发以 `~/.vermillion/roles/` 为准；修改角色时先改对应全局文件，提交前同步到 `packages/workbench/roles/`。配置与覆盖规则见[角色](.vermillion/docs/Workbench/Roles/PRD.md)。
- 修改 UI 不在页面重复定义组件样式；会话区不反向引用应用壳业务，具体边界见架构和 UI 规范。
- 产品行为写业务 PRD，产品实现与项目工程约束写业务 Standards；角色动作、判断、交接与行为禁令写对应 role prompt。`.vermillion/docs/domains/` 只放领域定义和规范引用，不放规范正文。每条要求只在对应载体定义，其他位置链接引用。
- 不为兼容存量数据引入额外的读取或处理逻辑。需要迁移或修复存量数据时，提供独立的一次性 bat，由用户手动执行，不接入产品运行流程。脚本执行前说明影响；需要停止或重启用户实例的操作也由用户触发，Agent 不自行执行。

## git
所有commit subject / description全部使用英文。

## 经验积累

- 核对工单 evidence 时同时核对实际分支成果，不能把留在 stash 或未提交工作区的内容当作已交付。

- 设计领域维护能力时，分清领域身份、检查依据与角色执行指令，分别明确载体；多对象详情示意必须包含对象选择入口，不能用固定样例掩盖导航缺失。

- 审查 Agent 信息链路时，先核对程序注入、任务引用和交接材料各自承担什么；没有实际遗漏证据，不把可能的收集不足断言成传递断点，也不增设重复加载路径。
