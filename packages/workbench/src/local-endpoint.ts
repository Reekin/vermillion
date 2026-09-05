import { createServer, type Server } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkbenchRpcRequest, WorkbenchRpcResponse } from "./rpc.js";

const ENDPOINT_FILE = "endpoint.json";

/**
 * Loopback HTTP endpoint for the workbench RPC, so the CLI talks to the running desktop instead of
 * writing files the desktop already holds in memory. The endpoint address is published at
 * <baseDir>/endpoint.json while the desktop runs.
 */
export const startLocalEndpoint = async (
  baseDir: string,
  handler: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      void (async () => {
        let response: WorkbenchRpcResponse;
        try {
          response = await handler(JSON.parse(body) as WorkbenchRpcRequest);
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const file = join(baseDir, ENDPOINT_FILE);
  await mkdir(baseDir, { recursive: true });
  await writeFile(file, JSON.stringify({ port, pid: process.pid }) + "\n", "utf8");
  return {
    port,
    close: async () => {
      await unlink(file).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
};

/** Returns a request function bound to the running desktop, or undefined when none is reachable. */
export const connectLocalEndpoint = async (
  baseDir: string
): Promise<((request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>) | undefined> => {
  let port: number;
  try {
    port = (JSON.parse(await readFile(join(baseDir, ENDPOINT_FILE), "utf8")) as { port: number }).port;
  } catch {
    return undefined;
  }
  const url = "http://127.0.0.1:" + port + "/";
  try {
    const probe = await fetch(url, { method: "POST", body: JSON.stringify({ method: "workspace.list", params: {} }) });
    if (!probe.ok) return undefined;
  } catch {
    return undefined;
  }
  return async (request) => (await (await fetch(url, { method: "POST", body: JSON.stringify(request) })).json()) as WorkbenchRpcResponse;
};
