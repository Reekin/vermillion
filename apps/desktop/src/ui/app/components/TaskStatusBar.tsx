import { ListTodo } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, EmptyState, InlineNotice, ListRow, PanelHeader, StatusBar } from "./ui.js";
import { statusLabel } from "./task-labels.js";
import { useT } from "../../../i18n/react.js";

export const TaskStatusBar = ({ store, trailing }: { store: WorkbenchStore; trailing?: ReactNode }) => {
  const t = useT();
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

  const notice = result && (result.kind === "commit" ? t("app.status.committed", { message: result.message }) : t("app.status.started", { title: result.title }));
  return (
    <StatusBar icon={ListTodo} label={t("app.status.count", { count: tasks.length })} notice={notice} open={open} onOpenChange={setOpen} trailing={trailing}>
      <PanelHeader title={t("app.status.title")} />
      {error ? <InlineNotice tone="error">{t("app.status.loadFailed", { error })}</InlineNotice> : tasks.length === 0 && <EmptyState title={t("app.status.empty")} />}
      <ul>
        {tasks.map((task) => {
          const row = (
            <ListRow
              className="min-w-0 flex-1"
              title={task.title}
              meta={workspaces.find((w) => w.workspaceId === task.workspaceId)?.label}
              trailing={<Badge>{statusLabel(task.status)}</Badge>}
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
                }}>{t("app.status.enterSession")}</Button>}
              </span>
            </li>
          );
        })}
      </ul>
    </StatusBar>
  );
};
