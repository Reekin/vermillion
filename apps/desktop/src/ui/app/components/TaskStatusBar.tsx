import { ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import type { TaskWorkItem, WorkbenchStore } from "../workbench-store.js";
import { Badge, EmptyState, HoverCard, InlineNotice, ListRow, PanelHeader, StatusBar } from "./ui.js";
import { statusLabel, taskStatusLabel } from "./task-labels.js";

/** Work items under a mission, shown while the pointer rests on the mission row. */
const MissionItems = ({ items }: { items: TaskWorkItem[] }) =>
  items.length === 0 ? (
    <InlineNotice className="pt-2">还没有工单</InlineNotice>
  ) : (
    <ul>
      {items.map((item) => (
        <li key={item.workItemId}>
          <ListRow title={<span title={item.title}>{item.title}</span>} trailing={<Badge status={item.status}>{statusLabel[item.status]}</Badge>} />
        </li>
      ))}
    </ul>
  );

export const TaskStatusBar = ({ store }: { store: WorkbenchStore }) => {
  const tasks = store((s) => s.tasks);
  const error = store((s) => s.tasksError);
  const workspaces = store((s) => s.workspaces);
  const showTask = store((s) => s.showTask);
  const result = store((s) => s.docCommit);
  const setResult = store((s) => s.setDocCommit);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!result) return;
    setOpen(false);
    const timer = window.setTimeout(() => setResult(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [result, setResult]);

  const notice = result && (result.kind === "commit" ? "已提交文档 · " + result.message : (result.appended ? "已补充任务 · " : "已创建任务 · ") + result.title);
  return (
    <StatusBar icon={ListTodo} label={`当前任务: ${tasks.length}`} notice={notice} open={open} onOpenChange={setOpen}>
      <PanelHeader title="当前任务" />
      {error ? <InlineNotice tone="error">任务加载失败：{error}</InlineNotice> : tasks.length === 0 && <EmptyState title="当前没有任务" />}
      <ul>
        {tasks.map((task) => {
          const row = (
            <ListRow
              title={task.title}
              meta={workspaces.find((w) => w.workspaceId === task.workspaceId)?.label}
              trailing={<>{task.kind === "mission" && <span>工单 {task.workItems.filter((w) => w.status === "closed").length}/{task.workItems.length}</span>}<Badge>{taskStatusLabel[task.status]}</Badge></>}
              onClick={() => { setOpen(false); showTask(task); }}
            />
          );
          return (
            <li key={task.workspaceId + ":" + task.id}>
              {task.kind === "mission" ? <HoverCard content={<MissionItems items={task.workItems} />}>{row}</HoverCard> : row}
            </li>
          );
        })}
      </ul>
    </StatusBar>
  );
};
