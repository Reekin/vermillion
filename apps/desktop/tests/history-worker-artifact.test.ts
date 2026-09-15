import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(desktopRoot, "..", "..");

/**
 * The Codex history worker is bundled next to main.js, so the file the runtime resolves
 * relative to `import.meta.url` must match the build output name.
 */
describe("Codex history projection worker", () => {
  it("keeps the runtime worker path and the build output in agreement", async () => {
    const projectionSource = await readFile(
      join(repoRoot, "apps", "desktop-server", "src", "engines", "codex", "history-projection.ts"),
      "utf8"
    );
    const workerReference = /new URL\("\.\/([^"]+)"/u.exec(projectionSource)?.[1];
    expect(workerReference).toBeDefined();

    const buildScript = await readFile(
      join(desktopRoot, "scripts", "build-electron.mjs"),
      "utf8"
    );
    const workerBlock =
      /const historyWorkerBuildOptions = \{([\s\S]*?)\n\};/u.exec(buildScript)?.[1] ?? "";
    const workerEntry = /"([^"]+\.cjs)"/u.exec(workerBlock)?.[1];
    const workerOutput = /outfile: resolve\(outputDir, "([^"]+\.cjs)"\)/u.exec(workerBlock)?.[1];
    expect(workerEntry).toBeDefined();
    expect(workerOutput).toBe(workerReference);

    const workerSource = resolve(desktopRoot, workerEntry!);
    expect(existsSync(workerSource)).toBe(true);
  });
});
