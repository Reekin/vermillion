import { useEffect, useMemo, useState } from "react";
import type { WorkbenchClient, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import type { ChatTreeNodeActionInput } from "@vermillion/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { ChatTreePanel, type ChatTreePanelProps } from "../../chat-shell/ChatTreePanel.js";
import { writeClipboardText } from "../../chat-shell/clipboard.js";
import { projectChatTreeWorkers } from "../chat-tree-workers.js";
import type { SessionMenu } from "../use-session-actions.js";
import { SessionActionFeedback } from "./SessionActionFeedback.js";
import { ContextMenu } from "./ContextMenu.js";
import { statusLabel } from "./task-labels.js";
import { Badge, InlineNotice, ListRow, SectionLabel, Toggle } from "./ui.js";

type Props = ChatTreePanelProps & {
  client: WorkbenchClient;
  transport: DesktopTransport;
  onSelectSession: (sessionId: string) => void;
  onCancelOperation: (operationId: string, action: "cancel" | "remove") => Promise<void>;
};

export const WorkbenchChatTree = ({ client, transport, onSelectSession, onCancelOperation, ...props }: Props) => {
  const [expandedTree, setExpandedTree] = useState<string>();
  const [menu, setMenu] = useState<SessionMenu & { nodeId: string }>();
  const [operationMenu, setOperationMenu] = useState<{
    operationId: string; action: "cancel" | "remove"; x: number; y: number;
  }>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const treeId = props.chatTree?.treeId ?? props.chatTree?.sessionId;
  useEffect(() => { setMenu(undefined); setOperationMenu(undefined); setNotice(undefined); }, [treeId]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(undefined), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  const runNodeAction = async (action: ChatTreeNodeActionInput["action"]) => {
    if (!menu) return;
    try {
      const result = await transport.chatTree.nodeAction({ sessionId: menu.sessionId, nodeId: menu.nodeId, action });
      if (result.action === "copy_session_id" || result.action === "copy_awb_session_id") {
        try {
          await writeClipboardText(result.copiedText);
        } catch {
          throw new Error("无法写入剪贴板，请重试。");
        }
        setNotice({ text: "已复制 " + result.copiedText });
      } else if (result.action === "open_rollout") {
        await transport.file.runAction({ path: result.rolloutPath, action: "open" });
      }
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    }
  };
  const runOperationAction = async () => {
    if (!operationMenu) return;
    const { operationId, action } = operationMenu;
    setOperationMenu(undefined);
    try {
      await onCancelOperation(operationId, action);
      setNotice({ text: action === "cancel" ? "已取消发送" : "已移除失败发送" });
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    }
  };
  const showAll = !!treeId && expandedTree === treeId;
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
  const { tree, workers, activeWorkers } = useMemo(() => projectChatTreeWorkers(props.chatTree, current?.items ?? [], current?.requests ?? [], showAll), [props.chatTree, current, showAll]);
  return <><ChatTreePanel {...props} chatTree={tree} nodeMarkers={Object.fromEntries(workers.flatMap((worker) => worker.nodeIds.map((id) => [id, "W"])))}
    onNodeContextMenu={(event, nodeId) => {
      event.preventDefault();
      const node = props.chatTree?.nodes.find((item) => item.nodeId === nodeId);
      if (!node?.sessionId || !props.chatTree) return;
      setMenu({ sessionId: props.chatTree.sessionId, nodeId, x: event.clientX, y: event.clientY, actions: [
        { action: "copy_session_id", label: "复制 session id" },
        { action: "copy_awb_session_id", label: "复制内部 session id" },
        { action: "open_rollout", label: "Open rollout" },
        { action: "archive", label: "删除分支", disabled: !node.canArchive }
      ] });
    }}
    onOperationContextMenu={(event, operationId) => {
      event.preventDefault();
      const operation = props.operations?.find((item) => item.operationId === operationId);
      if (!operation || operation.status === "sent") return;
      setMenu(undefined);
      setOperationMenu({ operationId, action: operation.status === "failed" ? "remove" : "cancel",
        x: event.clientX, y: event.clientY });
    }}
    header={workers.length > 0 && <div className="border-b border-border px-3 py-2"><Toggle label="显示全部 Worker" checked={showAll} onChange={(checked) => setExpandedTree(checked ? treeId : undefined)} /></div>}
    renderNodeStatus={(status) => <Badge>{status}</Badge>}
    footer={(activeWorkers.length > 0 || current?.error) && <div className="max-h-60 shrink-0 overflow-auto border-t border-border">
      <SectionLabel>Worker</SectionLabel>
      {current?.error && <InlineNotice tone="error">{current.error}</InlineNotice>}
      <ul>{activeWorkers.map((worker) => <li key={worker.key}>
        <ListRow title={worker.title} meta={worker.failure} selected={worker.sessionId === props.chatTree?.currentSessionId}
          trailing={<Badge status={worker.status === "failed" ? "decision" : worker.status}>{worker.status === "failed" ? "失败" : statusLabel[worker.status]}</Badge>}
          onClick={worker.sessionId ? () => worker.nodeId ? props.onJump?.(worker.nodeId) : onSelectSession(worker.sessionId!) : undefined} />
      </li>)}</ul>
    </div>} />
    <SessionActionFeedback menu={menu} onCloseMenu={() => setMenu(undefined)}
      onRunAction={(_sessionId, action) => {
        if (action === "copy_session_id" || action === "copy_awb_session_id" || action === "open_rollout" || action === "archive") void runNodeAction(action);
      }} notice={notice} onClearNotice={() => setNotice(undefined)} />
    {operationMenu && <ContextMenu x={operationMenu.x} y={operationMenu.y}
      onClose={() => setOperationMenu(undefined)} items={[{
        key: operationMenu.action,
        label: operationMenu.action === "cancel" ? "取消发送" : "移除",
        onSelect: () => { void runOperationAction(); }
      }]} />}
  </>;
};
