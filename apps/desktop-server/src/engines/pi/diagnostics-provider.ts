import type {
  DiagnosticsCapability,
  DiagnosticsSnapshot,
  SessionCapabilityContext
} from "../../capability-registry.js";
import type { PiRuntimePort } from "./runtime-port.js";

export class PiDiagnosticsProvider implements DiagnosticsCapability {
  private readonly runtimePort: PiRuntimePort;
  private readonly now: () => string;

  public constructor(options: { runtimePort: PiRuntimePort; now?: () => string }) {
    this.runtimePort = options.runtimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(input: SessionCapabilityContext): Promise<DiagnosticsSnapshot> {
    const auth = await this.runtimePort.readAuthStatus();
    return {
      sessionId: input.sessionId,
      engineId: input.engineId ?? this.runtimePort.engineId,
      supported: true,
      authenticated: auth.authenticated,
      authMethod: auth.authMethod ?? null,
      summaryText: [
        this.runtimePort.isSessionRunning(input.sessionId)
          ? "pi process: running"
          : "pi process: idle",
        auth.summaryText
      ]
        .filter(Boolean)
        .join("\n"),
      fetchedAt: this.now()
    };
  }
}
