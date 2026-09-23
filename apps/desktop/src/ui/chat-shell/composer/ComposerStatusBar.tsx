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
}): ReactElement => {
  return (
    <div className="awb-composer-status">
      <span className={`awb-composer-status__pill is-${status.kind}`} role="status">
        {status.kind === "no_session" || status.kind === "idle" ? "就绪"
          : status.kind === "running" ? "运行中"
          : status.kind === "awaiting_approval" ? "等待审批"
          : status.kind === "error" ? "需要处理" : status.label}
      </span>
      {notice?.message ? (
        <span
          className={`awb-composer-status__notice is-${notice.severity ?? "info"}`}
          title={notice.message}
          tabIndex={0}
          role="status"
        >
          {notice.message}
        </span>
      ) : null}
    </div>
  );
};
