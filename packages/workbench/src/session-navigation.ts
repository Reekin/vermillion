import type { SessionNavigation } from "./contracts.js";

/** The desktop resolves real sessions and persists their message navigation records. */
export type SessionNavigationPort = {
  create: (input: { sessionId: string; targetSessionId: string; reason?: string }) => Promise<{ navigation: SessionNavigation; workspaceId: string }>;
  list: (input: { sessionId: string; turnId: string }) => Promise<SessionNavigation[]>;
};
