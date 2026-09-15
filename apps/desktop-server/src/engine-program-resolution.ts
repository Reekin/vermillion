import type { EngineProgramResolutionRpc } from "@vermillion/shared";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

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
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolve = (path: string): {
    found: boolean;
    resolvedPath?: string;
  } => {
    const found = findExecutable(path, env, platform);
    return found ? { found: true, resolvedPath: found } : { found: false };
  };
  const customPath = options.customPath?.trim();
  if (customPath) {
    return {
      path: customPath,
      source: "custom",
      args: options.configuredArgs ?? program?.explicitArgs ?? [],
      ...resolve(customPath)
    };
  }
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath) {
    return {
      path: configuredPath,
      source: "configured",
      args: options.configuredArgs ?? program?.defaultArgs ?? [],
      ...resolve(configuredPath)
    };
  }
  const environmentVariable = program?.environmentVariables.find(
    (name) => env[name]?.trim()
  );
  if (environmentVariable) {
    const path = env[environmentVariable]!.trim();
    return {
      path,
      source: "environment",
      environmentVariable,
      args: options.configuredArgs ?? program?.explicitArgs ?? [],
      ...resolve(path)
    };
  }
  const defaultPath =
    platform === "win32"
      ? program?.windowsDefault ?? engineId
      : program?.default ?? engineId;
  return {
    path: defaultPath,
    source: "default",
    args: options.configuredArgs ?? program?.defaultArgs ?? [],
    ...resolve(defaultPath)
  };
};

/** 命令名在 PATH 上查找，带路径的值直接判断存在性。 */
const findExecutable = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined => {
  if (isAbsolute(command) || command.includes(sep) || command.includes("/")) {
    return existsSync(command) ? command : undefined;
  }
  const extensions =
    platform === "win32"
      ? (env.PATHEXT?.trim() || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const names = platform === "win32"
    ? [command, ...extensions.map((extension) => command + extension)]
    : [command];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory.trim()) {
      continue;
    }
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
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
