import type { SessionLoadingStage } from "./use-chat-tree-controller.js";
import "./session-loading-state.css";

const stages: Array<{ id: SessionLoadingStage; label: string; detail: string }> = [
  { id: "opening", label: "正在打开会话", detail: "让这段对话回到眼前" },
  { id: "history", label: "正在读取历史", detail: "正在取回这条对话的消息" },
  { id: "preparing", label: "正在整理消息", detail: "内容已收到，正在准备显示" }
];

export const SessionLoadingState = ({ stage = "opening", failed = false, onRetry }: {
  stage?: SessionLoadingStage; failed?: boolean; onRetry?: () => void;
}) => {
  const current = stages.findIndex((item) => item.id === stage);
  return (
    <div className={`awb-session-loading${failed ? " is-failed" : ""}`} role="status" aria-live="polite" aria-atomic="true">
      <div className="awb-session-loading__art" aria-hidden="true">
        <div className="awb-session-loading__halo" />
        <div className="awb-session-loading__card is-back" />
        <div className="awb-session-loading__card is-middle" />
        <div className="awb-session-loading__card is-front">
          <span className="awb-session-loading__line" /><span className="awb-session-loading__line" />
          <span className="awb-session-loading__dots"><i /><i /><i /></span>
        </div>
      </div>
      <div className="awb-session-loading__copy" key={failed ? "failed" : stage}>
        <h3>{failed ? "暂时无法打开会话" : stages[current].label}</h3>
        <p>{failed ? "请重试，或先查看其他会话。" : stages[current].detail}</p>
      </div>
      {failed ? <button className="awb-transcript__load-earlier-button" type="button" onClick={onRetry}>重新加载</button> : (
        <div className="awb-session-loading__steps" aria-hidden="true">
          {stages.map((item, index) => <span key={item.id} className={index === current ? "is-current" : index < current ? "is-done" : ""}>
            <i />{["打开", "读取", "整理"][index]}
          </span>)}
        </div>
      )}
    </div>
  );
};
