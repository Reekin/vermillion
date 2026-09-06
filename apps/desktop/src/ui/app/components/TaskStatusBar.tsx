import { ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, EmptyState, InlineNotice, ListRow, PanelHeader, StatusBar } from "./ui.js";
import { taskStatusLabel } from "./task-labels.js";

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
        {tasks.map((task) => (
          <li key={task.workspaceId + ":" + task.id}>
            <ListRow
              title={task.title}
              meta={workspaces.find((w) => w.workspaceId === task.workspaceId)?.label}
              trailing={<>{task.progress !== undefined && <span>工单 {task.progress}</span>}<Badge>{taskStatusLabel[task.status]}</Badge></>}
              onClick={() => { setOpen(false); showTask(task); }}
            />
          </li>
        ))}
      </ul>
    </StatusBar>
  );
};
