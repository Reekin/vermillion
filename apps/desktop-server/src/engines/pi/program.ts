import type { EngineProgramRule } from "../../engine-program-resolution.js";

export const piProgram: EngineProgramRule = {
  environmentVariables: ["VERMILLION_PI_BIN", "PI_BIN", "PI_PATH"],
  // npm 在 Windows 上同时生成无扩展名的 sh 入口和 pi.cmd，能直接启动的是后者。
  windowsDefault: "pi.cmd",
  default: "pi",
  defaultArgs: [],
  explicitArgs: []
};
