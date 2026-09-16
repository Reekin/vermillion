import { CodexAdapter, type CodexAdapterOptions } from "./codex/adapter.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "./codex/types.js";
import { PiAdapter, type PiAdapterOptions } from "./pi/adapter.js";
import type {
  PiRuntimeEvent,
  PiRuntimeRequest,
  PiRuntimeResponse
} from "./pi/types.js";
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

export const createPiAdapter = (
  runtimePort: AdapterRuntimePort<
    PiRuntimeRequest,
    PiRuntimeResponse,
    PiRuntimeEvent
  >,
  options: Omit<PiAdapterOptions, "runtimePort"> = {}
) =>
  new PiAdapter({
    ...options,
    runtimePort
  });
