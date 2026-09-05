import { homedir } from "node:os";
import { join } from "node:path";
import { createFileWorkspaceSource } from "./file-workspace-source.js";
import { connectLocalEndpoint } from "./local-endpoint.js";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";
import { createWorkbenchRpcHandler } from "./rpc-handler.js";
import { WorkbenchService } from "./workbench-service.js";

/**
 * vermillion <method> [json-params]
 * Same method registry as the desktop app. When the desktop is running, requests go to it over the
 * loopback endpoint (it owns the registry in memory); otherwise the service runs in-process on the files.
 * VERMILLION_PERSISTENCE_BASE_DIR overrides ~/.vermillion.
 */
export const runCli = async (argv: string[]): Promise<number> => {
  const [method, rawParams] = argv;
  if (!method || method === "--help" || method === "-h") {
    process.stdout.write("usage: vermillion <method> [json-params]\n\nmethods:\n" + Object.keys(workbenchRpc).map((m) => "  " + m).join("\n") + "\n");
    return method ? 0 : 1;
  }
  if (!(method in workbenchRpc)) {
    process.stderr.write("unknown method: " + method + "\n");
    return 1;
  }
  const baseDir = process.env.VERMILLION_PERSISTENCE_BASE_DIR?.trim() || join(homedir(), ".vermillion");
  const request = { method: method as WorkbenchRpcMethod, params: rawParams ? JSON.parse(rawParams) : {} };
  const remote = await connectLocalEndpoint(baseDir);
  const service = remote ? undefined : new WorkbenchService({ workspaces: createFileWorkspaceSource(join(baseDir, "workspace-registry.json")) });
  try {
    const handler = remote ?? createWorkbenchRpcHandler(service!);
    const response = await handler(request);
    if (!response.ok) {
      process.stderr.write(response.error + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify(response.result, null, 2) + "\n");
    return 0;
  } finally {
    service?.dispose();
  }
};
