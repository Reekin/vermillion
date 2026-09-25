# 开发与验收

所有验收统一遵循[验收实例隔离与清理规范](../.vermillion/docs/Foundation/Acceptance/Standards.md)。

启动、检查和打包命令见[AGENTS.md](../AGENTS.md#运行与验证)。一键启动入口 Windows 为 `start.bat`，macOS 为 `start.command`，都会在源码更新后自动构建。

新 worktree 第一次运行检查前执行 `pnpm prepare:worktree -- --worktree "<worktree>"`，或执行 `prepare-worktree.bat "<worktree>"`。准备完成条件见[开发环境准备](../.vermillion/docs/Foundation/Development/PRD.md)。

Worker / Verifier 通过 `app.start / app.stop` 启停实例，先用单方法 `--help` 查询目标、候选与隔离参数，显式指定被测 checkout 或发布目录。按启动结果的 CDP 地址与定向 CLI 调用信息操作，目标与生命周期规则见[隔离实例准备](../.vermillion/docs/Foundation/Acceptance/PRD.md)。

需要固定会话列表父子关系时，启动参数选择 `fixture: "session-tree"`，使用返回的 `projectPath`、`workspaceId` 与连接信息。

需要真实发送、fork 或 Worker 时，启动参数选择 `fixture: "real-session"`；指定配置来源可加 `codexConfigSource`。从返回的测试 workspace 创建真实会话与本单场景，外部引擎 CLI 复用启动结果的完整隔离环境；重启沿用同一 dataDir。准备行为、返回字段与隔离边界见[隔离实例准备](../.vermillion/docs/Foundation/Acceptance/PRD.md)。

窗口隐藏／恢复使用 `vermillion app.window '{"pid":<本次实例pid>,"action":"minimize"}'` 或 `restore`，查询用 `status`；随后经 CDP 核对页面可见性及目标行为。最终仍通过 `app.stop` 结束实例。

手动冷启动时，`VERMILLION_PERSISTENCE_BASE_DIR` 隔离工作台数据，`VERMILLION_USER_DATA_DIR` 隔离 Electron userData 并绕开 single-instance lock，`VERMILLION_REMOTE_DEBUGGING_PORT` 指定 CDP 端口。独立启动应清除继承的 npm/pnpm 生命周期环境变量，避免启动命令递归或错误解析工作目录。

Windows 先用 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查保留端口，再选择未被保留且未占用的端口；不要固定假设 9333 可用。端口无法监听时，`app.start` 等待约 30 秒后返回失败。

验收实例的窗口和焦点不影响用户，操作与截图走 CDP。Windows 上实例运行在独立隐藏桌面；macOS 上实例作为后台应用运行，窗口排在所有窗口之后，需要用户已登录的图形会话。macOS 实例不获得系统焦点，验收页面焦点相关行为时用 CDP `Emulation.setFocusEmulationEnabled` 模拟页面焦点。平台行为见[隔离实例准备](../.vermillion/docs/Foundation/Acceptance/PRD.md#窗口隔离)。

macOS 从 Finder 或 Dock 打开的应用会读取登录 shell 的 PATH，Homebrew、npm 安装的 `codex`、`node`、`git` 可直接找到。打包产物经过 ad hoc 签名，从其他机器拷来的包首次打开前执行 `xattr -dr com.apple.quarantine Vermillion.app`。

输入订阅的 Electron DOM 回归：在仓库根运行 `node apps/desktop/tests/renderer-selection-smoke.mjs`，检查后台交替输出、可见路径切换、审批与完成通知和草稿保留。

会话列表滚动的 Electron DOM 回归：在仓库根运行 `node apps/desktop/tests/session-sidebar-scroll-smoke.mjs`，检查打开会话时定位到该行、其他会话重排不移动视口、当前会话置顶后视口跟随。

界面验收结束后关闭对应的 agent-browser session，并通过 `app.stop` 停止本次实例，核实调试端口已释放。
