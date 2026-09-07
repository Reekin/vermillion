import type { Mission, WorkItem } from "@vermillion/workbench/client";

export const missionStatusLabel: Record<Mission["status"], string> = { active: "进行中", done: "已完成", cancelled: "已取消" };
export const statusLabel: Record<WorkItem["status"], string> = { queued: "排队中", running: "进行中", decision: "待决策", closed: "已关闭", cancelled: "已取消" };
export const taskStatusLabel = { ...missionStatusLabel, ...statusLabel };
