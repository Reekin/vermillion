import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeStaleRoles, roleTranslationStatus, syncRoles, translationProblems } from "../../../scripts/roles-sync.mjs";
import { RoleService } from "../src/roles.js";

const shippedRoles = fileURLToPath(new URL("../roles", import.meta.url));

it("shipped English roles match the Chinese sources (run pnpm roles:sync when this fails)", async () => {
  expect(describeStaleRoles(await roleTranslationStatus(shippedRoles))).toBeUndefined();
});

describe("roles:sync", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), "verm-roles-sync-"));
    dirs.push(root);
    const rolesDir = join(root, "roles");
    const sourceDir = join(root, "global");
    await mkdir(join(rolesDir, "zh"), { recursive: true });
    await mkdir(sourceDir);
    await writeFile(join(rolesDir, "zh", "worker.md"), "---\nmodel: \"repo-model\"\n---\n# Worker\n\n执行工单，用 `vermillion workItem.get` 读取。\n");
    await writeFile(join(rolesDir, "zh", "reviewer.md"), "# Reviewer\n\n审阅成果。\n");
    const translate = vi.fn(async (requests: { roleId: string; chinese: string }[]) =>
      requests.map(({ roleId, chinese }) => ({ roleId, english: chinese.replace("执行工单", "Execute the work item") })));
    await syncRoles({ rolesDir, sourceDir, translate });
    translate.mockClear();
    return { rolesDir, sourceDir, translate };
  };

  it("syncs changed bodies, keeps repository frontmatter and translates only changed roles in one call", async () => {
    const { rolesDir, sourceDir, translate } = await fixture();
    const reviewerBefore = await readFile(join(rolesDir, "en", "reviewer.md"), "utf8");
    await writeFile(join(sourceDir, "worker.md"), "---\nmodel: \"personal-model\"\n---\n# Worker\n\n执行工单并提交，用 `vermillion workItem.get` 读取。\n");
    await writeFile(join(sourceDir, "reviewer.md"), "---\nmodel: \"personal-model\"\n---\n# Reviewer\n\n审阅成果。\n");

    const result = await syncRoles({ rolesDir, sourceDir, translate });

    expect(result).toMatchObject({ updatedZh: ["worker"], translated: ["worker"] });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0]![0].map((request) => request.roleId)).toEqual(["worker"]);
    expect(await readFile(join(rolesDir, "zh", "worker.md"), "utf8")).toBe("---\nmodel: \"repo-model\"\n---\n# Worker\n\n执行工单并提交，用 `vermillion workItem.get` 读取。\n");
    expect(await readFile(join(rolesDir, "en", "worker.md"), "utf8")).toMatch(/^---\nmodel: "repo-model"\n---\n# Worker\n\nExecute the work item并提交/);
    expect(await readFile(join(rolesDir, "en", "reviewer.md"), "utf8")).toBe(reviewerBefore);
    expect(describeStaleRoles(await roleTranslationStatus(rolesDir))).toBeUndefined();

    await syncRoles({ rolesDir, sourceDir, translate });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("writes neither English roles nor the manifest when translation fails or is incomplete", async () => {
    const { rolesDir, sourceDir } = await fixture();
    const before = await Promise.all(["worker.md", "reviewer.md", "manifest.json"].map((name) => readFile(join(rolesDir, "en", name), "utf8")));
    await writeFile(join(sourceDir, "worker.md"), "# Worker\n\n## 新增小节\n\n执行工单。\n");
    await writeFile(join(sourceDir, "reviewer.md"), "# Reviewer\n\n审阅全部成果。\n");

    await expect(syncRoles({ rolesDir, sourceDir, translate: async () => { throw new Error("codex exec failed"); } })).rejects.toThrow("codex exec failed");
    await expect(syncRoles({ rolesDir, sourceDir, translate: async () => [{ roleId: "reviewer", english: "# Reviewer\n\nReview.\n" }] }))
      .rejects.toThrow(/expected \[reviewer, worker\]/);
    await expect(syncRoles({ rolesDir, sourceDir, translate: async (requests: { roleId: string }[]) => requests.map(({ roleId }) => ({ roleId, english: "# Only a title\n" })) }))
      .rejects.toThrow(/heading count/);

    const after = await Promise.all(["worker.md", "reviewer.md", "manifest.json"].map((name) => readFile(join(rolesDir, "en", name), "utf8")));
    expect(after).toEqual(before);
    expect(describeStaleRoles(await roleTranslationStatus(rolesDir))).toMatch(/reviewer, worker.*pnpm roles:sync/);
  });

  it("reports Chinese edits that were not synced", async () => {
    const { rolesDir } = await fixture();
    await writeFile(join(rolesDir, "zh", "reviewer.md"), "# Reviewer\n\n审阅全部成果。\n");
    expect(describeStaleRoles(await roleTranslationStatus(rolesDir))).toBe(
      "English role prompts in packages/workbench/roles/en are out of date with roles/zh (reviewer). Run pnpm roles:sync.");
  });

  it("rejects translations that rewrite literal code spans", () => {
    expect(translationProblems("用 `vermillion work.start` 开工。", "Start work with `vermillion job.start`.")).toEqual(["literal code spans changed: `vermillion work.start`"]);
  });
});

describe("default role seeding", () => {
  it("copies missing roles in the requested language and keeps existing global files", async () => {
    const root = await mkdtemp(join(tmpdir(), "verm-role-seed-"));
    try {
      const globalDir = join(root, "global");
      const roles = new RoleService({ globalDir, defaultsDir: shippedRoles });
      await mkdir(globalDir);
      await writeFile(join(globalDir, "worker.md"), "# My worker\n");
      await roles.ensureGlobal("en");
      expect(await readFile(join(globalDir, "worker.md"), "utf8")).toBe("# My worker\n");
      const englishReviewer = await readFile(join(shippedRoles, "en", "reviewer.md"), "utf8");
      expect(await readFile(join(globalDir, "reviewer.md"), "utf8")).toBe(englishReviewer);
      await roles.ensureGlobal("zh");
      expect(await readFile(join(globalDir, "reviewer.md"), "utf8")).toBe(englishReviewer);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
