import { startTransition, useState, type ReactElement } from "react";
import type { ApprovalKind, ApprovalRequest, ApprovalStatus } from "@vermillion/shared";
import { Button, type ButtonVariant } from "./Button.js";
import { t, type MessageKey } from "../../i18n/index.js";
import { useT } from "../../i18n/react.js";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  resolveParticipantIdentity
} from "./participant-directory.js";

export type ApprovalAction = "approve" | "deny" | "defer";

export type ApprovalResponseInput = {
  sessionId: string;
  requestId: string;
  action: ApprovalAction;
  decision?: string | Record<string, unknown>;
  payload?: Record<string, unknown>;
};

export type ApprovalFlowViewProps = {
  chineseLabels?: boolean;
  approvals: ApprovalRequest[];
  participantDirectory?: ParticipantDirectory;
  onRespond?: (input: ApprovalResponseInput) => Promise<void>;
};

const defaultDirectory = buildParticipantDirectory([]);

const statusKeys: Record<ApprovalStatus, MessageKey> = {
  pending: "session.approvalPending",
  approved: "session.approvalApproved",
  denied: "session.approvalDenied",
  deferred: "session.approvalDeferred"
};

const kindKeys: Record<ApprovalKind, MessageKey> = {
  command: "session.approvalKindCommand",
  file_change: "session.approvalKindFileChange",
  tool: "session.approvalKindTool",
  custom: "session.approvalKindCustom"
};

const canRespond = (approval: ApprovalRequest): boolean => approval.status === "pending";

/** Known Codex approval requests get dictionary titles; other engines' titles are shown as sent. */
const approvalTitle = (approval: ApprovalRequest): string => {
  switch (approval.metadata?.protocolMethod) {
    case "item/fileChange/requestApproval":
      return t("session.approvalTitleFileChange");
    case "item/permissions/requestApproval":
      return t("session.approvalTitlePermissions");
    case "item/commandExecution/requestApproval":
      return t("session.approvalTitleCommand");
    default:
      return approval.title;
  }
};

const decisionLabel = (decision: unknown): string | undefined => {
  if (typeof decision === "string" && decision.trim().length > 0) {
    return decision.trim();
  }
  if (decision && typeof decision === "object" && !Array.isArray(decision)) {
    const [key] = Object.keys(decision);
    return key;
  }
  return undefined;
};

const decisionFromLabel = (
  approval: ApprovalRequest,
  label: string
): string | Record<string, unknown> => {
  const rawDecisions = Array.isArray(approval.metadata?.availableDecisions)
    ? approval.metadata.availableDecisions
    : [];
  const match = rawDecisions.find((decision) => decisionLabel(decision) === label);
  return match && typeof match === "object" && !Array.isArray(match)
    ? (match as Record<string, unknown>)
    : label;
};

const decisionButtonLabel = (label: string): string => {
  if (label === "accept") {
    return t("session.approve");
  }
  if (label === "acceptForSession") {
    return t("session.approveForSession");
  }
  if (label === "decline") {
    return t("session.decline");
  }
  if (label === "cancel") {
    return t("session.later");
  }
  return label.replace(/([a-z])([A-Z])/g, "$1 $2");
};

const actionForDecisionLabel = (label: string): ApprovalAction => {
  if (label === "decline") {
    return "deny";
  }
  if (label === "cancel") {
    return "defer";
  }
  return "approve";
};

const variantForDecisionLabel = (label: string): ButtonVariant => {
  const action = actionForDecisionLabel(label);
  return action === "deny" ? "danger" : action === "defer" ? "ghost" : "primary";
};

const decisionLabelsFor = (approval: ApprovalRequest): string[] => {
  const labels =
    approval.availableActions && approval.availableActions.length > 0
      ? approval.availableActions
      : Array.isArray(approval.metadata?.availableDecisions)
        ? approval.metadata.availableDecisions
            .map(decisionLabel)
            .filter((label): label is string => Boolean(label))
        : [];
  return [...new Set(labels)];
};

export const ApprovalFlowView = ({
  chineseLabels = false,
  approvals,
  participantDirectory = defaultDirectory,
  onRespond
}: ApprovalFlowViewProps): ReactElement => {
  useT();
  const [inFlightByRequestId, setInFlightByRequestId] = useState<Record<string, boolean>>({});
  const [errorByRequestId, setErrorByRequestId] = useState<Record<string, string | undefined>>(
    {}
  );

  const setPending = (requestId: string, pending: boolean): void => {
    startTransition(() => {
      setInFlightByRequestId((current) => ({
        ...current,
        [requestId]: pending
      }));
    });
  };

  const setError = (requestId: string, message?: string): void => {
    startTransition(() => {
      setErrorByRequestId((current) => ({
        ...current,
        [requestId]: message
      }));
    });
  };

  const onAction = async (
    approval: ApprovalRequest,
    action: ApprovalAction,
    decision?: string | Record<string, unknown>
  ): Promise<void> => {
    if (!onRespond || !canRespond(approval)) {
      return;
    }
    setPending(approval.requestId, true);
    setError(approval.requestId, undefined);

    try {
      await onRespond({
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        action,
        decision
      });
    } catch (error) {
      setError(approval.requestId, (error as Error).message);
    } finally {
      setPending(approval.requestId, false);
    }
  };

  if (approvals.length === 0) {
    return <p className="awb-detail__empty">{t("session.noApprovals")}</p>;
  }

  return (
    <div className="awb-approval-list">
      {approvals.map((approval) => {
        const inFlight = inFlightByRequestId[approval.requestId] ?? false;
        const requestError = errorByRequestId[approval.requestId];
        const disabled = !onRespond || !canRespond(approval) || inFlight;
        const decisionLabels = decisionLabelsFor(approval);
        const kindLabel = t(kindKeys[approval.approvalKind]);
        const identity = resolveParticipantIdentity(
          participantDirectory,
          approval.actor,
          kindLabel
        );

        return (
          <article key={approval.requestId} className="awb-timeline-item awb-approval-item">
            <header className="awb-timeline-item__header">
              <div className="awb-timeline-item__meta">
                <strong>{approvalTitle(approval)}</strong>
                <ParticipantIdentityBadge identity={identity} compact />
              </div>
              <span className={`awb-badge is-${approval.status}`}>{t(statusKeys[approval.status])}</span>
            </header>
            <p className="awb-approval-item__kind">{kindLabel}</p>
            {approval.details && <p className="awb-approval-item__details">{approval.details}</p>}
            <div className="awb-approval-item__actions">
              {decisionLabels.length > 0 ? (
                decisionLabels.map((decision) => (
                  <Button
                    key={decision}
                    variant={variantForDecisionLabel(decision)}
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      void onAction(
                        approval,
                        actionForDecisionLabel(decision),
                        decisionFromLabel(approval, decision)
                      )
                    }
                  >
                    {chineseLabels ? ({ accept: "批准", acceptForSession: "本会话始终批准", acceptWithExecpolicyAmendment: "批准并记住规则", applyNetworkPolicyAmendment: "应用网络规则", decline: "拒绝", cancel: "取消执行" }[decision] ?? decisionButtonLabel(decision)) : decisionButtonLabel(decision)}
                  </Button>
                ))
              ) : (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void onAction(approval, "approve", "accept")}
                  >
                    {t("session.approve")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void onAction(approval, "deny", "decline")}
                  >
                    {t("session.decline")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void onAction(approval, "defer")}
                  >
                    {t("session.later")}
                  </Button>
                </>
              )}
            </div>
            {requestError && <p className="awb-approval-item__error">{requestError}</p>}
          </article>
        );
      })}
    </div>
  );
};
