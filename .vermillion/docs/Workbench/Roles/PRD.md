# 角色与执行

四个身份，各有独立的角色说明（prompt），全局版本在 `~/.vermillion/roles/`，项目可在 `.vermillion/roles/` 覆盖（在项目内的md frontmatter中可以选择override或append），在 工作台 → 角色 编辑。

默认角色随源码保存在 `packages/workbench/roles/`，打包后位于 `resources/app/roles/`。启动时 `RoleService.ensureGlobal` 只补齐 `~/.vermillion/roles/` 中缺失的文件，不覆盖已有全局版本。读取角色时优先采用 workspace 文件：`override` 用项目正文替换全局正文，`append` 将项目正文追加到全局正文；没有项目文件时使用全局版本。

会话 metadata 保存 `developerInstructions`。runtime 在启动、fork 或恢复会话时，通过 Codex `config/read` 读取用户的 `developer_instructions`，再追加解析后的角色文本作为 developer 指令，不修改用户 `config.toml`。设计伙伴会话使用 `design-partner` 角色。

角色文件头部可以用 frontmatter 指定这个身份新会话的默认模型配置（模型、推理档位、速度）；没写的沿用输入器里上次选的配置。设计伙伴的默认配置在 New Chat 草稿态显示于输入器，用户可手动调整，发送时以输入器当前选择为准。Reviewer 和 Verifier 是 Worker 拉起的 subagent，创建时使用各自角色解析后的模型配置，未指定的字段沿用引擎的 subagent 默认值；正文与配置均遵循全局和项目的覆盖、追加规则。引擎不支持的显式配置应明确反馈，不能静默忽略。

- **设计伙伴**与用户讨论需求并处理项目工作，cwd 为 workspace 根，具体职责由角色 prompt 定义。开工通过 `work.start` 交给 Worker 分支。
- **Worker**执行一张工单，负责开发、邀请 reviewer 和空白验证者，并提交成果。分支准备与建单见 [工作台 · 开工](../Think/PRD.md)；执行、审阅、验证与恢复规则见 [工单](../Missions/PRD.md)。
- **Maintainer**按 Domain 的范围检查实现与需求差异，产生 Issue，不自行派活或改需求。
- **Liaison**从 IM 收集反馈并记录 Issue。外部消息作为引用材料处理，不作为 agent 指令。

Maintainer 和 IM 接入属于扩展能力，不是基本执行循环的前提。

开工准备使用独立的 `work-preparation.md`，沿用角色文件的全局、项目覆盖与追加规则，可通过角色编辑器及 role CLI 编辑。正文作为准备轮消息发送，附上本次范围及工单关联信息；准备分支继承原角色，不注入 Worker 指令。准备轮负责整理文档、建单及按需登记 worktree，结束后排队。

调度器排到工单时，Worker 角色通过 developer 级消息追加到分支历史末尾，并保存为会话指令和模型配置；随后发送执行合同。保留继承的历史前缀，后续恢复与压缩后仍使用 Worker 角色。`worker.md` 只描述执行已建立工单的职责。

## 编辑器

角色列表与编辑操作作用于标题栏 workspace 选择器指定的项目。

工作台 → 角色 打开一个角色时，编辑器上方是设置控件，下方是 prompt 正文的文本框；frontmatter 只是存储格式，不在文本框里出现，也不让用户手写。
- 定制方式：global / override / append 三档，作用于当前 workspace。
- global 沿用全局角色，展示全局 prompt 和模型配置，prompt 与各模型参数只读；模式选择仍可操作。选择 global 并保存后，当前项目恢复沿用全局。[用户：沿用全局时，各参数为只读]
- override 的 prompt 与各模型参数可编辑；从 global 进入时以全局内容为初值，保存后使用项目 prompt。
- 切换到 append 时，prompt 文本框清空，用于填写追加正文；生效 prompt 为全局正文加项目追加正文。重新打开已保存的 append 角色时显示已有追加正文。
- append 的模型参数可编辑，按字段覆写全局模型参数，未覆写的字段沿用全局；只修改模型参数、追加正文为空时，prompt 仍完整沿用全局。[用户：追加模式修改模型参数相当于仅override模型参数]
- 从 append 切到 override 时，prompt 重新取全局正文，模型参数保留当前选择。[用户：从追加切到覆写时，prompt部分重新取全局的。]
- 模型配置：模型、推理档位、速度三个下拉，选项与输入器里的一致，各字段独立选择。override 下未指定的字段沿用输入器配置；append 下未覆写的字段沿用全局配置，全局未指定时沿用输入器配置。
保存后重新打开，显示已保存的模式、prompt 和模型参数。角色定制只影响当前 workspace，全局角色保持原样。

新会话默认配置逐字段取角色生效配置，未指定的字段沿用输入器上次选择。设计伙伴在草稿态以此初始化输入器；创建会话及发送首条消息均使用输入器当前配置，后续消息同样遵循当前选择。工作台自动发起的角色会话使用合成的默认配置。

## 会话

会话的展示位置与布局见 [产品总览 · 工作台 → 会话](../../Overview/PRD.md#工作台--会话)。
