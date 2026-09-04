import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@vermillion/shared": fromHere("../../packages/shared/src/index.ts"),
      "@vermillion/core": fromHere("../../packages/core/src/index.ts"),
      "@vermillion/adapters": fromHere("../../packages/adapters/src/index.ts")
    }
  }
});
