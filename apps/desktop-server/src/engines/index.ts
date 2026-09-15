import type { EngineIntegrationFactory } from "../engine-control/engine-integration.js";
import { createCodexEngineIntegration } from "./codex/index.js";
import { createPiEngineIntegration } from "./pi/index.js";

/** 参与运行的全部引擎装配单元；新增引擎只在这里追加一条。 */
export const engineIntegrations: readonly EngineIntegrationFactory[] = [
  createCodexEngineIntegration,
  createPiEngineIntegration
];
