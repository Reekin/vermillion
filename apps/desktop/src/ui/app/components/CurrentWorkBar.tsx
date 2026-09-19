import { useState } from "react";
import type { DecisionCard, WorkRequest, WorkItem, WorkbenchClient } from "@vermillion/workbench/client";
import { Badge, Button, Field, InlineNotice } from "./ui.js";

type Props = {
  client: WorkbenchClient;
  workspaceId: string;
  sessionId?: string;
  request?: WorkRequest;
  item?: WorkItem;
  decision?: DecisionCard;
};

const requestLabel = (request: WorkRequest): string => {
  if (request.control === "paused") return "已暂停";
  if (request.status === "failed") return "工作受阻";
  if (request.control === "manual") return "人工接管";
  if (request.status === "preparing") return "准备中";
  if (request.status === "pending") return "等待准备";
  return "已交接";
};

const itemLabel = (item: WorkItem): string => {
  if (item.run.pauseReason === "user" || item.run.control === "paused") return "已暂停";
  if (item.run.control === "manual") return "人工接管";
  if (item.status === "decision") return item.run.waitReason?.includes("故障") || item.run.waitReason?.includes("工作受阻") || item.run.waitReason?.includes("次数") ? "工作受阻" : "等待决策";
  if (item.status === "queued") return item.run.retryAt ? "等待重试" : "排队中";
  if (item.status === "running") return "执行中";
  if (item.status === "preparing") return "准备中";
  return item.status === "merging" ? "等待合入" : item.status;
};

export const CurrentWorkBar = ({ client, workspaceId, sessionId, request, item, decision }: Props) => {
  const [answer, setAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  if (!request && !item) return null;
  const title = item?.title ?? request?.scope?.trim() ?? "当前工作";
  const label = item ? itemLabel(item) : requestLabel(request!);
  const reason = item?.run.waitReason ?? item?.run.lastFailure ?? request?.waitReason ?? request?.failure;
  const paused = item ? item.run.pauseReason === "user" || item.run.control === "paused" : request?.control === "paused";
  const manual = item ? item.run.control === "manual" : request?.control === "manual";
  const busy = false;
  const invoke = async (method: "work.pause" | "work.resume" | "work.retry" | "work.cancel" | "work.confirm" | "workItem.pause" | "workItem.resume" | "workItem.retry" | "workItem.cancel" | "workItem.confirm") => {
    if (method.startsWith("workItem") && item) {
      if (method === "workItem.pause") await client.request(method, { workspaceId, workItemId: item.workItemId });
      else await client.request(method, { workspaceId, workItemId: item.workItemId });
    } else if (request) {
      await client.request(method, { workspaceId, requestId: request.requestId });
    }
  };
  const submitAnswer = async () => {
    if (!decision || !answer.trim()) return;
    setAnswering(true);
    try { await client.request("decision.answer", { workspaceId, decisionId: decision.decisionId, note: answer.trim() }); setAnswer(""); }
    catch { /* The Inbox remains the durable retry surface for a failed delivery. */ }
    finally { setAnswering(false); }
  };
  return <div className="flex min-w-0 items-center gap-2 border-b border-border bg-surface px-3 py-2 text-caption">
    <span className="shrink-0 text-muted-foreground">当前工作</span>
    <span className="min-w-0 truncate text-foreground" title={title}>{title}</span>
    <Badge status={label === "执行中" ? "running" : label === "排队中" ? "queued" : label === "已暂停" || label === "等待决策" || label === "工作受阻" ? "decision" : "preparing"}>{label}</Badge>
    {reason && <InlineNotice tone={label === "工作受阻" ? "error" : "muted"} className="min-w-0 truncate">{reason}</InlineNotice>}
    {decision && <div className="flex min-w-48 items-center gap-1" title={decision.question}><Field aria-label="回复当前决策" compact value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="回复此决策" /><Button size="sm" variant="ghost" disabled={answering || !answer.trim()} onClick={() => void submitAnswer()}>答复</Button></div>}
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {reason?.includes("受理状态不明") ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invoke(item ? "workItem.confirm" : "work.confirm")}>确认状态</Button>
        : paused ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invoke(item ? "workItem.resume" : "work.resume")}>恢复</Button>
        : manual && label !== "等待决策" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invoke(item ? "workItem.retry" : "work.resume")}>恢复自动推进</Button>
        : label === "工作受阻" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invoke(item ? "workItem.retry" : "work.retry")}>重试</Button>
        : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invoke(item ? "workItem.pause" : "work.pause")}>暂停</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invoke(item ? "workItem.cancel" : "work.cancel")}>取消</Button>
    </span>
  </div>;
};
