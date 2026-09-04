import type {
  EngineDefinitionRpc,
  EngineIntegrationTierRpc
} from "@vermillion/shared";

export type EngineDefinition = EngineDefinitionRpc & {
  integrationTier: EngineIntegrationTierRpc;
};
