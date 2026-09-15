import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type PiJsonlProcessOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type PiJsonlProcess = {
  readonly pid: number | undefined;
  readonly running: boolean;
  send(message: Record<string, unknown>): void;
  subscribe(listener: (message: Record<string, unknown>) => void): () => void;
  subscribeExit(listener: (code: number | null) => void): () => void;
  stderrText(): string;
  stop(): Promise<void>;
};

const maxStderrBytes = 8 * 1024;

/**
 * pi RPC 只以 LF 分帧：`\n` 是唯一的记录分隔符，U+2028/U+2029 在 JSON 字符串里合法。
 * 因此按字节解码后手动切分，不用 `readline` 之类会额外换行的通用读取器。
 */
export const spawnPiJsonlProcess = (
  options: PiJsonlProcessOptions
): PiJsonlProcess => {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.command,
    options.args,
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const messageListeners = new Set<(message: Record<string, unknown>) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stderr = "";
  let running = true;

  const emitLine = (line: string): void => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    for (const listener of messageListeners) {
      listener(parsed as Record<string, unknown>);
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      emitLine(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + decoder.write(chunk)).slice(-maxStderrBytes);
  });
  child.on("exit", (code) => {
    running = false;
    const tail = decoder.end();
    if (tail) {
      buffer += tail;
    }
    if (buffer.trim()) {
      emitLine(buffer);
      buffer = "";
    }
    for (const listener of exitListeners) {
      listener(code);
    }
  });

  return {
    get pid() {
      return child.pid;
    },
    get running() {
      return running;
    },
    send(message) {
      if (!running) {
        throw new Error("The pi process is no longer running.");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    subscribe(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    subscribeExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
    stderrText() {
      return stderr.trim();
    },
    async stop() {
      if (!running) {
        return;
      }
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed by an engine-side shutdown.
      }
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))
      ]);
      if (graceful) {
        return;
      }
      child.kill("SIGTERM");
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))
      ]);
      if (!terminated) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  };
};
