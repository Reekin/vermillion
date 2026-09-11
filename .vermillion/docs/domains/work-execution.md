---
standards:
  - .vermillion/docs/Workbench/Missions/Standards.md
  - .vermillion/docs/domains/acceptance/Standards.md
---
# 工单执行与恢复

覆盖开工、工单的调度、执行资源声明、依赖、文档变更通知、决策答复、验收提交、主分支合入、后台 worktree 回收，以及运行中断后的恢复。

也覆盖 [worktree 开发依赖准备](../Foundation/Development/PRD.md)、按影响选择检查范围，以及 Worker 向 Reviewer、Verifier 交接成果和角色模型配置。

也覆盖[隔离实例准备](../Foundation/Acceptance/PRD.md)的 CLI/RPC、测试项目与夹具准备、就绪返回和实例生命周期。

修改工单状态、执行记录的持久化与查询投影、CLI/RPC 入口、运行事件、角色执行指令、重试与恢复逻辑时应考虑这个领域。涉及工单看板、决策卡或角色界面时同时考虑 UI/UX 领域。单纯修改工单所实现的业务功能、且不改变执行流程时不涉及本领域。

## 提交与续做

执行中的合同更新、验证结果与决策答复遵循[工单流转](../Workbench/Missions/PRD.md#流转)及[决策卡](../Workbench/Inbox/PRD.md#决策卡)。合同依据与会话轮次分开判断，续做保留有效证据；验证未完成不视作产品缺陷，固定审阅或验证轮数不触发业务决策。
