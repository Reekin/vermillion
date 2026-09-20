import type { ReactElement } from "react";
import type {
  ComposerStatusModel,
  ComposerStatusNotice
} from "../composer-status.js";

export const ComposerStatusBar = ({
  status,
  notice
}: {
  status: ComposerStatusModel;
  notice?: ComposerStatusNotice;
}): ReactElement | null => {
  const showStatus = status.kind !== "idle" && status.kind !== "no_session";
  if (!showStatus && !notice?.message) return null;
  return (
    <div className="awb-composer-status">
      {showStatus ? (
        <span className={`awb-composer-status__pill is-${status.kind}`}>
          {status.label}
        </span>
      ) : null}
      {notice?.message ? (
        <span
          className={`awb-composer-status__notice is-${notice.severity ?? "info"}`}
          title={notice.message}
        >
          {notice.message}
        </span>
      ) : null}
    </div>
  );
};
