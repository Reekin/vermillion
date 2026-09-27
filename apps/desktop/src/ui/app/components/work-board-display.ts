import type { DecisionCard, WorkflowAction, WorkItem, WorkRequest } from "@vermillion/workbench/client";
import { t } from "../../../i18n/index.js";
import { isOpenWorkItem, isOpenWorkRequest } from "./task-labels.js";
import { workItemAttention, workRequestAttention, type Attention } from "./workflow-display.js";
export { isOpenWorkItem, isOpenWorkRequest, isPreparingWork } from "./task-labels.js";

/** Board groups, in display order: what needs the user, what is moving on its own, what has ended. */
export type BoardSection = "attention" | "active" | "ended";
export const boardSections: BoardSection[] = ["attention", "active", "ended"];
export const boardSectionLabel = (section: BoardSection): string => t(`work.board.section.${section}`);

/** `open` is the default view: every unfinished group plus the most recent ended entries. */
export type BoardFilter = "attention" | "active" | "open" | "ended" | "all";
export const ENDED_PREVIEW = 5;

export type BoardInput = { requests: WorkRequest[]; items: WorkItem[]; decisions: DecisionCard[]; actions: WorkflowAction[] };

type EntryBase = {
  id: string;
  section: BoardSection;
  updatedAt: string;
  treeId?: string;
  /** First thing the user must resolve, and the work item it belongs to when it is not the work itself. */
  attention?: Attention & { itemId?: string };
};
export type BoardEntry = EntryBase & (
  | { kind: "work"; request: WorkRequest; items: WorkItem[] }
  | { kind: "item"; item: WorkItem }
);

const byRecent = (a: { id: string; updatedAt: string }, b: { id: string; updatedAt: string }) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id);
const latest = (dates: string[]) => dates.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b);
const sectionOf = (open: boolean, attention: unknown): BoardSection => !open ? "ended" : attention ? "attention" : "active";

/** Pure presentation: each work and each standalone item appears once, grouped by whether the user must act. */
export const workBoard = ({ requests, items, decisions, actions }: BoardInput): BoardEntry[] => {
  const byRequest = new Map<string, WorkItem[]>();
  for (const item of items) if (item.requestId) byRequest.set(item.requestId, [...(byRequest.get(item.requestId) ?? []), item]);
  const requestIds = new Set(requests.map((request) => request.requestId));
  const entries: BoardEntry[] = requests.map((request) => {
    const children = (byRequest.get(request.requestId) ?? []).map((item) => ({ item, id: item.workItemId, updatedAt: item.updatedAt }))
      .sort(byRecent).map(({ item }) => item);
    const own = workRequestAttention(request, children, decisions);
    const child = own ? undefined : children.map((item) => ({ item, attention: workItemAttention(item, actions, decisions) })).find((entry) => entry.attention);
    const attention = own ?? (child && { ...child.attention!, itemId: child.item.workItemId });
    return {
      kind: "work", id: request.requestId, request, items: children, attention,
      treeId: request.treeId ?? children.find((item) => item.treeId)?.treeId,
      section: sectionOf(isOpenWorkRequest(request, children), attention),
      updatedAt: latest([request.updatedAt, ...children.map((item) => item.updatedAt)])
    };
  });
  for (const item of items) {
    if (item.requestId && requestIds.has(item.requestId)) continue;
    const attention = workItemAttention(item, actions, decisions);
    entries.push({ kind: "item", id: item.workItemId, item, attention, treeId: item.treeId, section: sectionOf(isOpenWorkItem(item), attention), updatedAt: item.updatedAt });
  }
  return entries.sort((a, b) => boardSections.indexOf(a.section) - boardSections.indexOf(b.section) || byRecent(a, b));
};

/** Page header summary: one count per group, a work counted once however many items it has. */
export const workBoardCounts = (entries: BoardEntry[]): Record<BoardSection, number> => ({
  attention: entries.filter((entry) => entry.section === "attention").length,
  active: entries.filter((entry) => entry.section === "active").length,
  ended: entries.filter((entry) => entry.section === "ended").length
});

export const workBoardAttentionCount = (input: BoardInput) => workBoardCounts(workBoard(input)).attention;

export const entryContains = (entry: BoardEntry, workItemId: string) =>
  entry.kind === "item" ? entry.id === workItemId : entry.items.some((item) => item.workItemId === workItemId);

export type VisibleGroup = { section: BoardSection; entries: BoardEntry[]; total: number };

/** Groups shown for a filter and title query; the default view trims the ended group to the latest few. */
export const visibleBoard = (entries: BoardEntry[], filter: BoardFilter, matches: (entry: BoardEntry) => boolean = () => true): VisibleGroup[] => {
  const shown: Record<BoardFilter, BoardSection[]> = { attention: ["attention"], active: ["active"], open: boardSections, ended: ["ended"], all: boardSections };
  return shown[filter].map((section) => {
    const members = entries.filter((entry) => entry.section === section && matches(entry));
    return { section, total: members.length, entries: filter === "open" && section === "ended" ? members.slice(0, ENDED_PREVIEW) : members };
  }).filter((group) => group.total > 0);
};

/** Keeps the current filter when it already shows the item, otherwise the narrowest view that does. */
export const filterShowing = (entries: BoardEntry[], workItemId: string, current: BoardFilter): BoardFilter => {
  const entry = entries.find((candidate) => entryContains(candidate, workItemId));
  if (!entry) return current;
  if (visibleBoard(entries, current).some((group) => group.entries.includes(entry))) return current;
  return entry.section === "ended" ? "ended" : "open";
};

/** Stored expansion key for an ended work's item list; ended works start collapsed. */
export const workExpansionKey = (requestId: string) => "ended-work/" + requestId;
