import type { WorkItem, WorkRequest } from "@vermillion/workbench/client";

export const isOpenWorkItem = (item: WorkItem) => item.status !== "closed" && item.status !== "cancelled";
export const isPreparingWork = (request: WorkRequest) => request.status !== "cancelled" && (request.status !== "ready" || Boolean(request.activeTurnId));
export const isOpenWorkRequest = (request: WorkRequest, items: WorkItem[]) => isPreparingWork(request) || items.some(isOpenWorkItem);
export const workExpansionKey = (requestId: string) => "work/" + requestId;

type BoardOrder = { id: string; open: boolean; updatedAt: string };
export type BoardEntry = BoardOrder & { treeId: string } & (
  | { kind: "work"; request: WorkRequest; items: WorkItem[] }
  | { kind: "item"; item: WorkItem }
);
export type BoardGroup = BoardOrder & { entries: BoardEntry[] };

const compare = (a: BoardOrder, b: BoardOrder) => Number(b.open) - Number(a.open)
  || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id);
const itemOrder = (item: WorkItem): BoardOrder => ({ id: item.workItemId, open: isOpenWorkItem(item), updatedAt: item.updatedAt });
const latest = (dates: string[]) => dates.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b);

/** Pure presentation: grouping never writes execution state or changes input order. */
export const workBoardGroups = (requests: WorkRequest[], items: WorkItem[]): BoardGroup[] => {
  const byRequest = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (item.requestId) byRequest.set(item.requestId, [...(byRequest.get(item.requestId) ?? []), item]);
  }
  const requestIds = new Set(requests.map((request) => request.requestId));
  const entries: BoardEntry[] = requests.map((request) => {
    const children = [...(byRequest.get(request.requestId) ?? [])].sort((a, b) => compare(itemOrder(a), itemOrder(b)));
    return {
      kind: "work", id: request.requestId, request, items: children,
      treeId: request.treeId ?? children.find((item) => item.treeId)?.treeId ?? "standalone",
      open: isOpenWorkRequest(request, children),
      updatedAt: latest([request.updatedAt, ...children.map((item) => item.updatedAt)])
    };
  });
  for (const item of items) {
    if (!item.requestId || !requestIds.has(item.requestId)) entries.push({ kind: "item", item, treeId: item.treeId ?? "standalone", ...itemOrder(item) });
  }
  const groups = new Map<string, BoardEntry[]>();
  for (const entry of entries) groups.set(entry.treeId, [...(groups.get(entry.treeId) ?? []), entry]);
  return [...groups].map(([id, members]) => ({
    id, open: members.some((entry) => entry.open), updatedAt: latest(members.map((entry) => entry.updatedAt)), entries: members.sort(compare)
  })).sort(compare);
};

export const workBoardCounts = (requests: WorkRequest[], items: WorkItem[]) => {
  const preparation = requests.filter((request) => isPreparingWork(request) || (request.status === "cancelled" && !items.some((item) => item.requestId === request.requestId)));
  const states = [
    ...items.filter((item) => item.status !== "preparing").map((item) => !isOpenWorkItem(item) ? "ended" : item.run.activeTurnId && item.run.turnStatus !== "unknown" ? "active" : "waiting"),
    ...preparation.map((request) => request.status === "cancelled" ? "ended" : request.activeTurnId && request.turnStatus !== "unknown" ? "active" : "waiting")
  ];
  return { active: states.filter((s) => s === "active").length, waiting: states.filter((s) => s === "waiting").length, ended: states.filter((s) => s === "ended").length };
};
