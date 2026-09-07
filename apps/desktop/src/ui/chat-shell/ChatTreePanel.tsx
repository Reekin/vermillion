import { useMemo, type ReactElement } from "react";
import type { ChatTreeSendOperation, ChatTreeSnapshotRpc } from "@vermillion/shared";
import { buildChatTreeGraphLayout } from "./chat-tree-layout.js";
import { Badge } from "../app/components/ui.js";

const NODE_RADIUS = 7;
const CONNECTOR_CURVE_OFFSET = 24;

export type ChatTreePanelProps = {
  operations?: ChatTreeSendOperation[];
  chatTree?: ChatTreeSnapshotRpc;
  loading?: boolean;
  error?: string;
  onJump?: (nodeId: string) => void;
};

const shortLabel = (node: ChatTreeSnapshotRpc["nodes"][number]): string => {
  const value = node.label || node.turnId || node.nodeId;
  return value.length > 48 ? `${value.slice(0, 48)}...` : value;
};

export const ChatTreePanel = ({
  chatTree,
  loading = false,
  error,
  operations = [],
  onJump
}: ChatTreePanelProps): ReactElement => {
  const graph = useMemo(() => buildChatTreeGraphLayout(chatTree), [chatTree]);
  const canvasWidth = Math.max(graph.width, 180);
  const graphNodeById = useMemo(
    () => new Map(graph.nodes.map((entry) => [entry.node.nodeId, entry] as const)),
    [graph.nodes]
  );

  if (loading) {
    return <p className="awb-detail__empty">Loading chat tree…</p>;
  }

  if (error) {
    return <p className="awb-detail__empty">{error}</p>;
  }

  if (!chatTree) {
    return <p className="awb-detail__empty">Select a session to inspect its chat tree.</p>;
  }

  if (!chatTree.supportsJump || chatTree.nodes.length === 0) {
    return (
      <div className="awb-detail-card">
        <strong>Chat tree unavailable</strong>
        <p>This agent or session does not currently expose chat-tree data.</p>
      </div>
    );
  }

  return (
    <div className="awb-chat-tree">
      <div className="awb-chat-tree__graph-shell">
        <div
          className="awb-chat-tree__graph-canvas"
          style={{
            minWidth: `${canvasWidth}px`,
            minHeight: `${graph.height}px`
          }}
        >
          <svg
            className="awb-chat-tree__graph-svg"
            width={graph.width}
            height={graph.height}
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            aria-hidden="true"
          >
            {graph.edges.map((edge) => {
              const fromNode = graphNodeById.get(edge.fromNodeId);
              const toNode = graphNodeById.get(edge.toNodeId);
              if (!fromNode || !toNode) {
                return null;
              }

              const fromX = fromNode.x;
              const fromY = fromNode.y;
              const toX = toNode.x;
              const toY = toNode.y;
              const verticalGap = toY - fromY;
              const splitY = fromY + Math.min(verticalGap * 0.5, CONNECTOR_CURVE_OFFSET);
              const path =
                Math.abs(fromX - toX) < 0.5
                  ? `M ${fromX} ${fromY + NODE_RADIUS} L ${toX} ${toY - NODE_RADIUS}`
                  : `M ${fromX} ${fromY + NODE_RADIUS} C ${fromX} ${splitY} ${toX} ${splitY} ${toX} ${toY - NODE_RADIUS}`;

              return (
                <path
                  key={`${edge.fromNodeId}->${edge.toNodeId}`}
                  className="awb-chat-tree__graph-connector"
                  d={path}
                />
              );
            })}
          </svg>
          {graph.nodes.map((entry) => {
            const operation = operations.find((op) => op.operationId === entry.node.nodeId || (op.turnId && op.turnId === entry.node.turnId));
            const virtual = operation && !entry.node.turnId;
            const status = virtual ? operation.status === "failed" ? "发送失败"
              : operation.status === "creating" ? "正在创建分支" : "正在发送" : undefined;
            return (
            <button
              key={operation?.operationId ?? entry.node.nodeId}
              data-virtual={virtual ? "true" : undefined}
              type="button"
              className={`awb-chat-tree__graph-node${entry.isCurrent ? " is-current" : ""}${entry.node.status === "pending" ? " is-running" : ""}`}
              style={{
                left: `${entry.x}px`,
                top: `${entry.y}px`
              }}
              onDoubleClick={() => onJump?.(entry.node.nodeId)}
              title={`${shortLabel(entry.node)}${status ? `\n${status}` : ""}${
                entry.isCurrent ? "\nCurrent position." : "\nDouble-click to switch."
              }${entry.node.status === "pending" ? "\nRunning." : ""}`}
              aria-label={`${shortLabel(entry.node)}${status ? `, ${status}` : ""}${entry.isCurrent ? ", current position" : ""}${entry.node.status === "pending" ? ", running" : ""}`}
              aria-current={entry.isCurrent ? "step" : undefined}
            >
              <span className="awb-chat-tree__graph-node-dot" />
              {status && entry.isCurrent && <span className={`absolute top-full ${entry.x > canvasWidth / 2 ? "right-0" : "left-0"}`}><Badge>{status}</Badge></span>}
            </button>
          ); })}
        </div>
      </div>
    </div>
  );
};
