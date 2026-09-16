import { copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixtureVersion = 2;

type FixtureMarker = {
  version?: number;
  projectPath?: string;
  codexHome?: string;
  piAgentDir?: string;
};

export type RealSessionFixture = {
  dataDir: string;
  projectPath: string;
  codexHome: string;
  piAgentDir: string;
  env: Record<string, string>;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
};

const assertGitProject = async (projectPath: string): Promise<void> => {
  if (!(await exists(join(projectPath, ".git")))) throw new Error("real-session fixture project has no Git repository");
  try {
    await git(projectPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error("real-session fixture project has no Git starting commit");
  }
};

const configuredModelCatalogPath = (value: string): string | undefined => {
  const match = value.match(/^\s*model_catalog_json\s*=\s*(['"])(.*?)\1\s*$/im);
  return match?.[2]?.replace(/\\\\/g, "\\");
};

const tomlPath = (path: string): string => path.replace(/\\/g, "/").replace(/'/g, "''");

const sanitizeConfig = (value: string, codexHome: string, modelCatalogPath?: string): string => value
  .replace(/^\s*(?:sqlite_home|sqliteHome)\s*=.*(?:\r?\n|$)/gim, "")
  .replace(/^\s*model_catalog_json\s*=.*(?:\r?\n|$)/im, modelCatalogPath ? `model_catalog_json = '${tomlPath(modelCatalogPath)}'\n` : "")
  .replace(/^(\s*CODEX_HOME\s*=).*(?:\r?\n|$)/gim, `$1 '${tomlPath(codexHome)}'\n`);

const copyInitialCodexState = async (source: string, target: string): Promise<void> => {
  const configPath = join(source, "config.toml");
  const modelCachePath = join(source, "models_cache.json");
  if (!(await exists(configPath))) throw new Error("real-session requires config.toml in codexConfigSource: " + source);
  if (!(await exists(modelCachePath))) throw new Error("real-session requires models_cache.json in codexConfigSource: " + source);
  const modelCache = await readJson<{ models?: unknown }>(modelCachePath);
  if (!Array.isArray(modelCache.models) || !modelCache.models.length) {
    throw new Error("real-session requires a non-empty model catalog in codexConfigSource: " + source);
  }

  const config = await readFile(configPath, "utf8");
  const configuredModelCatalog = configuredModelCatalogPath(config);
  const modelCatalogSource = configuredModelCatalog ? resolve(source, configuredModelCatalog) : undefined;
  if (modelCatalogSource && !(await exists(modelCatalogSource))) {
    throw new Error("real-session requires configured model_catalog_json file: " + modelCatalogSource);
  }
  await mkdir(target, { recursive: true });
  const modelCatalogTarget = modelCatalogSource ? join(target, "models-override.json") : undefined;
  await writeFile(join(target, "config.toml"), sanitizeConfig(config, target, modelCatalogTarget), "utf8");
  await copyFile(modelCachePath, join(target, "models_cache.json"));
  if (modelCatalogSource && modelCatalogTarget) await copyFile(modelCatalogSource, modelCatalogTarget);
  const authPath = join(source, "auth.json");
  if (await exists(authPath)) await copyFile(authPath, join(target, "auth.json"));
};

const createGitProject = async (projectPath: string): Promise<void> => {
  await mkdir(projectPath, { recursive: true });
  await git(projectPath, ["init", "-q"]);
  await git(projectPath, ["config", "user.name", "Vermillion Acceptance"]);
  await git(projectPath, ["config", "user.email", "vermillion-acceptance@local"]);
  await writeFile(join(projectPath, "README.md"), "Real acceptance fixture\n", "utf8");
  await git(projectPath, ["add", "--", "README.md"]);
  await git(projectPath, ["commit", "-q", "-m", "Initialize real acceptance fixture", "--", "README.md"]);
};

const result = (dataDir: string, projectPath: string, codexHome: string): RealSessionFixture => ({
  dataDir,
  projectPath,
  codexHome,
  piAgentDir: join(dataDir, "pi-agent"),
  env: {
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: join(dataDir, "codex-sqlite"),
    PI_CODING_AGENT_DIR: join(dataDir, "pi-agent")
  }
});

/**
 * pi 的模型、认证与扩展都要落在隔离目录里；扩展包一并复制，
 * 免得孤立实例启动时去联网安装 pi-subagents。
 */
const copyPiAgentState = async (source: string, target: string): Promise<void> => {
  await mkdir(target, { recursive: true });
  for (const file of ["models.json", "auth.json", "settings.json"]) {
    if (await exists(join(source, file))) {
      await copyFile(join(source, file), join(target, file));
    }
  }
  for (const directory of ["skills", "npm"]) {
    if (await exists(join(source, directory))) {
      await cp(join(source, directory), join(target, directory), {
        recursive: true,
        force: true
      });
    }
  }
  const modelsPath = join(target, "models.json");
  if (!(await exists(modelsPath))) {
    throw new Error("real-session requires models.json in the pi agent directory: " + source);
  }
  const models = await readJson<{ providers?: Record<string, { models?: unknown[] }> }>(modelsPath);
  const hasModel = Object.values(models.providers ?? {}).some(
    (provider) => Array.isArray(provider.models) && provider.models.length > 0
  );
  if (!hasModel) {
    throw new Error("real-session requires a non-empty pi model catalog: " + modelsPath);
  }
};

export const prepareRealSessionFixture = async (
  dataDirInput: string,
  codexConfigSourceInput?: string
): Promise<RealSessionFixture> => {
  const dataDir = resolve(dataDirInput);
  const projectPath = join(dataDir, "fixtures", "real-session", "project");
  const codexHome = join(dataDir, "codex");
  const markerPath = join(dataDir, "real-session-fixture.json");

  if (await exists(markerPath)) {
    const marker = await readJson<FixtureMarker>(markerPath);
    if (marker.version !== fixtureVersion || resolve(marker.projectPath ?? "") !== resolve(projectPath) ||
      resolve(marker.codexHome ?? "") !== resolve(codexHome) ||
      resolve(marker.piAgentDir ?? "") !== resolve(join(dataDir, "pi-agent"))) {
      throw new Error("real-session fixture metadata does not match this dataDir");
    }
    await assertGitProject(projectPath);
    const modelCachePath = join(codexHome, "models_cache.json");
    const modelCache = await exists(modelCachePath) ? await readJson<{ models?: unknown }>(modelCachePath) : undefined;
    if (!(await exists(join(codexHome, "config.toml"))) || !Array.isArray(modelCache?.models) || !modelCache.models.length) {
      throw new Error("real-session fixture codex state is incomplete; use a fresh dataDir");
    }
    if (!(await exists(join(dataDir, "pi-agent", "models.json")))) {
      throw new Error("real-session fixture pi state is incomplete; use a fresh dataDir");
    }
    return result(dataDir, projectPath, codexHome);
  }

  for (const path of [join(dataDir, "workspace-registry.json"), projectPath, codexHome]) {
    if (await exists(path)) throw new Error("real-session fixture requires a fresh or completed dataDir: " + dataDir);
  }

  const source = resolve(codexConfigSourceInput?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  await copyInitialCodexState(source, codexHome);
  await copyPiAgentState(
    resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")),
    join(dataDir, "pi-agent")
  );
  await createGitProject(projectPath);
  const createdAt = new Date().toISOString();
  await writeFile(markerPath, JSON.stringify({
    version: fixtureVersion,
    projectPath,
    codexHome,
    piAgentDir: join(dataDir, "pi-agent"),
    createdAt
  }, null, 2) + "\n", "utf8");
  await assertGitProject(projectPath);
  return result(dataDir, projectPath, codexHome);
};
