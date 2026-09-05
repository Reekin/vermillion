import type { SessionIndexStore } from "./session-index.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import {
  SessionIdentityRegistry,
  type ResolvedSessionContext
} from "./session-identity-registry.js";

export type { ResolvedSessionContext } from "./session-identity-registry.js";

export const findRuntimeSession = (
  runtimeService: SessionRuntimeService,
  sessionId: string
) =>
  runtimeService
    .listSessions({
      includeArchived: true
    })
    .find((session) => session.sessionId === sessionId);

export const resolveSessionContext = (
  runtimeService: SessionRuntimeService,
  sessionIndexStore: SessionIndexStore,
  sessionId: string
): ResolvedSessionContext =>
  new SessionIdentityRegistry({
    runtimeService,
    sessionIndexStore
  }).resolveContext(sessionId);
