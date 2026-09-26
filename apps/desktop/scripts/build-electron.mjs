import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build, context } from "esbuild";
import { desktopRoot, electronBuildOptions } from "./electron-build-options.mjs";

const watchMode = process.argv.includes("--watch");
const outputDir = resolve(desktopRoot, "dist-electron");
const { main: mainBuildOptions, preload: preloadBuildOptions, historyWorker: historyWorkerBuildOptions } = electronBuildOptions(outputDir);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
if (watchMode) {
  const mainContext = await context(mainBuildOptions);
  const preloadContext = await context(preloadBuildOptions);
  const historyWorkerContext = await context(historyWorkerBuildOptions);
  await mainContext.watch();
  await preloadContext.watch();
  await historyWorkerContext.watch();
  await mainContext.rebuild();
  await preloadContext.rebuild();
  await historyWorkerContext.rebuild();
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  const shutdown = async () => {
    clearInterval(keepAlive);
    await Promise.all([mainContext.dispose(), preloadContext.dispose(), historyWorkerContext.dispose()]);
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void shutdown();
    });
  }
} else {
  await build(mainBuildOptions);
  await build(preloadBuildOptions);
  await build(historyWorkerBuildOptions);
}
