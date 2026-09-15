import type { EngineProgramRule } from "../../engine-program-resolution.js";

export const codexProgram: EngineProgramRule = {
  environmentVariables: ["VERMILLION_CODEX_BIN", "CODEX_BIN", "CODEX_PATH"],
  windowsDefault: "codex.exe",
  default: "codex",
  defaultArgs: ["app-server"],
  explicitArgs: ["app-server"]
};
