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
