import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillDescriptorRpc } from "@vermillion/shared";

const maxScanDepth = 3;

const agentDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

export const piSkillDirectories = (
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Array<{ dir: string; scope: "user" | "project" }> => [
  { dir: join(agentDir(env), "skills"), scope: "user" },
  { dir: join(homedir(), ".agents", "skills"), scope: "user" },
  ...(cwd
    ? [
        { dir: join(cwd, ".pi", "skills"), scope: "project" as const },
        { dir: join(cwd, ".agents", "skills"), scope: "project" as const }
      ]
    : [])
];

const frontmatter = (
  content: string
): { name?: string; description?: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) {
    return {};
  }
  const read = (key: string): string | undefined => {
    const line = new RegExp(`^${key}\\s*:\\s*(.+)$`, "mu").exec(match[1] ?? "");
    return line?.[1]?.trim().replace(/^["']|["']$/gu, "");
  };
  return { name: read("name"), description: read("description") };
};

const collectSkillFile = async (
  path: string,
  fallbackName: string
): Promise<SkillDescriptorRpc | undefined> => {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const meta = frontmatter(content);
  const description = meta.description?.trim();
  if (!description) {
    return undefined;
  }
  return {
    cwd: "",
    name: meta.name?.trim() || fallbackName,
    description,
    path,
    scope: "user",
    enabled: true
  };
};

const walk = async (
  dir: string,
  depth: number,
  visit: (path: string, name: string) => Promise<void>
): Promise<void> => {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
  if (skillFile) {
    await visit(join(dir, "SKILL.md"), dir.split(/[\\/]/u).at(-1) ?? "skill");
    return;
  }
  if (depth === 0) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        await visit(join(dir, entry.name), entry.name.replace(/\.md$/iu, ""));
      }
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await walk(join(dir, entry.name), depth - 1, visit);
  }
};

/** 技能是用户级资源，按 pi 的目录约定扫描，界面只关心名称、说明与来源。 */
export const listPiSkills = async (input: {
  cwds?: readonly string[];
}): Promise<SkillDescriptorRpc[]> => {
  const cwds = input.cwds?.filter((cwd) => cwd.trim()) ?? [];
  const skills: SkillDescriptorRpc[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    for (const { dir, scope } of piSkillDirectories(cwd)) {
      const found: SkillDescriptorRpc[] = [];
      await walk(dir, maxScanDepth, async (path, name) => {
        const skill = await collectSkillFile(path, name);
        if (skill) {
          found.push({ ...skill, cwd, scope });
        }
      });
      for (const skill of found) {
        const key = `${skill.cwd}::${skill.name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        skills.push(skill);
      }
    }
  }
  return skills;
};

export const piSkillDirectoryExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
