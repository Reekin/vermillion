import type { ApprovalRequest, ChatSession } from "@vermillion/shared";

export type ComposerStatusNotice = {
  message: string;
  severity?: "info" | "warning" | "error";
  persistent?: boolean;
  stack?: string;
  context?: Record<string, unknown>;
  source?:
    | "engine-list"
    | "engine-select"
    | "subscription"
    | "send"
    | "create-session"
    | "approval"
    | "workspace-add"
    | "workspace-action"
    | "session-browser"
    | "session-action"
    | "chat-tree"
    | "delegation"
    | "settings";
};

export const statusNoticeErrorDetails = (
  error: unknown
): Pick<ComposerStatusNotice, "severity" | "stack"> => ({
  severity: "error",
  stack: error instanceof Error ? error.stack : undefined
});

export const resolveRecoveryNotice = (
  current: ComposerStatusNotice | undefined,
  sessionId: string,
  executionRecovery: unknown,
  chatTreeRefresh: unknown
): ComposerStatusNotice | undefined => {
  const recoveries = [
    {
      value: executionRecovery,
      source: "session-browser",
      key: "executionRecoverySessionId",
      prefix: "Session reconnect failed: ",
      suffix: ". Use Resume to retry."
    },
    {
      value: chatTreeRefresh,
      source: "chat-tree",
      key: "chatTreeRefreshSessionId",
      prefix: "Chat tree refresh failed: ",
      suffix: ""
    }
  ] as const;
  for (const { value, source, key, prefix, suffix } of recoveries) {
    if (!value || typeof value !== "object" || !("status" in value)) continue;
    if (value.status === "failed" && (!current || current.source === source)) {
      const message = "message" in value && typeof value.message === "string"
        ? value.message : "Unknown error";
      current = {
        message: `${prefix}${message}${suffix}`,
        persistent: true,
        source,
        severity: "error",
        context: { [key]: sessionId }
      };
    } else if (value.status === "ready" && current?.context?.[key] === sessionId) {
      current = undefined;
    }
  }
  return current;
};

export type ResolveComposerStatusInput = {
  selectedEngineId?: string;
  activeSession?: ChatSession;
  approvals?: ApprovalRequest[];
  notice?: ComposerStatusNotice;
  queuedCount?: number;
  supportsSteer?: boolean;
};

export type ComposerStatusModel = {
  kind:
    | "no_session"
    | "idle"
    | "running"
    | "awaiting_approval"
    | "error"
    | "queue_pending"
    | "notice";
  label: string;
  detail?: string;
};

const firstPendingApproval = (
  approvals: ApprovalRequest[] | undefined
): ApprovalRequest | undefined => approvals?.find((approval) => approval.status === "pending");

export const resolveComposerStatusModel = (
  input: ResolveComposerStatusInput
): ComposerStatusModel => {
  const pendingApproval = firstPendingApproval(input.approvals);
  if (input.activeSession?.status === "awaiting_approval" && pendingApproval) {
    return {
      kind: "awaiting_approval",
      label: "Awaiting approval",
      detail: `Approval requested for ${pendingApproval.requestId}`
    };
  }

  if (input.activeSession?.status === "running") {
    return {
      kind: "running",
      label: "Running",
      detail: input.supportsSteer ? "Steer supported" : "Queue only"
    };
  }

  if (input.activeSession?.status === "error") {
    return {
      kind: "error",
      label: "Attention",
      detail: `Session ${input.activeSession.sessionId} has errors.`
    };
  }

  if ((input.queuedCount ?? 0) > 0 && input.activeSession) {
    return {
      kind: "queue_pending",
      label: `${input.queuedCount} queued`,
      detail: "Will auto-send when idle"
    };
  }

  if (input.activeSession) {
    return {
      kind: "idle",
      label: "Ready",
      detail: `In ${input.activeSession.sessionId}`
    };
  }

  if (input.selectedEngineId) {
    return {
      kind: "no_session",
      label: "No thread selected",
      detail: `Selected engine: ${input.selectedEngineId}`
    };
  }

  return {
    kind: "no_session",
    label: "Ready"
  };
};

export const resolveComposerStatus = (
  input: ResolveComposerStatusInput
): string => {
  const model = resolveComposerStatusModel(input);
  return model.detail ? `${model.label}: ${model.detail}` : model.label;
};
