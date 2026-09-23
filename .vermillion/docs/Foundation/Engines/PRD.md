# 会话引擎

Vermillion 通过引擎运行会话。当前支持 Codex（`codex`，Codex app-server）和 pi（`pi`，`pi --mode rpc`）。引擎用 `engineId` 标识；会话记录创建时的 `engineId`，同一棵会话树的所有分支沿用它，不可更改。

## 会话标识

会话在工作台内由工作台会话 ID 标识，引擎另有自己的会话标识（Codex 的 thread id、pi 的 session id）。引擎工具创建的子代理只向调用方返回引擎会话标识。

面向 agent 的会话入口两种标识都接受：先按工作台会话 ID 定位，未命中时按引擎会话标识解析到对应会话。返回结果中的会话标识统一为工作台会话 ID。两种都定位不到时报错说明两种标识均已尝试。

## 设置

设置页提供三项：

- **新会话引擎**：下拉选择已注册的引擎。之后从零创建的会话使用该引擎，包括新建会话、Maintainer 巡检会话、Issue 讨论会话及其他由工作台自动发起的新会话。从已有会话 fork 出的会话沿用源会话树的引擎：开工准备分支、Worker、`asksource` 临时会话与普通分支都是在某个位置上 fork 出来的，因此跟随源会话引擎而不跟随本设置。
- **引擎程序路径**：每个引擎一行，显示当前生效的完整程序路径和一个「选择」按钮，选中文件后立即保存。未设置自定义路径时按各引擎默认命令名在 PATH 中解析；已设置时多出「恢复默认」，回到默认命令解析。解析不到可执行文件时行内提示该引擎无法启动。
- **标题模型**：下拉选择新会话引擎模型目录中的模型，留空时使用内置默认模型 `gpt-5.6-luna`。

三项都是全局设置，修改立即生效，不需要重启应用。会话列表和输入器按会话所用的引擎展示对应能力。

## 执行配置

模型和推理档位用一套与引擎无关的写法：模型写模型名（如 `gpt-5.6-luna`），推理档位写档位名（如 `max`）。执行偏好、角色 frontmatter、工单和 subagent 配置都用这套写法，不按引擎分别配置，由各引擎自己换算成对应设置。速度只在引擎支持时显示和生效，pi 不支持。引擎里没有这个模型或不支持这个档位时明确报错，不悄悄换成别的。

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

不支持的能力在界面上显示为不可用，不为 pi 造替代实现。

## pi 运行要求

- `pi` 通过 npm 包 `@earendil-works/pi-coding-agent` 安装，`~/.pi/agent/settings.json` 的 `packages` 需包含 `npm:pi-subagents`（子代理）与 `npm:pi-mcp-adapter`（MCP）。
- 模型来自 `~/.pi/agent/models.json` 的 provider 配置；`settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 决定引擎默认。
- `vermillion.read_session` 等工作台工具和角色指令由 Vermillion 随包附带的 pi 扩展提供，用户不需要另外安装。
- pi 会话文件保存在 pi 自己的会话目录 `~/.pi/agent/sessions/` 下。
