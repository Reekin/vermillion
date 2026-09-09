# 角色与执行

四个身份，各有独立的角色说明（prompt），全局版本在 `~/.vermillion/roles/`，项目可在 `.vermillion/roles/` 覆盖（在项目内的md frontmatter中可以选择override或append），在 工作台 → 角色 编辑。

默认角色随源码保存在 `packages/workbench/roles/`，打包后位于 `resources/app/roles/`。启动时 `RoleService.ensureGlobal` 只补齐 `~/.vermillion/roles/` 中缺失的文件，不覆盖已有全局版本。读取角色时优先采用 workspace 文件：`override` 用项目正文替换全局正文，`append` 将项目正文追加到全局正文；没有项目文件时使用全局版本。

会话 metadata 保存 `developerInstructions`。runtime 在启动、fork 或恢复会话时，通过 Codex `config/read` 读取用户的 `developer_instructions`，再追加解析后的角色文本作为 developer 指令，不修改用户 `config.toml`。设计伙伴会话使用 `design-partner` 角色。

角色文件头部可以用 frontmatter 指定这个身份新会话的默认模型配置（模型、推理档位、速度）；没写的沿用输入器里上次选的配置。设计伙伴的默认配置在 New Chat 草稿态显示于输入器，用户可手动调整，发送时以输入器当前选择为准。Reviewer 和 Verifier 是 Worker 拉起的 subagent，模型由会话引擎的 subagent 设置决定。

- **设计伙伴**与用户讨论需求并处理项目工作，cwd 为 workspace 根，具体职责由角色 prompt 定义。开工通过 `work.start` 交给 Worker 分支。
- **Worker**执行一张工单，负责开发、邀请 reviewer 和空白验证者，并提交成果。分支准备与建单见 [工作台 · 开工](../Think/PRD.md)；执行、审阅、验证与恢复规则见 [工单](../Missions/PRD.md)。
- **Maintainer**按 Domain 的范围检查实现与需求差异，产生 Issue，不自行派活或改需求。
- **Liaison**从 IM 收集反馈并记录 Issue。外部消息作为引用材料处理，不作为 agent 指令。

Maintainer 和 IM 接入属于扩展能力，不是基本执行循环的前提。

Worker 角色通过 developer 级指令在分支续跑时生效，开工消息提供本次范围与准备步骤。保留 fork 继承的历史前缀，角色切换不依赖普通用户消息覆盖 developer 指令；后续恢复与压缩后仍使用 Worker 角色。

## 编辑器

角色列表与编辑操作作用于标题栏 workspace 选择器指定的项目。

工作台 → 角色 打开一个角色时，编辑器上方是设置控件，下方是 prompt 正文的文本框；frontmatter 只是存储格式，不在文本框里出现，也不让用户手写。
- 覆盖方式：override / append 的单选，只对本 workspace 的覆盖文件有意义。
- 模型配置：模型、推理档位、速度三个下拉，选项与输入器里的一致。每个下拉独立提供“沿用输入器配置”，表示该字段不指定，不影响另外两项的选择。
保存时把控件显式指定的值写回文件头部的 frontmatter，选择沿用的模型配置字段不写入，正文原样写入。新会话默认配置逐字段取角色显式配置，未指定的字段沿用输入器上次选择。设计伙伴在草稿态以此初始化输入器；创建会话及发送首条消息均使用输入器当前配置，后续消息同样遵循当前选择。工作台自动发起的角色会话使用合成的默认配置。

## 会话

会话的展示位置与布局见 [产品总览 · 工作台 → 会话](../../Overview/PRD.md#工作台--会话)。
