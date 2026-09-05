# Vermillion

## 运行与验证
- 开发：`pnpm dev`（Vite 4193 + Electron）。验收用 `VERMILLION_REMOTE_DEBUGGING_PORT=9333` 启动后走 CDP，隔离数据用 `VERMILLION_PERSISTENCE_BASE_DIR`。
- 提交前：`pnpm -r --workspace-concurrency=1 typecheck` 与 `pnpm -r --workspace-concurrency=1 test` 必须全绿。

## 边界
- `packages/shared` / `core` / `adapters` / `apps/desktop-server` 是会话引擎，来自 another-workbench；只做 Vermillion 需要的最小改动，不在里面放工作台领域逻辑。
- 工作台领域逻辑全部在 `packages/workbench`。renderer 只能引用 `@vermillion/workbench/client`（无 node 依赖），Electron main 引用 `@vermillion/workbench`。
- 两套 RPC 分离：会话引擎走 `window.workbench`（AWB 原协议），工作台走 `window.vermillion`（`packages/workbench/src/rpc.ts`）。
- 持久化只用 JSON/markdown 文件，不引入数据库。Doc 只允许在 `.vermillion/docs/` 下，agent 不得改 Doc 以外的文件。

## UI 规范
- Tailwind v4，token 定义在 `apps/desktop/src/ui/app/app.css`；颜色只用语义 token，字号只用 `text-micro/caption/label/body/title-sm/title/display-sm`。
- 会话工作台（`ui/chat-shell`）保留 AWB 的 CSS 体系，通过 `ChatShellApp` 的 slot props 嵌入，不直接改它的布局。
- 思考是主页；Inbox / Workspaces 先以 overlay 打开，"展开为页面"后才占据主区域。切换面板不卸载思考页。
