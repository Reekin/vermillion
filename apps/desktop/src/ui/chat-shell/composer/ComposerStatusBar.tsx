import type { ReactElement } from "react";
import type { ComposerStatusModel } from "../composer-status.js";

/** Session state only; notices are shown in the app shell's output. */
export const ComposerStatusBar = ({ status }: { status: ComposerStatusModel }): ReactElement => (
  <div className="awb-composer-status">
    <span className={`awb-composer-status__pill is-${status.kind}`} role="status">
      {status.kind === "no_session" || status.kind === "idle" ? "就绪"
        : status.kind === "running" ? "运行中"
        : status.kind === "awaiting_approval" ? "等待审批"
        : status.kind === "error" ? "需要处理" : status.label}
    </span>
  </div>
);
