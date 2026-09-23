import { useEffect, useState } from "react";
import type { SessionReadProgress } from "@vermillion/shared";
import { loadingDetail, loadingStages, type SessionLoadingStage, type SessionLoadingTimeline } from "./session-loading-progress.js";
import "./session-loading-state.css";

export const SessionLoadingState = ({ stage = "opening", timeline = {}, progress, failed = false, onRetry }: {
  stage?: SessionLoadingStage; timeline?: SessionLoadingTimeline; progress?: SessionReadProgress;
  failed?: boolean; onRetry?: () => void;
}) => {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (failed) return;
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [failed]);
  return (
    <div className={`awb-session-loading${failed ? " is-failed" : ""}`}>
      <div className="awb-session-loading__art" aria-hidden="true">
        <div className="awb-session-loading__halo" />
        <div className="awb-session-loading__card is-back" />
        <div className="awb-session-loading__card is-middle" />
        <div className="awb-session-loading__card is-front">
          <span className="awb-session-loading__line" /><span className="awb-session-loading__line" />
          <span className="awb-session-loading__dots"><i /><i /><i /></span>
        </div>
      </div>
      <div className="awb-session-loading__copy" role="status" aria-live="polite" aria-atomic="true">
        <h3>{failed ? "暂时无法打开会话" : "正在加载会话"}</h3>
        <p title={failed ? undefined : loadingDetail(stage, progress)}>{failed ? "请重试，或先查看其他会话。" : loadingDetail(stage, progress)}</p>
      </div>
      <ol className="awb-session-loading__phases" aria-label="加载阶段与耗时">
        {loadingStages.map(({ id, label }) => {
          const timing = timeline[id];
          const done = timing?.end !== undefined;
          const active = !failed && id === stage && !done;
          const seconds = timing ? Math.max(0, ((timing.end ?? now) - timing.start) / 1000).toFixed(1) : undefined;
          return <li key={id} className={active ? "is-current" : done ? "is-done" : ""} aria-current={active ? "step" : undefined}>
            <span className="awb-session-loading__phase-label"><i aria-hidden="true">{done ? "✓" : ""}</i>{label}</span>
            <span className="awb-session-loading__time" aria-live="off">{seconds ? <>{seconds}<small>秒</small></> : "待开始"}</span>
          </li>;
        })}
      </ol>
      {failed && <button className="awb-transcript__load-earlier-button" type="button" onClick={onRetry}>重新加载</button>}
    </div>
  );
};
