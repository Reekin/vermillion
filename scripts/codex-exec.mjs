import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const requiredFlags = ["--ephemeral", "--output-schema", "--output-last-message", "--sandbox", "--model"];

/** Native Codex CLI: CODEX_EXECUTABLE, otherwise codex.exe from PATH on Windows and codex elsewhere. */
export async function codexExecutable() {
  if (process.env.CODEX_EXECUTABLE) return process.env.CODEX_EXECUTABLE;
  if (process.platform !== "win32") return "codex";
  return (await exec("where.exe", ["codex.exe"])).stdout.trim().split(/\r?\n/)[0];
}

/**
 * One read-only, ephemeral `codex exec` turn in an empty temp directory. The input is sent on stdin and the
 * final message must match `schema`; returns the parsed JSON. Fails when the installed CLI lacks a required flag.
 * @param {{ instructions: string, input: string, schema: object, model: string, reasoningEffort: string, timeoutMs: number }} options
 */
export async function codexExecJson({ instructions, input, schema, model, reasoningEffort, timeoutMs }) {
  const executable = await codexExecutable();
  const { stdout: help } = await exec(executable, ["exec", "--help"]);
  for (const flag of requiredFlags) {
    if (!help.includes(flag)) throw new Error(`Codex CLI does not support ${flag}: ${executable}`);
  }
  const directory = await mkdtemp(join(tmpdir(), "verm-codex-"));
  try {
    const schemaPath = join(directory, "schema.json");
    const outputPath = join(directory, "output.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = ["exec", "--model", model, "--sandbox", "read-only",
      "--ephemeral", "--skip-git-repo-check", "--color", "never",
      "-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`, "-c", 'service_tier="standard"',
      "-c", "project_doc_max_bytes=0", "-c", `developer_instructions=${JSON.stringify(instructions)}`,
      "--output-schema", schemaPath, "--output-last-message", outputPath, "-"];
    await new Promise((resolve, reject) => {
      const child = execFile(executable, args, {
        cwd: directory, timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 16 * 1024 * 1024
      }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`codex exec failed: ${error.message}\n${stderr}`));
        else resolve();
      });
      child.stdin.on("error", reject);
      child.stdin.end(input);
    });
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}
