import type {
  AgentAdapter,
  AgentAdapterRuntimeConfig
} from "@vermillion/adapters";
import type {
  ChatSession,
  Command,
  DomainSnapshot,
  EventEnvelope,
  EngineIntegrationTierRpc,
  EngineModelCatalogRpc,
  EngineSharedCapabilityRpc,
  EngineExtensionDescriptorRpc
} from "@vermillion/shared";
import type { RuntimeCommandReceiptRpc } from "@vermillion/shared";

export type WorkbenchEngineDescriptor = {
  engineId: string;
  displayName: string;
  capabilities: string[];
};

export type WorkbenchSessionListOptions = {
  conversationId?: string;
  includeArchived?: boolean;
};

export type EngineSelectionInput = {
  engineId: string;
  config?: Record<string, unknown>;
};

export type CommandReceipt = RuntimeCommandReceiptRpc;

export type SnapshotResult = {
  snapshot: DomainSnapshot;
  cursor?: string;
};

export type EventReplayGapReason = "cursor_not_found";

export type EventReplayResult = {
  status: "ok" | "gap";
  reason?: EventReplayGapReason;
  replayed: number;
  fromCursor?: string;
  toCursor?: string;
  envelopes: EventEnvelope[];
};

export type WorkbenchAgentBinding = {
  descriptor: WorkbenchEngineDescriptor;
  integrationTier?: EngineIntegrationTierRpc;
  transportKind?: string;
  adapter?: AgentAdapter;
  runtimeConfig?: AgentAdapterRuntimeConfig;
  providerKind?: string;
  resolveProviderSessionId?: (sessionId: string) => string | undefined;
  modelCatalog?: () => Promise<EngineModelCatalogRpc>;
  sharedCapabilities?: EngineSharedCapabilityRpc[];
  extensions?: EngineExtensionDescriptorRpc[];
};

export type SessionIndexSyncRecord = {
  workspaceId?: string;
  session: Pick<
    ChatSession,
    | "sessionId"
    | "conversationId"
    | "engineId"
    | "title"
    | "createdAt"
    | "updatedAt"
    | "archivedAt"
    | "lastTurnId"
    | "metadata"
  >;
  providerKind?: string;
  providerSessionId?: string;
  lastCompletedTurnAt?: string;
};
