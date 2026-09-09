import { useEffect, useMemo, useState } from "react";
import type { WorkbenchClient, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { ChatTreePanel, type ChatTreePanelProps } from "../../chat-shell/ChatTreePanel.js";
import { projectChatTreeWorkers } from "../chat-tree-workers.js";
import { statusLabel } from "./task-labels.js";
import { Badge, InlineNotice, ListRow, SectionLabel } from "./ui.js";

type Props = ChatTreePanelProps & {
  client: WorkbenchClient;
  onSelectSession: (sessionId: string) => void;
};

export const WorkbenchChatTree = ({ client, onSelectSession, ...props }: Props) => {
  const workspaceId = props.chatTree?.windows?.flatMap((window) => window.snapshot.conversations).find((conversation) => conversation.workspaceId)?.workspaceId;
  const [records, setRecords] = useState<{ workspaceId?: string; items: WorkItem[]; requests: WorkRequest[]; error?: string }>({ items: [], requests: [] });
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const [items, requests] = await Promise.all([
          client.request("workItem.list", { workspaceId }),
          client.request("work.list", { workspaceId })
        ]);
        if (active && request === generation) setRecords({ workspaceId, items, requests });
      } catch (error) {
        if (active && request === generation) setRecords((current) => ({ ...(current.workspaceId === workspaceId ? current : { items: [], requests: [] }), workspaceId, error: (error as Error).message }));
      }
    };
    const unsubscribe = client.subscribe((event) => {
      if ((event.type === "workItems.changed" || event.type === "workRequests.changed") && event.workspaceId === workspaceId) void refresh();
    });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [client, workspaceId]);
  const current = records.workspaceId === workspaceId ? records : undefined;
  const { tree, workers } = useMemo(() => projectChatTreeWorkers(props.chatTree, current?.items ?? [], current?.requests ?? []), [props.chatTree, current]);
  return <ChatTreePanel {...props} chatTree={tree} highlightedNodeIds={workers.flatMap((worker) => worker.nodeIds)}
    renderNodeStatus={(status) => <Badge>{status}</Badge>}
    footer={(workers.length > 0 || current?.error) && <div className="max-h-60 shrink-0 overflow-auto border-t border-border">
      <SectionLabel>Worker</SectionLabel>
      {current?.error && <InlineNotice tone="error">{current.error}</InlineNotice>}
      <ul>{workers.map((worker) => <li key={worker.key}>
        <ListRow title={worker.title} meta={worker.failure} selected={worker.sessionId === props.chatTree?.currentSessionId}
          trailing={<Badge status={worker.status === "failed" ? "decision" : worker.status}>{worker.status === "failed" ? "失败" : statusLabel[worker.status]}</Badge>}
          onClick={worker.sessionId ? () => worker.nodeId ? props.onJump?.(worker.nodeId) : onSelectSession(worker.sessionId!) : undefined} />
      </li>)}</ul>
    </div>} />;
};
