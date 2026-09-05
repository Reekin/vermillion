import { useState } from "react";
import type { InboxItem } from "@vermillion/workbench/client";
import type { WorkbenchStore } from "../workbench-store.js";
import { Badge, Button, Empty } from "./ui.js";

export const InboxPanel = ({ store }: { store: WorkbenchStore }) => {
  const inbox = store((s) => s.inbox);
  if (inbox.length === 0) {
    return <Empty title="没有待处理事项" hint="决策卡和待验收的工单会出现在这里。" />;
  }
  return (
    <ul className="divide-y divide-border">
      {inbox.map((item) => (
        <li key={item.kind === "decision" ? item.card.decisionId : item.workItem.workItemId} className="px-4 py-3">
          {item.kind === "decision" ? <DecisionRow store={store} item={item} /> : <ReviewRow store={store} item={item} />}
        </li>
      ))}
    </ul>
  );
};

const DecisionRow = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "decision" }> }) => {
  const client = store((s) => s.client);
  const [busy, setBusy] = useState(false);
  const answer = async (key: string) => {
    setBusy(true);
    try {
      await client.request("decision.answer", { workspaceId: item.workspaceId, decisionId: item.card.decisionId, key });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2"><Badge tone="accent">决策</Badge><span className="text-body text-strong">{item.card.question}</span></div>
      {item.card.context && <p className="mt-1 whitespace-pre-wrap text-caption text-muted-foreground">{item.card.context}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {item.card.options.map((option) => (
          <Button key={option.key} size="sm" variant={option.key === item.card.recommended ? "primary" : "secondary"} disabled={busy} onClick={() => void answer(option.key)} title={option.detail}>
            {option.label}{option.key === item.card.recommended ? "（推荐）" : ""}
          </Button>
        ))}
      </div>
    </div>
  );
};

const ReviewRow = ({ store, item }: { store: WorkbenchStore; item: Extract<InboxItem, { kind: "review" }> }) => {
  const client = store((s) => s.client);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { workItem } = item;
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <Badge tone="accent">验收</Badge>
        <span className="text-body text-strong">{workItem.title}</span>
        <Badge>{workItem.risk}</Badge>
        {workItem.rejections.length > 0 && <Badge>第 {workItem.rejections.length + 1} 轮</Badge>}
      </div>
      <p className="mt-1 text-caption text-muted-foreground">任务：{item.mission.title}</p>
      {workItem.evidence && (
        <div className="mt-2 rounded-md border border-border bg-input px-3 py-2">
          <div className="eyebrow mb-1 px-0 pt-0">证据</div>
          <p className="whitespace-pre-wrap text-caption text-foreground">{workItem.evidence.summary}</p>
          {workItem.evidence.assumptions.length > 0 && <p className="mt-1 text-caption text-muted-foreground">假设：{workItem.evidence.assumptions.join("；")}</p>}
          {workItem.evidence.untested.length > 0 && <p className="mt-1 text-caption text-muted-foreground">未测：{workItem.evidence.untested.join("；")}</p>}
        </div>
      )}
      {workItem.verify && (
        <ul className="mt-2 space-y-0.5">
          {workItem.verify.items.map((v) => (
            <li key={v.index} className="flex gap-2 text-caption">
              <span className="w-8 shrink-0 font-mono text-accent-strong">{v.pass ? "PASS" : "FAIL"}</span>
              <span className="text-muted-foreground">{workItem.acceptance[v.index] ? workItem.acceptance[v.index]!.then : "#" + v.index}</span>
            </li>
          ))}
        </ul>
      )}
      {workItem.review.some((r) => r.decision === "rejected") && (
        <p className="mt-1 text-caption text-faint-foreground">已拒绝的 review 意见：{workItem.review.filter((r) => r.decision === "rejected").map((r) => r.comment + "（" + r.reason + "）").join("；")}</p>
      )}
      {rejecting ? (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) return;
            void run(() => client.request("workItem.reject", { workspaceId: item.workspaceId, workItemId: workItem.workItemId, reason: reason.trim() }));
          }}
        >
          <input
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="打回原因（会写进工单）"
            className="h-7 min-w-0 flex-1 rounded-lg border border-control-border bg-input px-2 text-label text-foreground outline-none focus:border-control-border-hover"
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !reason.trim()}>确认打回</Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>取消</Button>
        </form>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => client.request("workItem.approve", { workspaceId: item.workspaceId, workItemId: workItem.workItemId }))}>通过</Button>
          <Button size="sm" disabled={busy} onClick={() => setRejecting(true)}>打回</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => client.request("workItem.cancel", { workspaceId: item.workspaceId, workItemId: workItem.workItemId }))}>不做</Button>
        </div>
      )}
    </div>
  );
};
