import type { ApprovalRequest, ChatSession } from "@vermillion/shared";

export type ComposerStatusNotice = {
  message: string;
  /** Original text from the engine or system; shown in the technical details, not in the message. */
  detail?: string;
  /** Engine that ran the operation; used to attribute engine configuration warnings. */
  engineId?: string;
  /** Session the notice concerns; the output offers to open it. */
  sessionId?: string;
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
      summary: "会话重新连接失败，点「恢复」重试"
    },
    {
      value: chatTreeRefresh,
      source: "chat-tree",
      key: "chatTreeRefreshSessionId",
      summary: "刷新会话树失败"
    }
  ] as const;
  for (const { value, source, key, summary } of recoveries) {
    if (!value || typeof value !== "object" || !("status" in value)) continue;
    if (value.status === "failed" && (!current || current.source === source)) {
      const message = "message" in value && typeof value.message === "string"
        ? value.message : "未知错误";
      current = {
        message: summary,
        detail: message,
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
      label: "等待审批",
      detail: `等待审批：${pendingApproval.requestId}`
    };
  }

  if (input.activeSession?.status === "running") {
    return {
      kind: "running",
      label: "运行中",
      detail: input.supportsSteer ? "可补充到当前轮次" : "新消息会排队"
    };
  }

  if (input.activeSession?.status === "error") {
    return {
      kind: "error",
      label: "需要处理",
      detail: `会话 ${input.activeSession.sessionId} 出现错误。`
    };
  }

  if ((input.queuedCount ?? 0) > 0 && input.activeSession) {
    return {
      kind: "queue_pending",
      label: `${input.queuedCount} 条排队`,
      detail: "空闲后自动发送"
    };
  }

  if (input.activeSession) {
    return {
      kind: "idle",
      label: "就绪",
      detail: `会话 ${input.activeSession.sessionId}`
    };
  }

  if (input.selectedEngineId) {
    return {
      kind: "no_session",
      label: "就绪",
      detail: `新会话引擎：${input.selectedEngineId}`
    };
  }

  return {
    kind: "no_session",
    label: "就绪"
  };
};

export const resolveComposerStatus = (
  input: ResolveComposerStatusInput
): string => {
  const model = resolveComposerStatusModel(input);
  return model.detail ? `${model.label}: ${model.detail}` : model.label;
};
