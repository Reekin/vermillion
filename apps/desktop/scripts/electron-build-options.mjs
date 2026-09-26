import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Production and artifact tests share the bundle layout.
 * @param {string} outputDir
 * @returns {Record<'main' | 'preload' | 'historyWorker', import('esbuild').BuildOptions & { outfile: string }>}
 */
export function electronBuildOptions(outputDir) {
  /** @type {import('esbuild').BuildOptions} */
  const shared = {
    bundle: true, sourcemap: true, platform: "node", target: "node20",
    external: ["electron"], logLevel: "info"
  };
  return {
    main: { ...shared, format: "esm",
      // Bundled CommonJS dependencies (ws) call require; ESM output needs one.
      banner: { js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);' },
      entryPoints: [resolve(desktopRoot, "src/electron/main.ts")],
      outfile: resolve(outputDir, "main.js") },
    preload: { ...shared, format: "cjs", entryPoints: [resolve(desktopRoot, "src/electron/preload.cts")],
      outfile: resolve(outputDir, "preload.cjs") },
    historyWorker: { ...shared, format: "cjs",
      entryPoints: [resolve(desktopRoot, "../desktop-server/src/engines/codex/history-projection-worker.cjs")],
      outfile: resolve(outputDir, "history-projection-worker.cjs") }
  };
}
