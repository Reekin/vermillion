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
  const refreshInbox = store((s) => s.refreshInbox);
  const [busy, setBusy] = useState(false);
  const answer = async (key: string) => {
    setBusy(true);
    try {
      await client.request("decision.answer", { workspaceId: item.workspaceId, decisionId: item.card.decisionId, key });
      await refreshInbox();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2"><Badge tone="warning">决策</Badge><span className="text-body font-medium">{item.card.question}</span></div>
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
  const refreshInbox = store((s) => s.refreshInbox);
  const [busy, setBusy] = useState(false);
  const setStatus = async (status: "closed" | "queued") => {
    setBusy(true);
    try {
      await client.request("workItem.update", { workspaceId: item.workspaceId, workItemId: item.workItem.workItemId, status });
      await refreshInbox();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2"><Badge tone="brand">验收</Badge><span className="text-body font-medium">{item.workItem.title}</span><Badge>{item.workItem.risk}</Badge></div>
      <p className="mt-1 text-caption text-muted-foreground">任务：{item.mission.title}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void setStatus("closed")}>通过</Button>
        <Button size="sm" disabled={busy} onClick={() => void setStatus("queued")}>打回</Button>
      </div>
    </div>
  );
};
