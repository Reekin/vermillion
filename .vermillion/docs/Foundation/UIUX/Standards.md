# UI/UX 开发维护规范

新界面从共享组件和主题变量长出来，不从零写样式。每个页面只做内容和动作，布局、状态、字号由公共层决定。

## 从哪里开始

- 应用壳组件入口：`apps/desktop/src/ui/app/components/ui.tsx`。文件头列出全部可用组件；先在这里找，再看相近页面（`InboxPanel`、`WorkspacePages`、`DocsPanel`、`SessionSidebar`）的真实用法。
- 主题变量：`apps/desktop/src/ui/app/app.css` 的 `@theme` 块。字号档位 `text-micro / caption / label / body / title-sm / title`，颜色 `text-strong / foreground / muted-foreground / faint-foreground`，表面 `bg-surface / surface-raised / surface-hover / surface-selected / input`，边框 `border-border / border-strong / control-border`，圆角 `rounded-sm / md / lg`，字距 `tracking-eyebrow`。
- 会话区（`ui/chat-shell`）保留自己的 `awb-*` 样式；应用壳和 `features/` 只用上面两处，不引用 `awb-*` class。会话区里嵌入的业务块（turn 扩展）用 `app.css` 里的 `vm-*` 块。

## 必须复用的结构

| 需要 | 用 |
|---|---|
| 面板顶部一行标签 + 右侧动作 | `PanelHeader` |
| 列表里的一行：前导 / 标题 + 次行 / 尾部状态，可选中、可嵌套 | `ListRow` |
| 当前没有内容时的说明和下一步 | `EmptyState`（一个视图一个，不叠加） |
| 标题下的一句说明或错误 | `InlineNotice` |
| 表单输入、文本域、下拉 | `Field` |
| 只有图标的按钮 | `IconButton`（必带 `label`） |
| 普通按钮 | `Button`，变体只有 primary / accent / secondary / ghost |
| 短标签、状态、风险等级 | `Badge` |
| 弹窗、右键菜单、diff | `Modal`、`ContextMenu`、`DiffDialog` |

页面可以安排这些组件的外部布局；不跨层覆盖组件内部样式。出现新用途时扩展 `ui.tsx` 的接口并检查已有使用处，不在页面里复制一份。

通用会话组件只接收展示数据、渲染插槽和操作回调。工单查询、事件订阅、Worker 分支业务投影及状态文案由应用壳提供，会话区不反向依赖应用壳的 Context、工作台客户端或业务类型。

## 导航与状态保留

- 主导航上方是工作台和 Inbox，设置位于底部且与两者同级。设置直接打开完整空白页面，当前没有配置项。
- 工作台左侧会话列表常驻，New Chat 旁放 All / workspace 筛选下拉；筛选只影响列表，不切换当前会话。具体 workspace 筛选作为新草稿的默认项目。
- 右侧顶部分页固定为会话、工单、Docs、Domain、角色、Issues、Automation。会话默认打开，SessionPane 与右侧 Docs Explorer 在切页时保持挂载并保留草稿。
- 其他分页在标题栏显示 workspace 选择器，明确编辑范围；All 仅是会话列表筛选值。页面内容不再嵌套导航侧栏或分页。Domain 草稿在切页时保留。
- 工单链接进入工作台 → 工单并定位目标；会话链接进入工作台 → 会话并选中目标会话或树内节点。Inbox 保持弹窗与展开页面行为。

## 视觉规则

- 单色、低饱和；主操作靠明度和位置突出，错误用 `InlineNotice tone="error"` 或文字说明，不用红色。会话树节点使用低饱和黄色表示进行中、绿色表示已完成未读，已读为中性色；Worker 节点显示 W，当前位置轮廓独立于状态色。左侧会话标题不重复显示状态灯。
- 自然语言、区块标题和短标签使用无衬线字体和正常字距，不强制大写。等宽用于代码、路径、id、commit 和时间；两类字体栈都显式指定中文无衬线回退 Microsoft YaHei UI / PingFang SC。
- 同一状态只在一个地方表达。多个面板不重复催促同一操作。
- 主要内容区保持可读宽度；辅助区域没有内容时不占据强布局地位。
- 工单状态与合入进度遵循[工单](../../Workbench/Missions/PRD.md)，文案由 `task-labels.ts` 集中提供。`Badge` 的状态形态统一在 `app.css` 实现：等待用户为描边胶囊加实心点，进行中为无框加粗空心环，排队中为无框加细空心环，其余状态用无框文字。所有形态尺寸相同，无框的也保留透明边框，保证同列对齐。
- 破坏性动作（取消工单、移除 workspace）不直接摆在行或卡片上：行级的收成 hover 才显示的 × 图标且固定占位，卡片级的收进「···」菜单。查看类动作（会话、来源）用带 hairline 描边的 `Button variant="ghost"`，和旁边的元信息文字分得开。
- 列表行的尾部动作列宽度固定，行与行之间的按钮、状态列必须对齐；hover 只改透明度和底色，不改布局。
- 时间在快速查看场景用相对时间（3 分钟前、昨天 22:10），页面模式可附完整时间和 commit。
- 弹窗承载的面板不放左侧导航列；需要切换对象时用标题栏里的下拉。弹窗展开为页面时保持当时所在的分页、选中项和展开状态。

## 文字与控件

应用壳与会话区共用下列可读性规格，包括输入器配置、空态、说明文字和短标签。原尺寸示意见 [文字打样](Type-Sample.html)。

| 档位 | 字号 | 用途 |
|---|---|---|
| micro | 12px | 时间、标识、短标签、区块标题 |
| caption | 12.8px | 次行、提示、空态说明 |
| label | 14px | 列表标题、按钮、配置标签和选中值 |
| body | 15px | 正文 |
| title-sm | 16px | 小标题 |
| title | 17px | 页面与弹窗标题 |

界面文字最小 12px。列表标题、按钮、配置控件、短标签及区块标题用 500 字重，正文与说明用 400，页面标题用 600。正文行高 1.55，说明行高 1.45。需要阅读的辅助文字使用 muted（#9a9a96），正文使用 foreground，主要标题及选中值使用 strong；faint 留给装饰与禁用状态，不承载正常可读的说明。

输入器配置控件高 32px，标签和值同为 14px，标签中灰、值明亮，控件内部文字不折行，空间不足时按完整控件换行。短标签为 12px、500 字重，普通标签高至少 20px、正常字距，文字使用 foreground；浅底色或细边框表达分组，状态形态保留各自语义。

## 检查

- `pnpm --filter @vermillion/desktop lint:ui`：拦截 `ui/app` 和 `features/` 里的硬编码颜色、任意字号/圆角/字距、`awb-*` class、裸 `<input>/<textarea>/<select>`。确需例外的元素加 `data-ui-raw="原因"`。
- 改公共组件或 `app.css` 后，起实例打开 工作台 → 会话（会话列表 + Docs）、Inbox、工作台 → 工单 三个页面，看普通状态、空态、长中文标题、错误和窄窗口。截图交给空白 subagent 对照本文判断，不自己看图下结论。
- 涉及界面的工单，verifier 除了逐条 acceptance，还要对照本文看一遍截图：是否用了对应组件、是否出现规则之外的颜色和字号、重要操作是否被弱化到看不见。
