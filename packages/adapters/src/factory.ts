import { CodexAdapter, type CodexAdapterOptions } from "./codex/adapter.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "./codex/types.js";
import type { AdapterRuntimePort } from "./runtime-port.js";

export const createCodexAdapter = (
  runtimePort: AdapterRuntimePort<
    CodexRuntimeRequest,
    CodexRuntimeResponse,
    CodexRuntimeEvent
  >,
  options: Omit<CodexAdapterOptions, "runtimePort"> = {}
) =>
  new CodexAdapter({
    ...options,
    runtimePort
  });
