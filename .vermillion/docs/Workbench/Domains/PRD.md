# Domain

Domain 是一个业务或跨模块领域（例如 UI/UX）的定义，用来把项目的长期规范交给相关的工单。它不挂在文档或代码路径上：一份文档里可能多处涉及某个领域但某次改动并不涉及，按路径匹配也判断不了语义，所以是否相关由建单的 Worker 凭对改动的理解判断。

每个领域一份文档 `.vermillion/docs/domains/<id>.md`：正文用自然语言说明这个领域覆盖什么、什么样的改动应该考虑它；头部 `standards:` 列出该领域的规范文档路径。随文档一起走 Git。

工作台 → Domain 按标题栏选择的 workspace 列出这个目录，可新建（生成模板并打开编辑）和编辑。角色 prompt 有独立入口。

工单 refs 包含与改动相关的领域规范，领域选择依据改动语义。

## Maintainer

领域列表只识别 `.vermillion/docs/domains/` 直接子级的领域定义文件，不把子目录中的规范或其他材料列成领域。详情标题栏提供 Domain 选择器，在当前 workspace 的领域之间切换。

Domain 详情分别展示“检查依据”和可编辑的“领域巡检指令”。前者引用 PRD 与 Standards；后者保存为项目内 `.vermillion/roles/maintainer/<domain-id>.md`，用于约定本领域的检查方法与重点。通用角色与领域指令的组合见[角色](../Roles/PRD.md#maintainer-巡检指令)。规范文档不充当角色 prompt。

每个领域可配置 Maintainer，检查该领域的代码和文档是否符合领域定义、关联 Standards 与相关 PRD。Domain 详情展示启用状态、触发目录、定时间隔、最近巡检结果，提供配置、立即巡检、查看巡检会话和相关 Issues 的入口。

触发目录只用于发现可能相关的变化，不改变领域按语义判断的方式。自动巡检可由目录变更和定时检查触发，默认定时间隔为六小时；相关变更合并处理，开发中的改动在交付后检查。定时检查关注新增变化与待复查问题，没有需要检查的内容时跳过。每轮使用独立 Maintainer 会话，保留检查范围、依据、结果与关联 Issue，供后续巡检接续。

巡检结果关联新建或补充的 [Issue](../Issues/PRD.md)，不自动触发开发。巡检记录保存证据类型、已验证范围与待验证部分；历史 Issue 的处理原因可供巡检会话读取。检查方法、查重与执行限制由 [Maintainer prompt](../../../../packages/workbench/roles/maintainer.md) 定义。
