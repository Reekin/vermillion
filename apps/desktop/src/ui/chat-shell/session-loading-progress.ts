import type { SessionReadProgress } from "@vermillion/shared";
import { t } from "../../i18n/index.js";

export type SessionLoadingStage = "opening" | "history" | "preparing";
export type SessionLoadingTimeline = Partial<Record<SessionLoadingStage, { start: number; end?: number }>>;
export const loadingStages: SessionLoadingStage[] = ["opening", "history", "preparing"];

export const loadingStageLabel = (stage: SessionLoadingStage): string => ({
  opening: t("session.loadingStageOpening"), history: t("session.loadingStageHistory"), preparing: t("session.loadingStagePreparing")
})[stage];

export const advanceLoadingTimeline = (timeline: SessionLoadingTimeline, stage: SessionLoadingStage, now: number): SessionLoadingTimeline => {
  const result = { ...timeline };
  for (const id of loadingStages) {
    const value = result[id];
    if (value && value.end === undefined && id !== stage) result[id] = { ...value, end: now };
  }
  result[stage] ??= { start: now };
  return result;
};

export const loadingDetail = (stage: SessionLoadingStage, progress?: SessionReadProgress): string => {
  if (stage === "preparing") return t("session.loadingLayout");
  const labels: Record<SessionReadProgress["stage"], string> = {
    checking: t("session.loadingChecking"), rebuilding: t("session.loadingRebuilding"), "waiting-engine": t("session.loadingWaitingEngine"),
    reading: t("session.loadingReading"), converting: t("session.loadingConverting"), committing: t("session.loadingCommitting"),
    building: t("session.loadingBuilding")
  };
  const label = progress ? labels[progress.stage] : stage === "opening" ? t("session.loadingConnecting") : t("session.loadingResolvingPath");
  return progress?.total && progress.total > 1
    ? t("session.loadingSessionsReady", { label, completed: progress.completed ?? 0, total: progress.total })
    : label;
};
