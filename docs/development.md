# 开发与验收

## 启动与命令

- `pnpm dev`：Vite 4193 与 Electron 开发实例。
- `start.bat`：正常启动；`scripts/needs-build.mjs` 检查源码与构建产物时间，必要时先构建。开发者交付前用此入口验证真实冷启动。
- `pnpm package`：生成 `release/vermillion-<version>-<stamp>/`，包含 `Vermillion.exe`、`resources/app/` 和 `vermillion-cli.cmd`，不包含 node_modules。
- `node packages/workbench/bin/vermillion.mjs <method> [json]`：调用工作台。先构建 workbench，方法参数用 `<method> --help` 查询。

## 隔离验收

Worker / Verifier 用 `vermillion app.start '{"dataDir":"<独立目录>","port":<可用端口>}'` 启动实例，按返回的 CDP 地址操作，用 `vermillion app.stop '{"pid":<返回的pid>}'` 结束实例。不要连接用户正在运行的验收无关实例。

手动冷启动时，`VERMILLION_PERSISTENCE_BASE_DIR` 隔离工作台数据，`VERMILLION_USER_DATA_DIR` 隔离 Electron userData 并绕开 single-instance lock，`VERMILLION_REMOTE_DEBUGGING_PORT` 指定 CDP 端口。独立启动应清除继承的 npm/pnpm 生命周期环境变量，避免启动命令递归或错误解析工作目录。

Windows 先用 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查保留端口，再选择未被保留且未占用的端口；不要固定假设 9333 可用。端口无法监听时，`app.start` 等待约 30 秒后返回失败。

Windows 的 `AppLauncher` 调用 `packages/workbench/scripts/start-on-hidden-desktop.ps1`，通过 `CreateDesktop` 与 `CreateProcess(lpDesktop)` 将实例放到 `vermillion-qa` 桌面。窗口、弹窗和焦点不出现在用户桌面，CDP 与截图仍可用。源码实例使用 Electron 与 `dist-electron/main.js`；发布包使用 `Vermillion.exe`，脚本位于 `resources/app/scripts/`。

界面验收结束后关闭对应的 agent-browser session，并通过 `app.stop` 停止本次实例，核实调试端口已释放。
