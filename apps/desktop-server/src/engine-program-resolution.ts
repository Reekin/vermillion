import type { EngineProgramResolutionRpc } from "@vermillion/shared";

export type EngineProgramCommand = EngineProgramResolutionRpc & {
  args: string[];
};

/** 引擎声明的默认启动方式；由各引擎装配单元提供。 */
export type EngineProgramRule = {
  environmentVariables: string[];
  windowsDefault: string;
  default: string;
  defaultArgs: string[];
  explicitArgs: string[];
};

type ResolveEngineProgramCommandOptions = {
  program?: EngineProgramRule;
  customPath?: string;
  configuredPath?: string;
  configuredArgs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export const resolveEngineProgramCommand = (
  engineId: string,
  options: ResolveEngineProgramCommandOptions = {}
): EngineProgramCommand => {
  const program = options.program;
  const customPath = options.customPath?.trim();
  if (customPath) {
    return {
      path: customPath,
      source: "custom",
      args: options.configuredArgs ?? program?.explicitArgs ?? []
    };
  }
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath) {
    return {
      path: configuredPath,
      source: "configured",
      args: options.configuredArgs ?? program?.defaultArgs ?? []
    };
  }
  const env = options.env ?? process.env;
  const environmentVariable = program?.environmentVariables.find(
    (name) => env[name]?.trim()
  );
  if (environmentVariable) {
    return {
      path: env[environmentVariable]!.trim(),
      source: "environment",
      environmentVariable,
      args: options.configuredArgs ?? program?.explicitArgs ?? []
    };
  }
  const platform = options.platform ?? process.platform;
  return {
    path:
      platform === "win32"
        ? program?.windowsDefault ?? engineId
        : program?.default ?? engineId,
    source: "default",
    args: options.configuredArgs ?? program?.defaultArgs ?? []
  };
};

export const resolveEngineSpawnCommand = (
  commandPath: string,
  commandArgs: string[],
  options: {
    platform?: NodeJS.Platform;
    comspec?: string;
  } = {}
) => {
  if (
    (options.platform ?? process.platform) !== "win32" ||
    !/\.(cmd|bat)$/iu.test(commandPath)
  ) {
    return {
      command: commandPath,
      args: commandArgs
    };
  }

  return {
    command: options.comspec?.trim() || process.env.ComSpec?.trim() || "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [commandPath, ...commandArgs].map(quoteForWindowsShell).join(" ")
    ]
  };
};

const quoteForWindowsShell = (value: string): string =>
  /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
