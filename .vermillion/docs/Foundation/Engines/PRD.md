# 会话引擎

Vermillion 通过引擎运行会话。当前支持 Codex（`codex`，Codex app-server）和 pi（`pi`，`pi --mode rpc`）。引擎用 `engineId` 标识；会话记录创建时的 `engineId`，同一棵会话树的所有分支沿用它，不可更改。

## 设置

设置页提供三项：

- **新会话引擎**：下拉选择已注册的引擎。之后从零创建的会话使用该引擎，包括新建会话、Maintainer 巡检会话、Issue 讨论会话及其他由工作台自动发起的新会话。从已有会话 fork 出的会话沿用源会话树的引擎：开工准备分支、Worker、`asksource` 临时会话与普通分支都是在某个位置上 fork 出来的，因此跟随源会话引擎而不跟随本设置。
- **引擎程序路径**：每个引擎一行，显示当前生效的完整程序路径和一个「选择」按钮，选中文件后立即保存。未设置自定义路径时按各引擎默认命令名在 PATH 中解析；已设置时多出「恢复默认」，回到默认命令解析。解析不到可执行文件时行内提示该引擎无法启动。
- **标题模型**：下拉选择新会话引擎模型目录中的模型，留空时使用内置默认模型 `gpt-5.6-luna`。

三项保存在全局注册表（`~/.vermillion/workspace-registry.json` 的 `defaultNewSessionEngineId`、`engineProgramPathsByEngineId`、`titleGenerationModelId`），修改立即生效，不重启应用。会话列表与输入器按会话的 `engineId` 展示对应引擎的能力面。

## 执行配置

模型与推理档位是引擎无关的标识：`modelId` 为模型名（如 `gpt-5.6-luna`），`reasoningOptionId` 为推理档位（如 `max`）。执行偏好、角色 frontmatter、工单与 subagent 配置都使用这套标识，不按引擎分别配置。各引擎适配层把它映射到自身协议：Codex 直接传模型名与 effort；pi 通过 `get_available_models` 匹配唯一 `provider/id` 并映射为 thinking level。`serviceTierId` 只在引擎声明支持时展示与传递，pi 不支持。引擎模型目录中没有该模型或不支持该档位时明确报错，不静默回退。

标题生成沿用全局生成器，凭据来源优先当前会话引擎提供的 OpenAI 兼容凭据，该引擎无法提供时使用其他已配置引擎的凭据；模型取设置页的「标题模型」，未设置时用内置默认模型 `gpt-5.6-luna`。

## 能力面

| 能力 | Codex | pi |
| --- | --- | --- |
| 对话、流式正文、steer、中断 | 支持 | 支持 |
| 模型 / 推理档位切换 | 支持 | 支持 |
| 速度（service tier） | 支持 | 不支持 |
| 工具调用与终端输出 | 支持 | 支持 |
| 审批 | 支持 | 不支持（工具直接执行） |
| 会话树、fork | 支持 | 支持（`fork` / `clone`） |
| 附件（图片） | 支持 | 支持 |
| 技能列表 | 支持 | 支持 |
| 子代理（Reviewer / Verifier） | `spawn_agent` | `pi-subagents` 扩展的 `subagent` 工具 |
| Changed Files、Hook Activity 扩展 | 支持 | 不支持 |
| delegation / worktree / checkpoint 快照 | 支持 | 不支持 |
| diagnostics | 支持 | 进程与认证状态 |
| 会话发现 | 列出 Codex 目录下全部线程 | 只列出 Vermillion 创建的会话 |

不支持的能力按现有 `unsupported` 兜底展示，不为 pi 造替代实现。

## pi 运行要求

- `pi` 通过 npm 包 `@earendil-works/pi-coding-agent` 安装，`~/.pi/agent/settings.json` 的 `packages` 需包含 `npm:pi-subagents`（子代理）与 `npm:pi-mcp-adapter`（MCP）。
- 模型来自 `~/.pi/agent/models.json` 的 provider 配置；`settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 决定引擎默认。
- Vermillion 随包附带一个 pi extension，启动 pi 时以 `-e` 加载，提供 `vermillion.read_session` 等宿主工具，并在每轮开始前注入当前角色指令（对应 Codex 的 developer 指令送达规则）。
- pi 会话文件位于 `~/.pi/agent/sessions/<cwd 编码>/`，Vermillion 通过 `--session-id` 指定会话 ID 并在索引中记录 `providerKind: "pi-session"`。
