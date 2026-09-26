import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/semantic/*.eval.ts"],
    hookTimeout: 180_000,
    testTimeout: 10_000,
    maxWorkers: 1
  }
});
