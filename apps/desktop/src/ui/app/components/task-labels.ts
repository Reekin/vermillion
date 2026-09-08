import type { WorkItem } from "@vermillion/workbench/client";

export const statusLabel: Record<WorkItem["status"], string> = { preparing: "准备中", queued: "排队中", running: "进行中", merging: "等待合入", decision: "等待用户", closed: "已关闭", cancelled: "已取消" };
