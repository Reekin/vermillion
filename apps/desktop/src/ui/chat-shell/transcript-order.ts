import type { Turn } from "@vermillion/shared";

/** Explicit engine/event order is independent of missing or rounded timestamps. */
export const compareTranscriptItems = (turn: Turn) => {
  const positions = new Map((turn.transcriptItemIds ?? []).map((id, index) => [id, index]));
  return (left: { id: string; startedAt?: string }, right: { id: string; startedAt?: string }): number => {
    const leftPosition = positions.get(left.id);
    const rightPosition = positions.get(right.id);
    if (leftPosition !== undefined || rightPosition !== undefined) {
      return (leftPosition ?? Number.POSITIVE_INFINITY) - (rightPosition ?? Number.POSITIVE_INFINITY);
    }
    return (left.startedAt ?? "\uffff").localeCompare(right.startedAt ?? "\uffff");
  };
};
