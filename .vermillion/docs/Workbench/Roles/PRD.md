# 角色与执行

设计伙伴、Worker、监工、Maintainer 和 Liaison 各有独立的角色说明（prompt），全局版本在 `~/.vermillion/roles/`，项目可在 `.vermillion/roles/` 覆盖（在项目内的md frontmatter中可以选择override或append），在 工作台 → 角色 编辑。

默认角色随应用提供。应用启动时只补齐 `~/.vermillion/roles/` 中缺失的角色文件，不覆盖用户改过的全局版本。读取角色时，有项目文件就按它的方式处理：`override` 用项目正文替换全局正文，`append` 把项目正文接在全局正文后面；没有项目文件就用全局版本。

每个会话记住自己的角色，fork 出的会话继承同一角色。设计伙伴的指令正文附带当前 workspaceId 和工作台 CLI 说明。

每次向会话发消息时，工作台都按会话的角色和所属 workspace 取当下的角色正文：设计伙伴和开工准备用设计伙伴正文，Worker 用包含 Reviewer、Verifier 交接说明的完整 Worker 指令，监工用 supervisor 正文，Maintainer 再附加领域专属指令。改了角色文件，下一条消息就生效，不需要重建会话。角色正文作为 developer 指令送给模型；用户在 Codex 配置里写的 `developer_instructions` 仍然生效，Vermillion 不修改用户的 `config.toml`。送达方式见[架构](../../Foundation/Architecture.md#角色指令送达)。

- **设计伙伴**：需求讨论与项目设计，指令见 [design-partner.md](../../../../packages/workbench/roles/design-partner.md)。
- **Worker**：工单执行，指令见 [worker.md](../../../../packages/workbench/roles/worker.md)。
- **监工**：工作进展检查与异常处置，指令见 [supervisor.md](../../../../packages/workbench/roles/supervisor.md)。
- **Maintainer（领域 Owner）**：领域巡检、Issue 分诊与授权范围内自动开单，指令见 [maintainer.md](../../../../packages/workbench/roles/maintainer.md)。
- **Liaison**：IM 反馈收集，指令见 [liaison.md](../../../../packages/workbench/roles/liaison.md)。

Maintainer 和 IM 接入属于扩展能力，不是基本执行循环的前提。

开工准备使用独立的 [work-preparation.md](../../../../packages/workbench/roles/work-preparation.md)，沿用角色文件的全局、项目覆盖与追加规则，可通过角色编辑器及 role CLI 编辑。正文作为准备轮消息发送，附上本次范围及工单关联信息；准备分支继承原角色，不注入 Worker 指令。开工流程见[工作台 · 开工](../Think/PRD.md)。

排到工单时，执行分支切换为 Worker 角色和 Worker 模型配置，再收到合同。分支之前的讨论历史保留，之后恢复或压缩上下文都仍是 Worker。`worker.md` 只描述执行已建立工单的职责。

## 模型配置

角色文件可以指定这个角色的默认模型、推理档位和速度。新会话的配置逐项取角色的配置，角色没写的项沿用输入器上次的选择。设计伙伴的配置用来初始化新建会话的输入器，用户可以在发送前调整，之后以输入器当前选择为准，见[工作台 · 输入器](../Think/PRD.md#模型配置)。工作台自动发起的角色会话直接使用合成后的配置。

Reviewer 和 Verifier 是 Worker 拉起的 subagent，创建时使用各自角色的模型配置，角色没写的项沿用引擎的 subagent 默认值。它们的正文和配置同样遵循全局与项目的覆盖、追加规则。引擎不支持某项显式配置时明确报错，不静默忽略。

## 监工

监工是工作台自动创建和唤醒的普通 Agent 会话，关联所属工作和准备来源。它从已结束的准备轮 fork 出来，使用本 workspace 的 supervisor 角色正文和模型配置，然后收到第一次检查消息；它不是 Worker，也不属于第一张工单。

后续检查复用同一个会话。创建、检查周期、暂停和结束条件见[工作与工单 · 监工](../Missions/PRD.md#监工)。监工如何判断、纠偏、恢复和交接由 supervisor.md 规定，这份 prompt 不会加载给其他角色。

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

## 会话

会话的展示位置与布局见 [产品总览 · 工作台 → 会话](../../Overview/PRD.md#工作台--会话)。

### 读取会话消息

`vermillion.read_session` 按[会话标识](../../Foundation/Engines/PRD.md#会话标识)返回全部可见 user 和 agent 消息，包括 agent 的 commentary、最终回复以及进行中消息已生成的正文。每条消息保留消息 ID、所属 turn、发送者、阶段和时间戳；同时返回轮次状态及下述当前活动摘要，便于调用者结合最近消息判断进展。工具调用及其输出不作为 user/agent 消息混入。

`limit` 按消息条数选取最近 N 条，再按时间正序返回；例如 10 或 20 条可用于查看最近进展。同一消息的流式片段合并为一条，不重复计数。未传 limit 时返回全部消息，现有 maxChars 字符预算仍可限制正文，截断须明确标记，字符预算优先保留最新消息。读取覆盖目标会话上下文中的用户与 agent 消息，共享历史不重复返回，不混入其他分支独有消息。

消息列表之外单独返回目标会话的当前活动摘要：当前轮次与状态、仍在运行的工具或命令、最近完成的一项活动，以及待审批或待用户输入的事项。活动携带标识、名称、已有简短描述及开始/结束时间，工具状态沿用引擎事实；并行运行的活动分别列出，不能用最近一条已完成工具遮盖仍在运行的工具。默认不返回完整工具参数和输出。

活动摘要只描述目标会话的实际活动，不把共享祖先或其他分支的历史工具当成当前执行。没有活动工具不代表会话停止；断连或仅有历史状态时明确标为未确认并保留已知记录的时间，不能用查询时间冒充进展时间，也不从无消息或时长推断卡死。摘要不受消息 limit 截断影响，消息字符预算语义保持。工具读取与对应 CLI 读取提供一致结果。

读取不发起模型轮次、不改变当前查看位置或中断目标执行。没有新消息不能单独认定会话卡死，目标可能正在运行工具或等待模型。

### 向会话发送消息

CLI `vermillion steer` 接收目标[会话标识](../../Foundation/Engines/PRD.md#会话标识)与 `content`，可向任意可访问的会话投递消息，不限于 Worker 或当前 workspace。目标有活动 turn 时追加到该轮，空闲时在原会话启动新轮；不创建 fork，不强制中断已有执行，不改变目标角色、模型偏好与工单归属。准备或 Worker 会话复用相同聊天行为，普通消息不修改工单阶段、不建立人工接管或工单消息队列，也不代替[业务决策答复](../Inbox/PRD.md#决策卡)。任务控制使用独立的[业务入口](../Missions/PRD.md#执行控制)。

命令以引擎实际接收为成功依据，返回目标会话、接收消息的 turn 和本次是追加还是新轮；不可访问、无法发送或引擎拒绝时返回明确错误。执行期间与投递同时发生的正常轮次结束，按当前实际状态将未接收的消息送入原会话新轮，不重复投递已接收消息。

### 询问开单来源

CLI `vermillion asksource` 接收 `workspaceId`、`workItemId`、调用者 `sessionId` 与 `question`，只能由这张工单的 Worker 调用。工作台从工单记录的开单位置临时 fork 一个设计伙伴会话，带着截至开单时的讨论上下文回答问题；不使用来源会话后来的最新内容，也不从 Worker 的位置 fork。

临时会话使用该 workspace 解析后的设计伙伴角色与模型配置，不继承 Worker 的执行身份或工单归属。它回答本次问题，原设计讨论不会收到额外用户消息，也不改变用户查看位置。调用返回答复和临时会话标识；问答结束后归档临时 fork，失败和中断也执行回收，归档失败明确反馈。无有效来源位置或调用者不是对应 Worker 时明确拒绝，不冷启动无上下文的替代会话。

询问是当前 Worker 执行中的工具操作，等待期间保留原执行归属，不计为未提交失败或重复派工。问答本身不修改合同、不新增工单，后续处置由 [Worker 指令](../../../../packages/workbench/roles/worker.md)规定。

## Maintainer 巡检指令

巡检会话使用按全局与项目覆盖规则解析的 `maintainer.md` 作为通用角色指令，再追加当前 workspace 的 `.vermillion/roles/maintainer/<domain-id>.md` 正文作为领域专属 developer instruction。专属文件可选，未配置时只使用通用角色；它不替换通用角色，也不单独配置模型。通用角色负责检查与 Issue 汇总的职责边界，领域专属文件约定检查方法与重点。

领域专属指令在 Domain 详情通过统一的 Markdown 编辑界面编辑，不作为独立角色列入角色列表。编辑目标标记为 Maintainer 配置，由对应配置存储负责读取和保存。领域定义及其关联 PRD、Standards 作为检查材料提供给会话，不直接拼成 developer instruction。Domain 页面列出的所有 Markdown 文件使用同一编辑入口。
