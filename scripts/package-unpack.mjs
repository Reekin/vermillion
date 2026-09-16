import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Produces release/vermillion-<version>-<timestamp>/ : the Electron runtime plus resources/app
// (main + preload bundles, renderer build, bundled CLI). No node_modules are shipped: the main
// process is esbuild-bundled and the renderer is a Vite build.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
const workbenchRoot = resolve(repoRoot, "packages/workbench");
const releaseRoot = resolve(repoRoot, "release");

const pad = (value) => String(value).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const version = rootPackage.version ?? "0.0.0";
const outputDir = process.env.VERMILLION_UNPACK_OUTPUT_DIR
  ? resolve(process.env.VERMILLION_UNPACK_OUTPUT_DIR)
  : resolve(releaseRoot, `vermillion-${version}-${stamp(new Date())}`);
const appDir = resolve(outputDir, "resources/app");

const rel = relative(releaseRoot, outputDir);
if (rel.startsWith("..") || rel === "") throw new Error("Output must live under release/: " + outputDir);
if (existsSync(outputDir)) throw new Error("Refusing to overwrite: " + outputDir);

const require = (path) => { if (!existsSync(path)) throw new Error("Missing build output: " + path + ". Run pnpm build first."); return path; };
const copy = (from, to) => cp(require(from), to, { recursive: true, force: true, dereference: true });

const electronDistDir = dirname(createRequire(resolve(desktopRoot, "package.json"))("electron"));
await mkdir(releaseRoot, { recursive: true });
await copy(electronDistDir, outputDir);
await mkdir(appDir, { recursive: true });
await copy(resolve(desktopRoot, "dist-electron"), resolve(appDir, "dist-electron"));
await copy(resolve(desktopRoot, "dist-web"), resolve(appDir, "dist-web"));
await copy(resolve(workbenchRoot, "roles"), resolve(appDir, "roles"));
await copy(resolve(workbenchRoot, "scripts"), resolve(appDir, "scripts"));
await copy(
  resolve(repoRoot, "apps/desktop-server/resources/pi-extension"),
  resolve(appDir, "pi-extension")
);

// CLI: bundle to a single file so the package runs it with the system node and no node_modules.
await mkdir(resolve(appDir, "cli"), { recursive: true });
execFileSync(
  process.execPath,
  [resolve(repoRoot, "node_modules/esbuild/bin/esbuild"), resolve(workbenchRoot, "src/cli.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node22", "--outfile=" + resolve(appDir, "cli/vermillion.mjs")],
  { stdio: "inherit" }
);
await writeFile(resolve(appDir, "cli/vermillion.mjs"), (await readFile(resolve(appDir, "cli/vermillion.mjs"), "utf8")) + "\nprocess.exitCode = await runCli(process.argv.slice(2));\n", "utf8");
await writeFile(resolve(outputDir, "vermillion-cli.cmd"), "@echo off\r\nnode \"%~dp0resources\\app\\cli\\vermillion.mjs\" %*\r\n", "utf8");

await writeFile(resolve(appDir, "package.json"), JSON.stringify({ name: "vermillion", productName: "Vermillion", version, private: true, type: "module", main: "dist-electron/main.js" }, null, 2) + "\n", "utf8");

if (process.platform === "win32") {
  const electronExe = resolve(outputDir, "electron.exe");
  const appExe = resolve(outputDir, "Vermillion.exe");
  if (existsSync(electronExe)) { await rm(appExe, { force: true }); await rename(electronExe, appExe); }
}

await writeFile(resolve(outputDir, "README.txt"), [
  "Vermillion " + version,
  "",
  "Run Vermillion.exe from this directory.",
  "Requires git and codex on PATH (or VERMILLION_CODEX_BIN). Data lives in ~/.vermillion and <workspace>/.vermillion.",
  "",
  "CLI (needs node >= 22 on PATH): vermillion-cli.cmd <method> [json-params]",
  "  vermillion-cli.cmd --help",
  ""
].join("\n"), "utf8");

console.log(JSON.stringify({ ok: true, outputDir }, null, 2));
