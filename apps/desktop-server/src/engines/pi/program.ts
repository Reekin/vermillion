import type { EngineProgramRule } from "../../engine-program-resolution.js";

export const piProgram: EngineProgramRule = {
  environmentVariables: ["VERMILLION_PI_BIN", "PI_BIN", "PI_PATH"],
  windowsDefault: "pi",
  default: "pi",
  defaultArgs: [],
  explicitArgs: []
};
