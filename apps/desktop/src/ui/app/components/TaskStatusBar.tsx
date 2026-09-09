import { ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, EmptyState, InlineNotice, ListRow, PanelHeader, StatusBar } from "./ui.js";
import { statusLabel } from "./task-labels.js";

export const TaskStatusBar = ({ store }: { store: WorkbenchStore }) => {
  const tasks = store((s) => s.tasks);
  const error = store((s) => s.tasksError);
  const workspaces = store((s) => s.workspaces);
  const showTask = store((s) => s.showTask);
  const showAgentSession = store((s) => s.showAgentSession);
  const result = store((s) => s.docCommit);
  const setResult = store((s) => s.setDocCommit);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!result) return;
    setOpen(false);
    const timer = window.setTimeout(() => setResult(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [result, setResult]);

  const notice = result && (result.kind === "commit" ? "已提交文档 · " + result.message : "已开工 · " + result.title);
  return (
    <StatusBar icon={ListTodo} label={`当前工单: ${tasks.length}`} notice={notice} open={open} onOpenChange={setOpen}>
      <PanelHeader title="当前工单" />
      {error ? <InlineNotice tone="error">工单加载失败：{error}</InlineNotice> : tasks.length === 0 && <EmptyState title="当前没有工单" />}
      <ul>
        {tasks.map((task) => {
          const row = (
            <ListRow
              className="min-w-0 flex-1"
              title={task.title}
              meta={workspaces.find((w) => w.workspaceId === task.workspaceId)?.label}
              trailing={<Badge status={task.status}>{statusLabel[task.status]}</Badge>}
              onClick={() => { setOpen(false); showTask(task); }}
            />
          );
          return (
            <li key={task.workspaceId + ":" + task.id} className="flex items-center">
              {row}
              <span className="mr-3 flex w-20 shrink-0 justify-end">
                {task.sessionId && <Button size="sm" variant="ghost" outlined onClick={() => {
                  setOpen(false);
                  showAgentSession(task.workspaceId, task.sessionId!);
                }}>进入会话</Button>}
              </span>
            </li>
          );
        })}
      </ul>
    </StatusBar>
  );
};
