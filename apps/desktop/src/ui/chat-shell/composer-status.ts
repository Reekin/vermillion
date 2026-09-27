import type { ApprovalRequest, ChatSession } from "@vermillion/shared";
import { t } from "../../i18n/index.js";

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
      summary: t("session.reconnectFailed")
    },
    {
      value: chatTreeRefresh,
      source: "chat-tree",
      key: "chatTreeRefreshSessionId",
      summary: t("session.treeRefreshFailed")
    }
  ] as const;
  for (const { value, source, key, summary } of recoveries) {
    if (!value || typeof value !== "object" || !("status" in value)) continue;
    if (value.status === "failed" && (!current || current.source === source)) {
      const message = "message" in value && typeof value.message === "string"
        ? value.message : t("session.unknownError");
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
      label: t("session.statusAwaitingApproval"),
      detail: t("session.awaitingApprovalFor", { requestId: pendingApproval.requestId })
    };
  }

  if (input.activeSession?.status === "running") {
    return {
      kind: "running",
      label: t("session.statusRunning"),
      detail: input.supportsSteer ? t("session.runningCanSteer") : t("session.runningWillQueue")
    };
  }

  if (input.activeSession?.status === "error") {
    return {
      kind: "error",
      label: t("session.statusNeedsAttention"),
      detail: t("session.sessionErrored", { sessionId: input.activeSession.sessionId })
    };
  }

  if ((input.queuedCount ?? 0) > 0 && input.activeSession) {
    return {
      kind: "queue_pending",
      label: t("session.queuedCount", { count: input.queuedCount ?? 0 }),
      detail: t("session.sendWhenIdle")
    };
  }

  if (input.activeSession) {
    return {
      kind: "idle",
      label: t("session.statusReady"),
      detail: t("session.sessionId", { sessionId: input.activeSession.sessionId })
    };
  }

  if (input.selectedEngineId) {
    return {
      kind: "no_session",
      label: t("session.statusReady"),
      detail: t("session.newSessionEngine", { engineId: input.selectedEngineId })
    };
  }

  return {
    kind: "no_session",
    label: t("session.statusReady")
  };
};

export const resolveComposerStatus = (
  input: ResolveComposerStatusInput
): string => {
  const model = resolveComposerStatusModel(input);
  return model.detail ? `${model.label}: ${model.detail}` : model.label;
};
