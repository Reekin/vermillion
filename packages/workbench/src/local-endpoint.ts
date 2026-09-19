import { createServer, type Server } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkbenchRpcRequest, WorkbenchRpcResponse } from "./rpc.js";

const ENDPOINT_FILE = "endpoint.json";

export type LocalEndpointIdentity = { pid: number; instanceId?: string };
export type LocalEndpointTarget = { dataDir: string; pid: number; instanceId: string };

/**
 * Loopback HTTP endpoint for the workbench RPC, so the CLI talks to the running desktop instead of
 * writing files the desktop already holds in memory. The endpoint address is published at
 * <baseDir>/endpoint.json while the desktop runs.
 */
export const startLocalEndpoint = async (
  baseDir: string,
  handler: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>,
  identity: Partial<LocalEndpointIdentity> = {}
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (identity.instanceId && req.headers["x-vermillion-instance-id"] !== identity.instanceId) {
      res.writeHead(403).end();
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
  await writeFile(file, JSON.stringify({ port, pid: identity.pid ?? process.pid, ...(identity.instanceId ? { instanceId: identity.instanceId } : {}) }) + "\n", "utf8");
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
  baseDir: string,
  expected?: Pick<LocalEndpointTarget, "pid" | "instanceId">
): Promise<((request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>) | undefined> => {
  const inheritedInstanceId = process.env.VERMILLION_ACCEPTANCE_LAUNCH_TOKEN?.trim();
  const instanceId = expected?.instanceId ?? inheritedInstanceId;
  const strict = expected !== undefined || inheritedInstanceId !== undefined;
  let endpoint: { port: number; pid?: number; instanceId?: string };
  try {
    endpoint = JSON.parse(await readFile(join(baseDir, ENDPOINT_FILE), "utf8")) as typeof endpoint;
  } catch {
    if (strict) throw new Error("Target instance is not running: " + baseDir);
    return undefined;
  }
  if ((expected && endpoint.pid !== expected.pid) || (instanceId && endpoint.instanceId !== instanceId)) {
    throw new Error("Target instance identity does not match the published endpoint: " + baseDir);
  }
  const url = "http://127.0.0.1:" + endpoint.port + "/";
  try {
    const headers = instanceId ? { "x-vermillion-instance-id": instanceId } : undefined;
    const probe = await fetch(url, { method: "POST", headers, body: JSON.stringify({ method: "runtime.info", params: {} }) });
    if (!probe.ok) throw new Error("HTTP " + probe.status);
    const payload = await probe.json() as WorkbenchRpcResponse;
    const pid = payload.ok && typeof payload.result === "object" && payload.result ? (payload.result as { pid?: unknown }).pid : undefined;
    if (expected && pid !== expected.pid) throw new Error("Target runtime identity does not match PID " + expected.pid);
  } catch {
    if (strict) throw new Error("Target instance endpoint is not reachable: " + baseDir);
    return undefined;
  }
  return async (request) => (await (await fetch(url, {
    method: "POST",
    ...(instanceId ? { headers: { "x-vermillion-instance-id": instanceId } } : {}),
    body: JSON.stringify(request)
  })).json()) as WorkbenchRpcResponse;
};
