# 角色与执行

四个身份，各有独立的角色说明（prompt），全局版本在 `~/.vermillion/roles/`，项目可在 `.vermillion/roles/` 覆盖（在项目内的md frontmatter中可以选择override或append），在 工作台 → 角色 编辑。

默认角色随源码保存在 `packages/workbench/roles/`，打包后位于 `resources/app/roles/`。启动时 `RoleService.ensureGlobal` 只补齐 `~/.vermillion/roles/` 中缺失的文件，不覆盖已有全局版本。读取角色时优先采用 workspace 文件：`override` 用项目正文替换全局正文，`append` 将项目正文追加到全局正文；没有项目文件时使用全局版本。

会话 metadata 只保存角色标识 `role`（`design-partner`、`work-preparation`、`worker`、`maintainer`），不保存角色正文；fork 只继承 `role`。设计伙伴会话使用 `design-partner` 角色，其指令正文附带当前 workspaceId 与工作台 CLI 说明。

每次向会话发送消息时，工作台按 `role` 和当前 workspace 现场解析该会话此刻应有的指令（设计伙伴与开工准备用设计伙伴正文，Worker 用含 Reviewer、Verifier 交接说明的完整 Worker 指令，Maintainer 按领域附加专属指令），角色文件的修改在下一条消息生效，不需要重建会话。解析结果作为会话启动与恢复的角色指令：Codex 由 runtime 通过 `config/read` 读取用户的 `developer_instructions` 再追加角色正文作为 developer 指令，不修改用户 `config.toml`；pi 由 Vermillion 附带的 extension 在轮次开始前注入；与上次已送达正文不同时，在本轮开始前以 developer 级消息追加到历史末尾并声明取代此前角色指令，然后记录为已送达。已送达正文保存在会话 metadata 的 `developerInstructions`，只由运行时在送达后回写。

角色文件头部可以用 frontmatter 指定这个身份新会话的默认模型配置（模型、推理档位、速度）；没写的沿用输入器里上次选的配置。设计伙伴的默认配置在新建会话草稿态显示于输入器，用户可手动调整，发送时以输入器当前选择为准。Reviewer 和 Verifier 是 Worker 拉起的 subagent（Codex 用 `spawn_agent`，pi 用 `subagent` 工具），创建时使用各自角色解析后的模型配置，未指定的字段沿用引擎的 subagent 默认值；正文与配置均遵循全局和项目的覆盖、追加规则。引擎不支持的显式配置应明确反馈，不能静默忽略。

- **设计伙伴**：需求讨论与项目设计，指令见 [design-partner.md](../../../../packages/workbench/roles/design-partner.md)。
- **Worker**：工单执行，指令见 [worker.md](../../../../packages/workbench/roles/worker.md)。
- **Maintainer（领域 Owner）**：领域巡检、Issue 分诊与授权范围内自动开单，指令见 [maintainer.md](../../../../packages/workbench/roles/maintainer.md)。
- **Liaison**：IM 反馈收集，指令见 [liaison.md](../../../../packages/workbench/roles/liaison.md)。

Maintainer 和 IM 接入属于扩展能力，不是基本执行循环的前提。

开工准备使用独立的 [work-preparation.md](../../../../packages/workbench/roles/work-preparation.md)，沿用角色文件的全局、项目覆盖与追加规则，可通过角色编辑器及 role CLI 编辑。正文作为准备轮消息发送，附上本次范围及工单关联信息；准备分支继承原角色，不注入 Worker 指令。开工流程见[工作台 · 开工](../Think/PRD.md)。

调度器排到工单时，将分支的角色标识改为 `worker` 并应用其模型配置，随后发送执行合同；Worker 指令按上述送达规则在合同轮开始前追加。保留继承的历史前缀，后续恢复与压缩后仍使用 Worker 角色。`worker.md` 只描述执行已建立工单的职责。

## 编辑器

角色列表与编辑操作作用于标题栏 workspace 选择器指定的项目。

工作台 → 角色 打开一个角色时，编辑器上方是设置控件，下方是 prompt 正文的文本框；frontmatter 只是存储格式，不在文本框里出现，也不让用户手写。
- 定制方式：global / override / append 三档，作用于当前 workspace。
- global 沿用全局角色，展示全局 prompt 和模型配置，prompt 与各模型参数只读；模式选择仍可操作。选择 global 并保存后，当前项目恢复沿用全局。
- override 的 prompt 与各模型参数可编辑；从 global 进入时以全局内容为初值，保存后使用项目 prompt。
- 切换到 append 时，prompt 文本框清空，用于填写追加正文；生效 prompt 为全局正文加项目追加正文。重新打开已保存的 append 角色时显示已有追加正文。
- append 的模型参数可编辑，按字段覆写全局模型参数，未覆写的字段沿用全局；只修改模型参数、追加正文为空时，prompt 仍完整沿用全局。
- 从 append 切到 override 时，prompt 重新取全局正文，模型参数保留当前选择。
- 模型配置：模型、推理档位、速度三个下拉，选项与输入器里的一致，各字段独立选择。override 下未指定的字段沿用输入器配置；append 下未覆写的字段沿用全局配置，全局未指定时沿用输入器配置。
保存后重新打开，显示已保存的模式、prompt 和模型参数。角色定制只影响当前 workspace，全局角色保持原样。

新会话默认配置逐字段取角色生效配置，未指定的字段沿用输入器上次选择。设计伙伴在草稿态以此初始化输入器；创建会话及发送首条消息均使用输入器当前配置，后续消息同样遵循当前选择。工作台自动发起的角色会话使用合成的默认配置。

## 会话

会话的展示位置与布局见 [产品总览 · 工作台 → 会话](../../Overview/PRD.md#工作台--会话)。

### 读取会话消息

`vermillion.read_session` 按[会话标识](../../Foundation/Engines/PRD.md#会话标识)返回全部可见 user 和 agent 消息，包括 agent 的 commentary、最终回复以及进行中消息已生成的正文。每条消息保留消息 ID、所属 turn、发送者、阶段和时间戳；同时返回轮次状态，便于调用者结合最近消息判断进展。工具调用及其输出不作为 user/agent 消息混入。

`limit` 按消息条数选取最近 N 条，再按时间正序返回；例如 10 或 20 条可用于查看最近进展。同一消息的流式片段合并为一条，不重复计数。未传 limit 时返回全部消息，现有 maxChars 字符预算仍可限制正文，截断须明确标记，字符预算优先保留最新消息。读取覆盖目标会话上下文中的用户与 agent 消息，共享历史不重复返回，不混入其他分支独有消息。

读取不发起模型轮次、不改变当前查看位置或中断目标执行。没有新消息不能单独认定会话卡死，目标可能正在运行工具或等待模型。

### 向会话发送消息

CLI `vermillion steer` 接收目标[会话标识](../../Foundation/Engines/PRD.md#会话标识)与 `content`，可向任意可访问的会话投递消息，不限于 Worker 或当前 workspace。目标有活动 turn 时追加到该轮，空闲时在原会话启动新轮；不创建 fork，不强制中断已有执行，不改变目标角色、模型偏好与工单归属。目标绑定准备或工单时，人工新轮、追加消息和暂停按[执行控制](../Missions/PRD.md#执行控制)处理；发送普通消息不等于恢复自动推进，也不代替[业务决策答复](../Inbox/PRD.md#决策卡)。

命令以引擎实际接收为成功依据，返回目标会话、接收消息的 turn 和本次是追加还是新轮；不可访问、无法发送或引擎拒绝时返回明确错误。执行期间与投递同时发生的正常轮次结束，按当前实际状态将未接收的消息送入原会话新轮，不重复投递已接收消息。

### 询问开单来源

CLI `vermillion asksource` 接收 `workspaceId`、`workItemId`、调用者 `sessionId` 与 `question`，仅供该工单绑定的 Worker 会话使用。程序核对调用者与工单归属，从工单记录的 `sourceSessionId` / `sourceTurnId` 所指开单位置临时 fork 设计伙伴会话，携带截至该位置的讨论上下文和本次问题；不改用来源会话的最新末端或 Worker 的执行位置。

临时会话使用该 workspace 解析后的设计伙伴角色与模型配置，不继承 Worker 的执行身份或工单归属。它回答本次问题，原设计讨论不会收到额外用户消息，也不改变用户查看位置。调用返回答复和临时会话标识；问答结束后归档临时 fork，失败和中断也执行回收，归档失败明确反馈。无有效来源位置或调用者不是对应 Worker 时明确拒绝，不冷启动无上下文的替代会话。

询问是当前 Worker 执行中的工具操作，等待期间保留原执行归属，不计为未提交失败或重复派工。问答本身不修改合同、不新增工单，后续处置由 [Worker 指令](../../../../packages/workbench/roles/worker.md)规定。

## Maintainer 巡检指令

巡检会话使用按全局与项目覆盖规则解析的 `maintainer.md` 作为通用角色指令，再追加当前 workspace 的 `.vermillion/roles/maintainer/<domain-id>.md` 正文作为领域专属 developer instruction。专属文件可选，未配置时只使用通用角色；它不替换通用角色，也不单独配置模型。通用角色负责检查与 Issue 汇总的职责边界，领域专属文件约定检查方法与重点。

领域专属指令在 Domain 详情通过统一的 Markdown 编辑界面编辑，不作为独立角色列入角色列表。编辑目标标记为 Maintainer 配置，由对应配置存储负责读取和保存。领域定义及其关联 PRD、Standards 作为检查材料提供给会话，不直接拼成 developer instruction。Domain 页面列出的所有 Markdown 文件使用同一编辑入口。
