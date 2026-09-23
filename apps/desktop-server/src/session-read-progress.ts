import type { SessionReadProgress } from "@vermillion/shared";

export type ReadStageEvent = { stage: string; phase: string; spanId: string; fields: Record<string, unknown> };
type Stage = SessionReadProgress["stage"];
const priority: Record<Stage, number> = { checking: 0, reading: 1, rebuilding: 2, "waiting-engine": 3, converting: 4, committing: 5, building: 6 };

/** Ephemeral state owned by one read; no domain events, history cursors or log parsing. */
export class SessionReadProgressTracker {
  private readonly active = new Map<string, Stage>();
  private last = "";
  public value: SessionReadProgress;
  public constructor(readId: string, sessionId: string, private readonly publish: (value: SessionReadProgress) => void) {
    this.value = { readId, sessionId, stage: "checking" };
  }
  public counts = (completed: number, total: number): void => {
    this.value = { ...this.value, completed, total };
    this.emit();
  };
  public stage = ({ stage, phase, spanId, fields }: ReadStageEvent): void => {
    if (phase === "end") this.active.delete(spanId);
    else if (phase === "begin") {
      const mapped: Stage | undefined = stage === "history.rebuild-source" ? "rebuilding"
        : stage === "history.convert" ? "converting" : stage === "history.commit" ? "committing"
        : stage === "tree.project" ? "building" : stage === "history.source-check" ? "checking"
        : stage === "history.provider-read" || stage === "history.shared-wait" ? "reading"
        : stage === "engine.rpc" && (fields.method === "thread/resume" || fields.method === "thread/read" || fields.method === "thread/turns/list") ? "waiting-engine" : undefined;
      if (mapped) this.active.set(spanId, mapped);
    }
    this.emit();
  };
  private emit(): void {
    const stage = [...this.active.values()].sort((a, b) => priority[b] - priority[a])[0] ?? "checking";
    this.value = { ...this.value, stage };
    const key = `${stage}:${this.value.completed}:${this.value.total}`;
    if (key === this.last) return;
    this.last = key;
    this.publish(this.value);
  }
}
