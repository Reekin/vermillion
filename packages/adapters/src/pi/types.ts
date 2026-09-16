/**
 * Pi speaks JSONL over stdin/stdout instead of request/response JSON-RPC, so the runtime port
 * normalizes both directions onto Vermillion's command and event vocabulary.
 */
export const piRuntimeRequestMethods = [
  "initialize",
  "createSession",
  "resumeSession",
  "archiveSession",
  "disposeSession",
  "listSessions",
  "sendUserMessage",
  "steerTurn",
  "interruptTurn",
  "forkSession",
  "setThreadGoal",
  "clearThreadGoal",
  "respondApproval",
  "respondInteraction",
  "listModels",
  "listSkills",
  "readSession"
] as const;

export type PiRuntimeRequestMethod = (typeof piRuntimeRequestMethods)[number];

export const piRuntimeEventMethods = [
  "session.created",
  "session.updated",
  "session.context.updated",
  "session.archived",
  "session.disposed",
  "turn.started",
  "turn.completed",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "terminal.started",
  "terminal.output",
  "terminal.completed",
  "conversationGraph.updated",
  "runtime.error"
] as const;

export type PiRuntimeEventMethod = (typeof piRuntimeEventMethods)[number];

export type PiRuntimeRequest = {
  id: string;
  method: PiRuntimeRequestMethod;
  params: Record<string, unknown>;
};

export type PiRuntimeResponse = {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type PiRuntimeEvent = {
  method: PiRuntimeEventMethod;
  params: Record<string, unknown>;
  eventId?: string;
  occurredAt?: string;
};
