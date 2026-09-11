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

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, ["install", "--frozen-lockfile"], {
  cwd: target,
  env,
  shell: process.platform === "win32",
  stdio: "inherit"
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
