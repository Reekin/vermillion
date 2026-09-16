import type { CommandEnvelope, RuntimeEvent } from "@vermillion/shared";
import type { AdapterMapper, AdapterMapperContext } from "../mapper.js";
import {
  createEventEnvelope,
  defaultCommandResultFromResponse,
  normalizeRuntimeEvent
} from "../mapper-helpers.js";
import type {
  PiRuntimeEvent,
  PiRuntimeRequest,
  PiRuntimeResponse
} from "./types.js";

const piMethodByCommandType: Record<
  CommandEnvelope["command"]["type"],
  PiRuntimeRequest["method"]
> = {
  initialize: "initialize",
  createSession: "createSession",
  listSessions: "listSessions",
  resumeSession: "resumeSession",
  archiveSession: "archiveSession",
  forkSession: "forkSession",
  sendUserMessage: "sendUserMessage",
  steerTurn: "steerTurn",
  interruptTurn: "interruptTurn",
  setThreadGoal: "setThreadGoal",
  clearThreadGoal: "clearThreadGoal",
  respondApproval: "respondApproval",
  respondInteraction: "respondInteraction",
  disposeSession: "disposeSession"
};

const piEventTypeByMethod: Record<string, RuntimeEvent["type"]> = {
  "session.created": "session.created",
  "session.updated": "session.updated",
  "session.context.updated": "session.context.updated",
  "session.archived": "session.archived",
  "session.disposed": "session.disposed",
  "turn.started": "turn.started",
  "turn.completed": "turn.completed",
  "message.started": "message.started",
  "message.delta": "message.delta",
  "message.completed": "message.completed",
  "tool.started": "tool.started",
  "tool.delta": "tool.delta",
  "tool.completed": "tool.completed",
  "terminal.started": "terminal.started",
  "terminal.output": "terminal.output",
  "terminal.completed": "terminal.completed",
  "conversationGraph.updated": "conversationGraph.updated",
  "runtime.error": "runtime.error"
};

export type PiMapperOptions = {
  fallbackAgentId: string;
};

export class PiMapper
  implements AdapterMapper<PiRuntimeRequest, PiRuntimeResponse, PiRuntimeEvent>
{
  private readonly fallbackAgentId: string;

  public constructor(options: PiMapperOptions) {
    this.fallbackAgentId = options.fallbackAgentId;
  }

  public mapCommand(
    envelope: CommandEnvelope,
    _context: AdapterMapperContext
  ): PiRuntimeRequest {
    return {
      id: envelope.commandId,
      method: piMethodByCommandType[envelope.command.type],
      params: {
        ...envelope.command
      }
    };
  }

  public mapCommandResult(response: PiRuntimeResponse, envelope: CommandEnvelope) {
    if (response.error || !response.ok) {
      return defaultCommandResultFromResponse(envelope, response, {
        accepted: false,
        error: {
          code: response.error?.code ?? "pi_runtime_error",
          message: response.error?.message ?? "The pi runtime rejected the command.",
          details: response.error?.details
        }
      });
    }

    const result = response.result;
    const turnId = typeof result?.turnId === "string" ? result.turnId : undefined;
    const sessionId =
      typeof result?.sessionId === "string"
        ? result.sessionId
        : "sessionId" in envelope.command
          ? envelope.command.sessionId
          : undefined;

    return defaultCommandResultFromResponse(envelope, response, {
      accepted: true,
      outcome:
        envelope.command.type === "sendUserMessage" && turnId && sessionId
          ? {
              type: "turn_started",
              sessionId,
              turnId,
              ...(typeof result?.providerSessionId === "string"
                ? { providerSessionId: result.providerSessionId }
                : {})
            }
          : envelope.command.type === "steerTurn" && turnId && sessionId &&
              (result?.delivery === "steered" || result?.delivery === "start_or_steer")
            ? { type: "turn_delivered", sessionId, turnId, delivery: result.delivery }
            : { type: "command_accepted" }
    });
  }

  public mapRuntimeEvent(event: PiRuntimeEvent, context: AdapterMapperContext) {
    const eventType = piEventTypeByMethod[event.method];
    if (!eventType) {
      return [];
    }

    return [
      createEventEnvelope(
        normalizeRuntimeEvent(eventType, event.params, this.fallbackAgentId),
        context,
        {
          eventId: event.eventId,
          occurredAt: event.occurredAt
        }
      )
    ];
  }
}
