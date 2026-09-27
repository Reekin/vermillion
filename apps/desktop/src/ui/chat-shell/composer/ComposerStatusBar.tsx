import type { ReactElement } from "react";
import { useT } from "../../../i18n/react.js";
import type { ComposerStatusModel } from "../composer-status.js";

/** Session state only; notices are shown in the app shell's output. */
export const ComposerStatusBar = ({ status }: { status: ComposerStatusModel }): ReactElement => {
  const t = useT();
  return (
    <div className="awb-composer-status">
      <span className={`awb-composer-status__pill is-${status.kind}`} role="status">
        {status.kind === "no_session" || status.kind === "idle" ? t("session.statusReady")
          : status.kind === "running" ? t("session.statusRunning")
          : status.kind === "awaiting_approval" ? t("session.statusAwaitingApproval")
          : status.kind === "error" ? t("session.statusNeedsAttention") : status.label}
      </span>
    </div>
  );
};
