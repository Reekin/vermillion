import { execFileSync } from "node:child_process";

const marker = "__VERMILLION_LOGIN_PATH__";

/**
 * macOS apps opened from Finder or the Dock inherit launchd's minimal PATH, so engines, node and git
 * installed through Homebrew or npm are not found. Appends the entries of the user's login shell PATH
 * that the current PATH lacks; entries the launcher set explicitly keep their precedence.
 */
export const mergeLoginShellPath = (env: NodeJS.ProcessEnv = process.env): void => {
  let output: string;
  try {
    output = execFileSync(env.SHELL?.trim() || "/bin/zsh", ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return;
  }
  const loginPath = output.split(marker)[1];
  if (!loginPath) return;
  const current = (env.PATH ?? "").split(":").filter(Boolean);
  const missing = loginPath.split(":").filter((entry) => entry && !current.includes(entry));
  env.PATH = [...current, ...new Set(missing)].join(":");
};
