import { useState } from "react";
import type { WorkbenchClient, WorkbenchRpcResult, WorkRequest } from "@vermillion/workbench/client";
import { formatDateTime } from "../../../i18n/format.js";
import { useT } from "../../../i18n/react.js";
import { Button, DetailSection, InlineNotice } from "./ui.js";

export const SupervisorDetails = ({ request, client, workspaceId, onOpenSession }: {
  request: WorkRequest; client: WorkbenchClient; workspaceId: string; onOpenSession: (sessionId: string) => void;
}) => {
  const t = useT();
  const [runtime, setRuntime] = useState<WorkbenchRpcResult<"runtime.info">>();
  const [error, setError] = useState<string>();
  const supervisor = request.supervisor;
  const readRuntime = async () => {
    try { setRuntime(await client.request("runtime.info", {})); setError(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <DetailSection title={t("work.role.supervisor")}>
    <div className="space-y-2">
      <p>{supervisor?.activeTurnId ? t("work.supervisor.checking") : request.paused ? t("work.attention.workPaused") : supervisor?.nextCheckAt ? t("work.supervisor.waitingNext")
        : supervisor?.sessionId ? t("work.supervisor.stopped") : t("work.supervisor.notCreated")}</p>
      {supervisor?.sessionId && <Button size="sm" variant="ghost" outlined onClick={() => onOpenSession(supervisor.sessionId!)}>{t("work.supervisor.session")}</Button>}
      <DetailSection title={t("work.supervisor.lastCheck")}>{supervisor?.lastCheckedAt ? formatDateTime(supervisor.lastCheckedAt) : t("work.supervisor.noRecord")}</DetailSection>
      <DetailSection title={t("work.supervisor.nextCheck")}>{supervisor?.nextCheckAt ? formatDateTime(supervisor.nextCheckAt) : t("work.supervisor.notScheduled")}</DetailSection>
      {supervisor?.failure && <InlineNotice tone="error" className="px-0">{supervisor.failure}</InlineNotice>}
      <Button size="sm" variant="ghost" outlined onClick={() => void readRuntime()}>{t("work.supervisor.runtime")}</Button>
      {runtime && <DetailSection title={t("work.supervisor.runtime")}><p>{runtime.schedulerOnline ? t("work.supervisor.schedulerOnline") : t("work.supervisor.schedulerOffline")}</p><p className="break-all font-mono text-caption">{runtime.buildId} · PID {runtime.pid}</p><p className="text-caption text-muted-foreground">{formatDateTime(runtime.startedAt)} · {workspaceId}</p></DetailSection>}
      {error && <InlineNotice tone="error" className="px-0">{error}</InlineNotice>}
    </div>
  </DetailSection>;
};
