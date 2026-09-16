# 会话列表状态灯验收记录

候选分支 `work/sidebar-status-light`，成果提交见 `git log`（代码提交 + 本记录）。基线为主分支 `60ac476`。

实例：`app.start` 隔离真机

| 项 | 值 |
|---|---|
| pid | 76900 |
| CDP | http://127.0.0.1:9421 |
| dataDir | `I:\gpt-projects\vermillion-accept\status-light` |
| workspaceId | `workspace-mu4fly7g-5tyr510h` |
| 测试项目 | `I:\gpt-projects\vermillion-accept\status-light\fixtures\real-session\project` |

实例运行的是本 worktree 构建：CDP 目标为 `file:///I:/gpt-projects/vermillion-worktrees/sidebar-status-light/apps/desktop/dist-web/index.html`，`runtime.info` 返回 pid 76900、`buildId sha256:5310aec6…`、`schedulerOnline true`。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm -r --workspace-concurrency=1 typecheck` | 6 个 workspace 包全部通过 |
| `pnpm -r --workspace-concurrency=1 test` | 50 个测试文件、299 条测试通过 |
| `pnpm --filter @vermillion/desktop lint:ui` | `ui: ok` |

新增 `apps/desktop/tests/session-sidebar-status.test.tsx`：三种取值各自的槽位与状态色类名、`none` 仍保留固定宽度槽位、灯在标题之前、折叠时子会话不向父行透传状态。

## 逐条观察

1. 三态并存：`shots/03-three-states.png`。同一时刻列表同时存在运行中的会话（黄灯 `rgb(207,183,106)`）、未打开的已完成未读会话（绿灯 `rgb(143,188,152)`）与已读完成的会话（无灯）。运行中状态先由真实发送产生（`shots/01-running-yellow.png`），未读由“会话未选中时完成一轮”产生（`shots/02-unread-green.png`）。
2. 成员分支：`shots/04-branch-running-yellow.png` → `shots/05-branch-unread-green.png` → `shots/06-read-light-cleared.png`。在会话 A 的第 1 轮节点上提问 fork 出成员分支，读者停在其他会话：分支运行期间该树行显示黄灯；分支完成且读者仍在别处时转为绿灯；打开该树读完后灯消失。该行标题、排序、置顶与展开状态在此期间不变。
3. subagent 行：`shots/08-subagent-lights.png` → `shots/09-subagent-unread.png`。父会话派生真实 subagent（会话索引中 `relationType: subagent`）。父行保持自身状态（无灯），缩进的 subagent 行在运行期间显示黄灯、完成后未读转为绿灯，两行互不覆盖。
4. 行内共存：`shots/10-pin-collapse.png`、`shots/11-archived.png`、`shots/12-role-badge.png`。依次执行置顶、折叠、归档，并用隔离工作台上被调度器拉起的 Worker 会话（带角色标记）对照：所有顶层行的状态槽位左边缘都是 92px、标题左边缘 106px，缩进行分别为 106px / 139px，相对时间右边缘统一为 327px；折叠后仅隐藏缩进行，归档后该行从列表消失，槽位与标题位置不随灯的明灭或这些操作移动。

第 4 条的“重命名”入口由另一张未合入的工单提供，本候选不包含该菜单项；本轮以置顶、折叠、归档和长中文标题对照代替，未覆盖重命名本身。

## 状态查询对照

行的状态灯由服务端 `SessionBrowserItemRpc.statusDot` 决定，DOM 上以 `data-session-status` 暴露，取值为 `none | running | unread_completed`；实测计算色分别为无、`rgb(207,183,106)`、`rgb(143,188,152)`，与「会话树」节点使用同一组颜色变量。

`dataDir/session-index.json` 同期记录：运行中的会话 `lastActiveSessionId` 变化不影响其运行计数；未读会话 `unreadState: unread_completed` 在打开后回落为 `read`；fork 关系 `parentSessionId: session-mu4fs43s-uy17ta6a → codex-thread:01a0ab84-…`，subagent 关系 `session-mu4g6x9g-w8scvlwj → codex-thread:01a0ab86-…`。

## 环境说明

隔离实例按项目规范准备，模型为 `gpt-5.6-luna` / `max` / `标准`。该模型在本机账号上频繁返回 `usage_limit_exceeded`（见隔离 CODEX_HOME 中 rollout 的 `task_complete` 记录），因此后半段真实 turn 改用同一引擎下可用的 `deepseek-flash` 完成；状态灯取值与模型无关，两种模型下都观察到相同的运行→未读→已读变化。
