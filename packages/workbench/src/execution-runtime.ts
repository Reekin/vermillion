import type { Execution, WorkItem, WorkRequest } from "./contracts.js";

/** Host facts used by business dispatch and read-only reconciliation. */
export type TurnInspection = {
  status: "active" | "completed" | "unknown";
  finishReason?: "completed" | "failed" | "interrupted";
  failure?: string;
};
export type TurnInspector = (sessionId: string, turnId: string) => Promise<TurnInspection>;
export type SessionReceipt = {
  accepted?: boolean;
  turnId?: string;
  messageId?: string;
  delivery?: "started" | "steered";
  error?: { code: string; message: string };
};

export type BusinessTarget = { workItemId: string } | { requestId: string };
export type BusinessDispatch = {
  automatic?: boolean;
  decisionId?: string;
  prepare: (owner: { item?: WorkItem; request?: WorkRequest; state: Execution | WorkRequest; sessionId?: string }) => Promise<{ sessionId: string; content: string }>;
  send: (sessionId: string, content: string, messageId: string) => Promise<void | SessionReceipt>;
  confirm?: (sessionId: string, messageId: string) => Promise<{ accepted: boolean; turnId?: string; active?: boolean }>;
};
export type BusinessDispatchResult = {
  status: "delivered" | "active" | "blocked" | "failed" | "unconfirmed" | "idle";
  reason?: string;
};
