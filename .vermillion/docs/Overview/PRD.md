# Vermillion 产品总览

Vermillion（朱砂）是个人 agent 工作台：通过讨论明确需求，把结论写进文档，再从讨论现场分出 Worker 分支去执行。用户主要关注需求、必要决策和合入结果，可以在执行期间继续讨论并调整方向。

## 核心对象

| 对象 | 含义 | 详见 |
| --- | --- | --- |
| Workspace | 对应一个项目目录，关联文档、工单和会话 | |
| Domain | 一个业务或跨模块领域的定义：覆盖什么、什么改动应考虑它、遵守哪些规范 | [Domain](../Workbench/Domains/PRD.md) |
| Doc | 驱动工作的文档，存放于 `.vermillion/docs/` 并用 Git 管理 | [文档管理](../Workbench/Documents/PRD.md) |
| Issue | 用户提出或 agent 收集的议题，支持分诊、讨论及授权范围内自动开单 | [Issues](../Workbench/Issues/PRD.md) |
| WorkItem | 可独立执行和验收的工单，由开工分支创建并执行 | [工单](../Workbench/Missions/PRD.md) |
| DecisionCard | 执行中需要用户决定的问题，进入 Inbox | [Inbox](../Workbench/Inbox/PRD.md) |

## 界面

主导航上方是 **工作台** 和 **Inbox**，底部是同级的 **设置**。工作台是主页，用于讨论、修改文档、开工和查看执行，见 [工作台](../Workbench/Think/PRD.md)。Inbox 集中展示待决策和已合入内容。设置以弹窗打开，提供新会话引擎、标题模型与引擎程序路径，见[会话引擎](../Foundation/Engines/PRD.md)。

工作台左侧会话列表常驻。New Chat 旁的 All / workspace 下拉只筛选列表，不切换当前阅读的会话；选择具体 workspace 后点击 New Chat，草稿使用该 workspace。右侧顶部依次为会话、工单、Docs、Domain、角色、Issues、Automation、管理，默认进入会话。会话页包含阅读区和右侧 Docs Explorer，切换分页时保留挂载和未发送草稿。其他分页通过标题栏的 workspace 选择器明确浏览和编辑范围；列表中的 All 不代表全局编辑范围。选择器只做切换；workspace 的添加在会话输入器与管理分页进行，移除只在管理分页进行。

Inbox 与设置单击以弹窗打开，Inbox 可展开为页面，双击主导航入口直接以页面打开。弹窗遮罩不覆盖主导航，再次单击入口关闭弹窗；Inbox 展开时保留当前选中项和已展开详情。Automation 用于用户自定义定时或触发任务，不承载内部 Worker 调度。

### 搜索

左侧会话列表的搜索入口打开搜索弹窗，结果按工单、会话、文档分类。每个分类默认最多显示 10 条；有更多结果时，该分类提供“展开更多”，展开当前分类的其余搜索结果，其他分类保持原状。预览命中位置的上下文、打开对应对象的行为保留。

左侧结果列表与右侧详情分别滚动，向下浏览结果时右侧详情保持可见；两侧隐藏滚动条，支持鼠标滚动。

### 工作台 → 会话

用户发起的会话树与冷启动的 agent 根会话统一列在左侧。从讨论 fork 出的 Worker 分支在所属会话树里查看，不重复列为根会话。列表时间与排序见[会话列表](../Workbench/Think/PRD.md#会话列表)；消息区在任何宽度下都保持左右留白，文字不贴边、不被裁切。

Agent 会话行标注角色，subagent 缩进挂在派出它的会话下，沿用统一状态灯。选中后直接在会话页阅读和对话。所有会话链接进入工作台 → 会话，选中目标会话或树内节点。

### 状态条

窗口底部状态条显示列表图标和「当前工单: N」，统计所有 workspace 中未结束的工单，已关闭和已取消的不计入。

点击这一项弹出一个小面板，列出计入 N 的全部工单摘要：标题、所属 workspace、状态。点击任一条进入工作台 → 工单，切到对应 workspace 并定位到该工单。

有执行会话的工单条目提供「进入会话」入口，点击后收起面板，进入工作台 → 会话并选中该工单的执行会话或对应树内节点。

开工和仅提交的结果（「已开工 · 标题」「已提交文档 · 提交说明」）也在状态条上短暂显示，约 3 秒后回到常态；Docs 面板底部不显示结果条。

## 角色

设计伙伴、Worker、Maintainer、Liaison 的职责与配置见[角色](../Workbench/Roles/PRD.md)。

## 基本闭环

讨论 → 开工准备整理文档并建单 → Worker 执行并提交证据 → 验证通过后合入关闭 → 用户在 Inbox 查看结果。

## 规范

- [UI/UX 规范](../Foundation/UIUX/Standards.md)
- [架构](../Foundation/Architecture.md)
- [会话引擎](../Foundation/Engines/PRD.md)
- [执行循环规范](../Workbench/Missions/Standards.md)

## 实现状态

Issues 与 Automation 目前只有占位入口，议题管理、采集和自动化任务待实现。
