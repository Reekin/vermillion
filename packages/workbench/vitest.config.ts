import { configDefaults, defineConfig } from "vitest/config";
import { gitTestFiles } from "./tests/git-test-files.mjs";

const isolatedFiles = process.env.VERMILLION_GIT_TEST_FILES?.split(",").filter(Boolean);
export default defineConfig({
  test: {
    include: isolatedFiles ?? ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(isolatedFiles ? [] : ["tests/fixtures/**", ...gitTestFiles])]
  }
});
