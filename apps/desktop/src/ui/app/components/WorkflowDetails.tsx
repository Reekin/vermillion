import { isUserPaused, type WorkflowAction } from "@vermillion/workbench/client";
import { Badge, Button, DetailSection } from "./ui.js";
import { actionKindLabel, actionStatusText, recoveryCondition, actionRoleLabel } from "./workflow-display.js";

export const WorkflowDetails = ({ actions, onOpenSession }: { actions: WorkflowAction[]; onOpenSession: (id: string) => void }) => <>
  {actions.map((action) => <DetailSection key={action.actionId} title={actionKindLabel[action.kind]}>
    <div className="flex flex-wrap items-center gap-2">
      {!isUserPaused(action) && <Badge>{actionStatusText(action)}</Badge>}<span>{actionRoleLabel(action)}</span>
      {action.kind === "execute" && action.sessionId && <Button variant="ghost" outlined size="sm" onClick={() => onOpenSession(action.sessionId!)}>处理会话</Button>}
    </div>
    <DetailSection title="问题">{action.message}</DetailSection>
    {action.status !== "done" && action.status !== "cancelled" && <>
      <DetailSection title="等待条件">{recoveryCondition(action)}</DetailSection>
      <DetailSection title="下一次重试">{action.retryAt ? new Date(action.retryAt).toLocaleString("zh-CN") : "未安排定时重试"}</DetailSection>
    </>}
    {!isUserPaused(action) && <DetailSection title="最近处置">{action.history.at(-1)?.message ?? "等待处理者接手"}</DetailSection>}
    {!isUserPaused(action) && action.history.length > 0 && <DetailSection title="问题历史">{action.history.map((entry, index) => <div key={index} className="mb-2">
      <span className="font-mono text-caption text-muted-foreground">{new Date(entry.at).toLocaleString("zh-CN")}</span>
      <p>{entry.message}</p>
    </div>)}</DetailSection>}
  </DetailSection>)}
</>;
