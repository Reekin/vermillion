import type { WorkMessage } from "./contracts.js";

export type SessionDispatchMessage = WorkMessage & { sessionId: string; messageId: string; origin?: "scheduler" | "user" };
export type SessionDispatchReceipt = { accepted: boolean; queued?: { messageId: string; reason: string; workItemId?: string }; error?: { code: string; message: string }; turnId?: string; delivery?: "started" | "steered" };
export type MessageDeliveryPort = (message: SessionDispatchMessage) => Promise<SessionDispatchReceipt>;
export type ControlState = { control?: "auto" | "manual" | "paused"; retryAt?: string; failure?: string; activeTurnId?: string; pendingMessageId?: string; attemptId?: string; waitReason?: string; attempts?: number; idleTurns?: number };

export type ControlEvent =
  | { type: "pause"; reason: string }
  | { type: "resume"; attemptId: string; retry?: boolean }
  | { type: "hold"; reason: string }
  | { type: "failed"; failure: string; now: string }
  | { type: "settled"; turnId: string };

export const retryMinutes = [1, 5, 30, 300];

/** Control intent, recovery ownership and turn settlement share the same transition rules. */
export function transitionControl<T extends ControlState>(state: T, event: ControlEvent): T {
  switch (event.type) {
    case "pause": return { ...state, control: "paused", retryAt: undefined, waitReason: event.reason };
    case "resume": return { ...state, control: "auto", attemptId: event.attemptId, activeTurnId: undefined,
      retryAt: undefined, failure: undefined, waitReason: undefined, idleTurns: 0,
      ...(event.retry ? { attempts: 0 } : {}) };
    case "hold": return { ...state, control: state.control === "paused" ? "paused" : "manual", activeTurnId: undefined,
      retryAt: undefined, waitReason: state.control === "paused" ? state.waitReason : event.reason };
    case "settled": return state.activeTurnId !== event.turnId ? state : { ...state, activeTurnId: undefined };
    case "failed": {
      if (state.control === "paused") return state;
      const attempts = (state.attempts ?? 0) + 1;
      const permanent = /quota|credit|insufficient|认证|authentication|unauthorized|forbidden/i.test(event.failure);
      const delay = permanent || state.control === "manual" ? undefined : retryMinutes[attempts - 1];
      return { ...state, attempts, failure: event.failure, activeTurnId: undefined, pendingMessageId: undefined,
        control: delay === undefined ? "manual" : "auto",
        retryAt: delay === undefined ? undefined : new Date(Date.parse(event.now) + delay * 60_000).toISOString(),
        waitReason: permanent ? "工作受阻：额度、认证或配置需要处理" : delay === undefined ? "自动恢复次数已用尽" : undefined };
    }
  }
}

/** Shared transitions change control only for explicit control operations. */
export function beginExecution<T extends ControlState>(state: T, messageId: string, origin: "scheduler" | "user", active: boolean): T {
  if (active) return state;
  return { ...state, control: origin === "scheduler" ? state.control ?? "auto" : "manual",
    retryAt: undefined, failure: undefined, waitReason: undefined, pendingMessageId: messageId,
    attemptId: messageId, activeTurnId: undefined,
    ...(origin === "user" ? { attempts: 0, idleTurns: 0 } : {}) };
}

export function confirmExecution<T extends ControlState>(state: T, messageId: string, turnId?: string): T {
  if (state.pendingMessageId !== messageId) return state;
  return { ...state, pendingMessageId: undefined, activeTurnId: turnId ?? state.activeTurnId };
}
