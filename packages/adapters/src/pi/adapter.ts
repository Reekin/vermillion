import type { AdapterRuntimePort } from "../runtime-port.js";
import { RuntimeBackedAdapter } from "../runtime-backed-adapter.js";
import type { AgentAdapterRuntimeConfig } from "../types.js";
import { PiMapper } from "./mapper.js";
import type {
  PiRuntimeEvent,
  PiRuntimeRequest,
  PiRuntimeResponse
} from "./types.js";

export type PiAdapterOptions = {
  id?: string;
  fallbackAgentId?: string;
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  runtimePort: AdapterRuntimePort<
    PiRuntimeRequest,
    PiRuntimeResponse,
    PiRuntimeEvent
  >;
};

export class PiAdapter extends RuntimeBackedAdapter<
  PiRuntimeRequest,
  PiRuntimeResponse,
  PiRuntimeEvent
> {
  public constructor(options: PiAdapterOptions) {
    super({
      id: options.id ?? "pi",
      kind: "pi",
      runtimePort: options.runtimePort,
      resolveConversationIdBySessionId: options.resolveConversationIdBySessionId,
      mapper: new PiMapper({
        fallbackAgentId: options.fallbackAgentId ?? "pi"
      })
    });
  }

  public override async initialize(
    config: AgentAdapterRuntimeConfig = {}
  ): Promise<void> {
    await super.initialize({
      ...config,
      metadata: {
        ...(config.metadata ?? {}),
        adapterKind: "pi"
      }
    });
  }
}
