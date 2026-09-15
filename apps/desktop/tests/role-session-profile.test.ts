import { expect, it, vi } from "vitest";
import { mergeSessionExecutionProfile, resolveEngineExecutionPreference } from "@vermillion/shared";
import { createAgentRunner } from "../src/electron/agent-runner.js";

const preferences = {
  modeId: "code", selectedModelId: "composer-model",
  modelPreferences: { "composer-model": { reasoningOptionId: "high", serviceTierId: "priority" } }
};

it.each([
  [{ modelId: "role-model" }, { modelId: "role-model", reasoningOptionId: "high", serviceTierId: "priority" }],
  [{ reasoningOptionId: "low", serviceTierId: null }, { modelId: "composer-model", reasoningOptionId: "low", serviceTierId: null }],
  [{ modelId: "role-model", reasoningOptionId: "medium", serviceTierId: "ultrafast" }, { modelId: "role-model", reasoningOptionId: "medium", serviceTierId: "ultrafast" }],
  [undefined, { modelId: "composer-model", reasoningOptionId: "high", serviceTierId: "priority" }]
])("creates the role session with the merged profile %j", async (modelConfig, expected) => {
  const createBrowserSession = vi.fn().mockResolvedValue({ sessionId: "role-session" });
  const shell = {
    getSettings: async () => ({ executionPreferencesByEngineId: { codex: preferences } }),
    listEngines: () => [{ engineId: "codex", displayName: "Codex" }],
    createBrowserSession,
    setSessionTitle: vi.fn()
  };
  const runner = createAgentRunner(shell as never);
  await runner.open({ workspaceId: "workspace", cwd: "I:/repo", title: "Role", metadata: { role: "worker" }, modelConfig });
  expect(createBrowserSession).toHaveBeenCalledWith({
    workspaceId: "workspace", engineId: "codex", sessionProfile: { modeId: "code", ...expected },
    metadata: { role: "worker", cwd: "I:/repo" }
  });
  expect(preferences.modelPreferences["composer-model"].reasoningOptionId).toBe("high");
});

it("distinguishes explicit defaults from inherited fields", () => {
  const base = resolveEngineExecutionPreference(preferences);
  expect(mergeSessionExecutionProfile(base, { reasoningOptionId: null, serviceTierId: null })).toEqual({
    modeId: "code", modelId: "composer-model", reasoningOptionId: undefined, serviceTierId: null
  });
  expect(mergeSessionExecutionProfile(base, { reasoningOptionId: undefined, serviceTierId: undefined })).toEqual(base);
});
