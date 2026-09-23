import { useState } from "react";
import type { WorkbenchClient, WorkbenchRpcResult, WorkRequest } from "@vermillion/workbench/client";
import { Button, DetailSection, InlineNotice } from "./ui.js";

export const SupervisorDetails = ({ request, client, workspaceId, onOpenSession }: {
  request: WorkRequest; client: WorkbenchClient; workspaceId: string; onOpenSession: (sessionId: string) => void;
}) => {
  const [runtime, setRuntime] = useState<WorkbenchRpcResult<"runtime.info">>();
  const [error, setError] = useState<string>();
  const supervisor = request.supervisor;
  const readRuntime = async () => {
    try { setRuntime(await client.request("runtime.info", {})); setError(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <DetailSection title="监工">
    <div className="space-y-2">
      <p>{supervisor?.activeTurnId ? "正在检查" : request.paused ? "工作已暂停" : supervisor?.nextCheckAt ? "等待下次检查" : supervisor?.sessionId ? "检查已停止" : "尚未创建"}</p>
      {supervisor?.sessionId && <Button size="sm" variant="ghost" outlined onClick={() => onOpenSession(supervisor.sessionId!)}>监工会话</Button>}
      <DetailSection title="最近检查">{supervisor?.lastCheckedAt ? new Date(supervisor.lastCheckedAt).toLocaleString("zh-CN") : "尚无记录"}</DetailSection>
      <DetailSection title="下次检查">{supervisor?.nextCheckAt ? new Date(supervisor.nextCheckAt).toLocaleString("zh-CN") : "未安排"}</DetailSection>
      {supervisor?.failure && <InlineNotice tone="error" className="px-0">{supervisor.failure}</InlineNotice>}
      <Button size="sm" variant="ghost" outlined onClick={() => void readRuntime()}>运行环境</Button>
      {runtime && <DetailSection title="运行环境"><p>{runtime.schedulerOnline ? "调度在线" : "调度离线"}</p><p className="break-all font-mono text-caption">{runtime.buildId} · PID {runtime.pid}</p><p className="text-caption text-muted-foreground">{new Date(runtime.startedAt).toLocaleString("zh-CN")} · {workspaceId}</p></DetailSection>}
      {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
    </div>
  </DetailSection>;
};
