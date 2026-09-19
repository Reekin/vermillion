#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = () => {
  process.stdout.write("Usage: node scripts/prepare-worktree.mjs --worktree <path>\n");
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

let target = process.cwd();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--") continue;
  if (args[index] === "--worktree") {
    const value = args[index + 1];
    if (!value || value === "--") {
      process.stderr.write("--worktree requires a path\n");
      usage();
      process.exit(2);
    }
    target = value;
    index += 1;
  } else {
    process.stderr.write(`Unknown argument: ${args[index]}\n`);
    usage();
    process.exit(2);
  }
}

target = resolve(target);
for (const file of ["package.json", "pnpm-lock.yaml"]) {
  if (!existsSync(resolve(target, file))) {
    process.stderr.write(`Worktree is missing ${file}: ${target}\n`);
    process.exit(2);
  }
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^npm_(lifecycle|package)_/i.test(key)) delete env[key];
}
delete env.npm_config_recursive;
delete env.PNPM_SCRIPT_SRC_DIR;

const command = process.platform === "win32" && process.env.APPDATA
  ? resolve(process.env.APPDATA, "npm", "pnpm.cmd")
  : "pnpm";
const run = (args) => spawnSync(command, args, {
  cwd: target,
  env,
  stdio: "inherit"
});
const install = run(["install", "--frozen-lockfile"]);
if (install.error) {
  process.stderr.write(`Dependency installation failed: ${install.error.message}\n`);
  process.exit(1);
}
if (install.status !== 0) {
  process.stderr.write(`Dependency installation failed with exit code ${install.status ?? 1}.\n`);
  process.exit(install.status ?? 1);
}
process.stdout.write("Dependencies ready. Building workspace packages required by project checks...\n");
const build = run([
  "--filter", "@vermillion/shared",
  "--filter", "@vermillion/core",
  "--filter", "@vermillion/adapters",
  "--filter", "@vermillion/desktop-server",
  "--filter", "@vermillion/workbench",
  "--workspace-concurrency=1", "build"
]);
if (build.error) {
  process.stderr.write(`Workspace build failed: ${build.error.message}\n`);
  process.exit(1);
}
if (build.status !== 0) {
  process.stderr.write(`Workspace build failed with exit code ${build.status ?? 1}.\n`);
  process.exit(build.status ?? 1);
}
process.stdout.write(`Worktree ready: dependencies installed and workspace packages built in ${target}\n`);
