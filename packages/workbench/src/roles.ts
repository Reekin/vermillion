import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zRoleExecutionOverrides, type ResolvedRole, type RoleFile } from "./contracts.js";
import { STATE_DIR } from "./docs.js";

export const ROLES_DIR = STATE_DIR + "/roles";

const roleFile = (dir: string, roleId: string): string => join(dir, roleId + ".md");

const assertRoleId = (roleId: string): void => {
  if (!/^[a-z][a-z0-9-]*$/.test(roleId)) throw new Error("Invalid role id: " + roleId);
};

const listIds = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const titleOf = (content: string): string => content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";

/** The header configures prompt composition and execution; it is never prompt text. */
const parsePrompt = (content: string): { body: string; mode: "override" | "append"; modelConfig?: ResolvedRole["modelConfig"] } => {
  const header = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!header || header.index !== 0) return { body: content, mode: "override" };
  const value = header[1]!.match(/^mode:[ \t]*(.*)$/m)?.[1]?.replace(/[ \t]+#.*$/, "").trim();
  const mode = value?.replace(/^(["'])(.*)\1$/, "$2") ?? "override";
  if (mode !== "override" && mode !== "append") throw new Error("角色 frontmatter 的 mode 必须为 override 或 append。");
  const fields: Record<string, unknown> = {};
  for (const [field, key] of [["model", "modelId"], ["reasoningOptionId", "reasoningOptionId"], ["serviceTierId", "serviceTierId"]]) {
    const raw = header[1]!.match(new RegExp("^" + field + ":[ \\t]*(.*)$", "m"))?.[1]?.trim();
    if (raw === undefined) continue;
    const scalar = raw.match(/^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^#]*)(?:\s+#.*)?$/)?.[1]?.trim() ?? raw;
    fields[key!] = scalar.startsWith('"') ? JSON.parse(scalar)
      : scalar.startsWith("'") ? scalar.slice(1, -1).replace(/''/g, "'")
      : scalar === "null" || scalar === "~" || scalar === "" ? null : scalar;
  }
  const modelConfig = Object.keys(fields).length ? zRoleExecutionOverrides.parse(fields) : undefined;
  return { body: content.slice(header[0].length), mode, ...(modelConfig ? { modelConfig } : {}) };
};

export type RoleServiceOptions = {
  /** ~/.vermillion/roles: the user's editable copy of every role prompt. */
  globalDir: string;
  /** Prompts shipped with the app; missing files are copied into globalDir on ensureGlobal(). Omit when running without the package (CLI). */
  defaultsDir?: string;
};

/**
 * Workspace role bodies replace or append to the global body according to their frontmatter mode.
 * The global layer is seeded from the shipped defaults, so it always holds every role once the app has started.
 */
export class RoleService {
  constructor(private readonly options: RoleServiceOptions) {}

  async ensureGlobal(): Promise<void> {
    const { defaultsDir, globalDir } = this.options;
    if (!defaultsDir) return;
    await mkdir(globalDir, { recursive: true });
    for (const roleId of await listIds(defaultsDir)) {
      const target = roleFile(globalDir, roleId);
      if (!(await exists(target))) await writeFile(target, await readFile(roleFile(defaultsDir, roleId), "utf8"), "utf8");
    }
  }

  async list(workspaceRoot: string): Promise<RoleFile[]> {
    const overrides = new Set(await listIds(join(workspaceRoot, ROLES_DIR)));
    const ids = new Set([...(await listIds(this.options.globalDir)), ...overrides]);
    const out: RoleFile[] = [];
    for (const roleId of [...ids].sort()) {
      const { content, source } = await this.read(workspaceRoot, roleId);
      out.push({ roleId, source, title: titleOf(content) || roleId });
    }
    return out;
  }

  async read(workspaceRoot: string, roleId: string): Promise<{ content: string; source: RoleFile["source"] }> {
    assertRoleId(roleId);
    const override = roleFile(join(workspaceRoot, ROLES_DIR), roleId);
    if (await exists(override)) return { content: await readFile(override, "utf8"), source: "workspace" };
    const global = roleFile(this.options.globalDir, roleId);
    if (await exists(global)) return { content: await readFile(global, "utf8"), source: "global" };
    throw new Error("Unknown role: " + roleId);
  }

  async writeOverride(workspaceRoot: string, roleId: string, content: string): Promise<void> {
    assertRoleId(roleId);
    parsePrompt(content);
    const dir = join(workspaceRoot, ROLES_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(roleFile(dir, roleId), content, "utf8");
  }

  /** Resolve runtime instructions separately from the editable Markdown returned by read(). */
  async resolve(workspaceRoot: string, roleId: string): Promise<ResolvedRole> {
    const raw = await this.read(workspaceRoot, roleId);
    const { body, mode, modelConfig } = parsePrompt(raw.content);
    const config = modelConfig ? { modelConfig } : {};
    if (raw.source === "global" || mode === "override") return { content: body, ...config };
    const globalPath = roleFile(this.options.globalDir, roleId);
    const global = await exists(globalPath) ? parsePrompt(await readFile(globalPath, "utf8")).body : "";
    return { content: [global.trim(), body.trim()].filter(Boolean).join("\n\n"), ...config };
  }

  async removeOverride(workspaceRoot: string, roleId: string): Promise<void> {
    assertRoleId(roleId);
    await rm(roleFile(join(workspaceRoot, ROLES_DIR), roleId), { force: true });
  }
}
