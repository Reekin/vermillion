import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Produces release/vermillion-<version>-<timestamp>/ : the Electron runtime plus the app directory
// (main + preload bundles, renderer build, bundled CLI). No node_modules are shipped: the main
// process is esbuild-bundled and the renderer is a Vite build. Windows ships Vermillion.exe with
// resources/app; macOS ships Vermillion.app with Contents/Resources/app.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
const workbenchRoot = resolve(repoRoot, "packages/workbench");
const releaseRoot = resolve(repoRoot, "release");

const pad = (value) => String(value).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const version = rootPackage.version ?? "0.0.0";
const darwin = process.platform === "darwin";
const outputDir = process.env.VERMILLION_UNPACK_OUTPUT_DIR
  ? resolve(process.env.VERMILLION_UNPACK_OUTPUT_DIR)
  : resolve(releaseRoot, `vermillion-${version}-${stamp(new Date())}`);
const appBundle = resolve(outputDir, "Vermillion.app");
const appDir = darwin ? resolve(appBundle, "Contents/Resources/app") : resolve(outputDir, "resources/app");

const rel = relative(releaseRoot, outputDir);
if (rel.startsWith("..") || rel === "") throw new Error("Output must live under release/: " + outputDir);
if (existsSync(outputDir)) throw new Error("Refusing to overwrite: " + outputDir);

const require = (path) => { if (!existsSync(path)) throw new Error("Missing build output: " + path + ". Run pnpm build first."); return path; };
const copy = (from, to) => cp(require(from), to, { recursive: true, force: true, dereference: true });

// The electron package exports the runtime executable: dist/electron.exe, or dist/Electron.app/Contents/MacOS/Electron.
const electronExecutable = createRequire(resolve(desktopRoot, "package.json"))("electron");
await mkdir(releaseRoot, { recursive: true });
if (darwin) {
  await mkdir(outputDir, { recursive: true });
  // Framework bundles rely on relative symlinks; dereferencing them breaks the bundle and its signature.
  await cp(resolve(dirname(electronExecutable), "..", ".."), appBundle, { recursive: true, verbatimSymlinks: true });
} else {
  await copy(dirname(electronExecutable), outputDir);
}
await mkdir(appDir, { recursive: true });
await copy(resolve(desktopRoot, "dist-electron"), resolve(appDir, "dist-electron"));
await copy(resolve(desktopRoot, "dist-web"), resolve(appDir, "dist-web"));
await copy(resolve(workbenchRoot, "roles"), resolve(appDir, "roles"));
await copy(resolve(workbenchRoot, "scripts"), resolve(appDir, "scripts"));
await copy(
  resolve(repoRoot, "apps/desktop-server/resources/pi-extension"),
  resolve(appDir, "pi-extension")
);

// Search scans rollout files with ripgrep; the runtime looks for it next to dist-electron/ and cli/.
const ripgrepExecutable = process.platform === "win32" ? "rg.exe" : "rg";
const ripgrepSource = createRequire(resolve(repoRoot, "package.json"))
  .resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${ripgrepExecutable}`);
await mkdir(resolve(appDir, "ripgrep"), { recursive: true });
await copy(ripgrepSource, resolve(appDir, "ripgrep", ripgrepExecutable));

// CLI: bundle to a single file so the package runs it with the system node and no node_modules.
await mkdir(resolve(appDir, "cli"), { recursive: true });
execFileSync(
  process.execPath,
  [resolve(repoRoot, "node_modules/esbuild/bin/esbuild"), resolve(workbenchRoot, "src/cli.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node22", "--outfile=" + resolve(appDir, "cli/vermillion.mjs")],
  { stdio: "inherit" }
);
await writeFile(resolve(appDir, "cli/vermillion.mjs"), (await readFile(resolve(appDir, "cli/vermillion.mjs"), "utf8")) + "\nprocess.exitCode = await runCli(process.argv.slice(2));\n", "utf8");
const cliLauncher = darwin ? "vermillion-cli" : "vermillion-cli.cmd";
if (darwin) {
  await writeFile(resolve(outputDir, cliLauncher),
    "#!/bin/sh\nexec node \"$(dirname \"$0\")/Vermillion.app/Contents/Resources/app/cli/vermillion.mjs\" \"$@\"\n", { encoding: "utf8", mode: 0o755 });
} else {
  await writeFile(resolve(outputDir, cliLauncher), "@echo off\r\nnode \"%~dp0resources\\app\\cli\\vermillion.mjs\" %*\r\n", "utf8");
}

await writeFile(resolve(appDir, "package.json"), JSON.stringify({ name: "vermillion", productName: "Vermillion", version, private: true, type: "module", main: "dist-electron/main.js" }, null, 2) + "\n", "utf8");

if (darwin) {
  execFileSync("plutil", ["-replace", "CFBundleDisplayName", "-string", "Vermillion", resolve(appBundle, "Contents/Info.plist")]);
  await copy(resolve(desktopRoot, "public/icons/icon.icns"), resolve(appBundle, "Contents/Resources/electron.icns"));
  // Editing the bundle invalidates Electron's signature; Apple Silicon only runs signed code, so re-sign ad hoc.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], { stdio: "inherit" });
} else if (process.platform === "win32") {
  const electronExe = resolve(outputDir, "electron.exe");
  const appExe = resolve(outputDir, "Vermillion.exe");
  if (existsSync(electronExe)) { await rm(appExe, { force: true }); await rename(electronExe, appExe); }
}

await writeFile(resolve(outputDir, "README.txt"), [
  "Vermillion " + version,
  "",
  darwin ? "Open Vermillion.app. The build is signed ad hoc; if macOS blocks a copied bundle, run xattr -dr com.apple.quarantine Vermillion.app."
    : "Run Vermillion.exe from this directory.",
  "Requires git and codex on PATH (or VERMILLION_CODEX_BIN). Data lives in ~/.vermillion and <workspace>/.vermillion.",
  "",
  `CLI (needs node >= 22 on PATH): ${cliLauncher} <method> [json-params]`,
  `  ${cliLauncher} --help`,
  ""
].join("\n"), "utf8");

console.log(JSON.stringify({ ok: true, outputDir }, null, 2));
