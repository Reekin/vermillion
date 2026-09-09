---
standards:
  - .vermillion/docs/Foundation/UIUX/Standards.md
  - .vermillion/docs/domains/acceptance/Standards.md
---
# UI/UX

## 覆盖什么

桌面应用里用户看得到、点得到的一切：应用壳（侧栏、Inbox、Workspaces、Docs、弹窗、右键菜单）、会话区与输入器、会话区里嵌入的业务块（文件变更、hook 活动）、以及这些界面用到的公共组件、字体和主题变量。

## 什么样的改动应该考虑它

- 新增或改动任何页面、面板、弹窗、列表行、表单、按钮、空态、提示文案。
- 改 `apps/desktop/src/ui/app/`、`apps/desktop/src/ui/chat-shell/` 或 `apps/desktop/src/features/` 下的界面组件或样式。
- 需求本身是后端逻辑但结果要在界面上呈现（新的状态、新的字段要显示出来）。

纯 CLI、调度器、持久化、RPC 契约的改动不涉及，除非同时要改界面。
