# 开发与验收

启动、检查和打包命令见[AGENTS.md](../AGENTS.md#运行与验证)。`start.bat` 会在源码更新后自动构建。

Worker / Verifier 用 `vermillion app.start '{"dataDir":"<独立目录>","port":<可用端口>}'` 启动实例，按返回的 CDP 地址操作，用 `vermillion app.stop '{"pid":<返回的pid>}'` 结束实例。不要连接用户正在运行的验收无关实例。

手动冷启动时，`VERMILLION_PERSISTENCE_BASE_DIR` 隔离工作台数据，`VERMILLION_USER_DATA_DIR` 隔离 Electron userData 并绕开 single-instance lock，`VERMILLION_REMOTE_DEBUGGING_PORT` 指定 CDP 端口。独立启动应清除继承的 npm/pnpm 生命周期环境变量，避免启动命令递归或错误解析工作目录。

Windows 先用 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查保留端口，再选择未被保留且未占用的端口；不要固定假设 9333 可用。端口无法监听时，`app.start` 等待约 30 秒后返回失败。

验收实例运行在独立隐藏桌面，窗口和焦点不影响用户，操作与截图走 CDP。

界面验收结束后关闭对应的 agent-browser session，并通过 `app.stop` 停止本次实例，核实调试端口已释放。
