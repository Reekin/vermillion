# Vermillion 产品总览

Vermillion（朱砂）是个人 agent 工作台：通过讨论明确需求，把结论写进文档，再交给后台 agent 执行。用户主要关注需求、必要决策和结果验收，可以在执行期间继续讨论并调整方向。

## 核心对象

| 对象 | 含义 | 详见 |
| --- | --- | --- |
| Workspace | 对应一个项目目录，关联文档、任务和会话 | |
| Domain | 一个业务或跨模块领域的定义：覆盖什么、什么改动应考虑它、遵守哪些规范 | [Domain](../Workbench/Domains/PRD.md) |
| Doc | 驱动工作的文档，存放于 `.vermillion/docs/` 并用 Git 管理 | [文档管理](../Workbench/Documents/PRD.md) |
| Issue | 用户提出或 agent 收集的议题，经讨论后才能转化为任务 | [Issues](../Workbench/Issues/PRD.md) |
| Mission | 一项工作目标及其文档 revision 序列 | [任务与工单](../Workbench/Missions/PRD.md) |
| WorkItem | 可独立执行和验收的工单 | [任务与工单](../Workbench/Missions/PRD.md) |
| DecisionCard | 执行中需要用户决定的问题，进入 Inbox | [Inbox](../Workbench/Inbox/PRD.md) |

## 界面

**思考**是主页，用于与设计伙伴讨论并修改文档，见 [思考](../Workbench/Think/PRD.md)。**Inbox** 集中展示待决策和待验收内容。**Workspaces** 按活跃顺序展示项目，进入项目后查看任务、Domain、Docs、角色、Issues、Automation。

思考之外的全局入口先以弹窗打开，可展开为页面；切换和关闭时保留原页面状态。Automation 用于用户自定义定时或触发任务，不承载内部 Worker 调度。搜索暂不展开设计。

## 角色

设计伙伴、管家、Worker、Supervisor、Maintainer、Liaison 六个身份，各自的职责、边界与协作见 [角色与执行](../Workbench/Roles/PRD.md)。角色身份与会话分离：状态保存在工作台，agent 开始工作时通过 CLI 读取，不依赖历史对话记忆。

## 基本闭环

讨论并修改文档 → 创建任务 → 管家拆单 → Worker 执行并提交证据 → 自动关闭或进入 Inbox → 用户查看结果。仅有页面或登记记录不代表这条路径完成。

## 持久化与运行方向

项目文档用 Markdown，工作台对象用 JSON。全局注册信息与角色配置放在 `~/.vermillion/`，项目内状态放在 `<workspace>/.vermillion/`；会话关联通过 session id 与会话引擎连接。

桌面和 agent 共用工作台服务与 CLI。角色说明随包分发，首次启动补充缺失的全局版本，项目可覆盖；注入时保留用户原有 developer instructions。界面根据事件更新，外部文件修改通过监听进入同一更新链路。

进程重启后根据持久化工单和运行记录恢复调度：被打断的 agent 会话原样恢复并继续（对话上下文和 worktree 都在）；会话无法恢复时才重新排队并记录原因，不把失去执行者的工单一直显示为运行中。

## 规范

- [UI/UX 规范](../Foundation/UIUX/Standards.md)
