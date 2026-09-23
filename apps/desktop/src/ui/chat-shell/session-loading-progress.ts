import type { SessionReadProgress } from "@vermillion/shared";

export type SessionLoadingStage = "opening" | "history" | "preparing";
export type SessionLoadingTimeline = Partial<Record<SessionLoadingStage, { start: number; end?: number }>>;
export const loadingStages: Array<{ id: SessionLoadingStage; label: string }> = [
  { id: "opening", label: "打开会话" }, { id: "history", label: "加载历史" }, { id: "preparing", label: "显示消息" }
];

export const advanceLoadingTimeline = (timeline: SessionLoadingTimeline, stage: SessionLoadingStage, now: number): SessionLoadingTimeline => {
  const result = { ...timeline };
  for (const { id } of loadingStages) {
    const value = result[id];
    if (value && value.end === undefined && id !== stage) result[id] = { ...value, end: now };
  }
  result[stage] ??= { start: now };
  return result;
};

export const loadingDetail = (stage: SessionLoadingStage, progress?: SessionReadProgress): string => {
  if (stage === "preparing") return "正在排版消息";
  const labels: Record<SessionReadProgress["stage"], string> = {
    checking: "正在核对历史", rebuilding: "正在更新历史记录", "waiting-engine": "等待引擎返回历史",
    reading: "正在读取历史记录", converting: "正在转换消息", committing: "正在保存读取结果", building: "正在汇集当前对话"
  };
  const label = progress ? labels[progress.stage] : stage === "opening" ? "正在连接会话" : "正在确定阅读路径";
  return progress?.total && progress.total > 1 ? `${label} · 已就绪 ${progress.completed ?? 0} / ${progress.total} 个会话` : label;
};
